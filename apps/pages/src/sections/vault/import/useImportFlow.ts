import { STALE_BUILD } from "@opensesame/app-core/lib/chunk-load.js";
import {
  dismissNotice,
  setStatusNotice,
} from "@opensesame/app-core/lib/notices.js";
import { signalRecommendation } from "@opensesame/app-core/lib/recommendations.js";
import type { SourceId } from "@opensesame/app-core/lib/vault/import/index.js";
import type { MergePlan } from "@opensesame/app-core/lib/vault/import/merge.js";
import {
  type ImportStage,
  type StageOutcome,
  confirmManifestStage,
  confirmStage,
  readStage,
  reparseStage,
  restoreStage,
  restoreWithPasskey,
  unlockStage,
} from "@opensesame/app-core/sections/vault/import/model.js";
import {
  type LandingChoice,
  landingDefaults,
  planImport,
} from "@opensesame/app-core/sections/vault/import/preview.js";
import {
  type ManifestPlan,
  planStoreManifest,
} from "@opensesame/app-core/sections/vault/import/store-manifest.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { checkForAppUpdate } from "../../../lib/pwa-update.js";
import { useVault, useVaultStore } from "../../../lib/vault/hooks.js";
import { withWakeLock } from "../../../lib/wake-lock.js";

const NOTICE = "vault-import";

export type ImportFlow = Readonly<{
  stage: ImportStage;
  error: string | null;
  busy: boolean;
  choice: LandingChoice | null;
  plan: MergePlan | null;
  /** The by-path merge a store path manifest would make. */
  manifestPlan: ManifestPlan | null;
  setChoice: (next: LandingChoice) => void;
  reparse: (source: SourceId) => void;
  unlock: (password: string) => void;
  /** `adoptIdentity`: the person chose to take the backup's device identity. */
  restore: (password: string, adoptIdentity: boolean) => void;
  restorePasskey: (adoptIdentity: boolean) => void;
  confirm: () => void;
}>;

/**
 * A failure is a status notice in the tray; a clean outcome clears the last
 * one. A page older than the host's is also asked for the build it lacks, so
 * the reload the message names brings the person to it.
 */
function announce(error: string | null): void {
  if (error === STALE_BUILD) void checkForAppUpdate();
  if (error === null) {
    dismissNotice(NOTICE);
    return;
  }
  setStatusNotice({ id: NOTICE, tone: "err", title: "Import", body: error });
}

function useImportLifetime(file: File) {
  const currentFile = useRef(file);
  const controller = useRef<AbortController | null>(null);
  currentFile.current = file;
  // biome-ignore lint/correctness/useExhaustiveDependencies: replacing the file ends its cancellation scope
  useEffect(() => {
    const owner = new AbortController();
    controller.current = owner;
    return () => {
      owner.abort();
      if (controller.current === owner) controller.current = null;
    };
  }, [file]);
  return {
    signal: () => controller.current?.signal,
    mounted: () => controller.current !== null,
    current: (signal?: AbortSignal) =>
      !signal || (!signal.aborted && currentFile.current === file),
  };
}

function runImportTransition(
  transition: () => Promise<StageOutcome>,
  signal: AbortSignal | undefined,
  isCurrent: () => boolean,
  land: (outcome: StageOutcome) => void,
  setBusy: (busy: boolean) => void,
  canFinish: () => boolean,
): void {
  if (signal?.aborted) return;
  setBusy(true);
  void withWakeLock(transition)
    .then((outcome) => {
      if (isCurrent()) land(outcome);
    })
    .finally(() => {
      if (canFinish()) setBusy(false);
    });
}

function useInitialImportRead(
  file: File,
  current: { current: ImportStage },
  land: (outcome: StageOutcome) => void,
  setStage: (stage: ImportStage) => void,
  setError: (error: string | null) => void,
): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new file is the only thing that starts a new read
  useEffect(() => {
    let live = true;
    const reading: ImportStage = { step: "reading", fileName: file.name };
    current.current = reading;
    setStage(reading);
    setError(null);
    void withWakeLock(() => readStage(file)).then((outcome) => {
      if (live) land(outcome);
    });
    return () => {
      live = false;
    };
  }, [file]);
}

/**
 * The sheet's React binding over the import model: one transition at a
 * time, each outcome landing in one place. A failure is a mark in the sheet
 * and a status notice in the tray — never a box in the page. `onDone` runs
 * once, when a merge or a restore has been written.
 */
export function useImportFlow(file: File, onDone?: () => void): ImportFlow {
  const { items, folders } = useVault();
  const store = useVaultStore();
  const [stage, setStage] = useState<ImportStage>({
    step: "reading",
    fileName: file.name,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [choice, setChoice] = useState<LandingChoice | null>(null);
  const current = useRef(stage);
  const transition = useRef(0);
  const lifetime = useImportLifetime(file);
  current.current = stage;

  const land = (outcome: StageOutcome) => {
    const next = outcome.stage;
    const before = current.current;
    if (
      next.step === "preview" &&
      (before.step !== "preview" || before.result !== next.result)
    ) {
      setChoice(landingDefaults(next.result));
    }
    current.current = next;
    setStage(next);
    setError(outcome.error);
    // Whoever opened the sheet may need to know the items are in the vault.
    if (next.step === "done" && before.step !== "done") {
      onDone?.();
      signalRecommendation("vault.imported");
    }
    announce(outcome.error);
  };

  useInitialImportRead(file, current, land, setStage, setError);

  const plan = useMemo(
    () =>
      stage.step === "preview" && choice
        ? planImport(stage.result, items, folders, choice)
        : null,
    [stage, choice, items, folders],
  );
  const manifestPlan = useMemo(
    () =>
      stage.step === "manifest"
        ? planStoreManifest(stage.entries, items, folders)
        : null,
    [stage, items, folders],
  );

  const run = (action: () => Promise<StageOutcome>, signal?: AbortSignal) => {
    if (signal?.aborted) return;
    const owner = ++transition.current;
    runImportTransition(
      action,
      signal,
      () =>
        lifetime.current(signal) && (!signal || transition.current === owner),
      land,
      setBusy,
      () => !signal || (lifetime.mounted() && transition.current === owner),
    );
  };

  return {
    stage,
    error,
    busy,
    choice,
    plan,
    manifestPlan,
    setChoice,
    reparse: (source) => run(() => reparseStage(current.current, source)),
    unlock: (password) => {
      const signal = lifetime.signal();
      if (!signal) return;
      const locked = current.current;
      run(() => unlockStage(locked, password, signal), signal);
    },
    restore: (password, adoptIdentity) =>
      run(() =>
        restoreStage(current.current, password, store, { adoptIdentity }),
      ),
    restorePasskey: (adoptIdentity) =>
      run(() => restoreWithPasskey(current.current, store, { adoptIdentity })),
    confirm: () => {
      if (plan) run(() => confirmStage(current.current, plan, store));
      if (manifestPlan) {
        run(() => confirmManifestStage(current.current, manifestPlan, store));
      }
    },
  };
}
