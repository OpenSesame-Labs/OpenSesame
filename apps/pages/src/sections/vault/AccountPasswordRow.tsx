import { signalRecommendation } from "@opensesame/app-core/lib/recommendations.js";
import { comparePrivatePassword } from "@opensesame/app-core/lib/vault/password-workflows.js";
import {
  type AccountItem,
  type PasswordMethod,
  completePassword,
  handoff,
  isAlgorithmic,
  producePassword,
} from "@opensesame/vault-core";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ConcealedValue,
  CopyButton,
  FieldRow,
  RevealButton,
} from "../../components/FieldRow.js";
import { useGuideTarget } from "../../tutorial/registry/react.jsx";
import { LegacyConvert } from "./LegacyConvert.js";
import { UpdateSecretPanel } from "./SecretUpdate.js";
import { StrengthBar } from "./StrengthBar.js";

type Copying = {
  copied: string | null;
  failed: string | null;
  copy: (
    key: string,
    value: string,
    guideActivation?: string | string[],
    onCopied?: () => void,
  ) => Promise<void>;
};

type PasswordActionsProps = {
  out: ReturnType<typeof handoff>;
  copyRef: (element: HTMLButtonElement | null) => void;
  completeRef: (element: HTMLButtonElement | null) => void;
  copying: Copying;
  fieldKey: string;
  revision: string;
  guide: boolean;
  revealed: boolean;
  onToggle: () => void;
};

function usePasswordCopy({
  out,
  copyRef,
  completeRef,
  copying,
  fieldKey,
  revision,
}: Pick<
  PasswordActionsProps,
  "out" | "copyRef" | "completeRef" | "copying" | "fieldKey" | "revision"
>) {
  const first = out?.now ?? "";
  const rest = out?.later ?? "";
  const split = first !== "" && rest !== "";
  const scope = useMemo(
    () => ({ fieldKey, revision, first, rest, active: true }),
    [fieldKey, revision, first, rest],
  );
  const [copiedFirst, setCopiedFirst] = useState<typeof scope | null>(null);
  const firstDone = copiedFirst === scope;
  useEffect(() => {
    scope.active = true;
    return () => {
      scope.active = false;
    };
  }, [scope]);
  async function copyFirst(
    key: string,
    value: string,
    activation?: string | string[],
  ): Promise<void> {
    await copying.copy(key, value, activation, () => {
      if (scope.active) setCopiedFirst(scope);
    });
  }
  const firstRef = useCallback(
    (element: HTMLButtonElement | null) => {
      copyRef(element);
      if (!split || !firstDone) completeRef(element);
    },
    [copyRef, completeRef, split, firstDone],
  );
  const restRef = useCallback(
    (element: HTMLButtonElement | null) => {
      if (!first) copyRef(element);
      if (!first || (split && firstDone)) completeRef(element);
    },
    [copyRef, completeRef, first, split, firstDone],
  );
  return { first, split, firstDone, firstRef, restRef, copyFirst };
}

function PasswordActions(props: PasswordActionsProps) {
  const { out, copying, fieldKey, guide, revealed, onToggle } = props;
  const { first, split, firstDone, firstRef, restRef, copyFirst } =
    usePasswordCopy(props);
  return (
    <>
      <RevealButton revealed={revealed} label="password" onToggle={onToggle} />
      {out && out.now !== "" ? (
        <CopyButton
          value={out.now}
          label="password"
          fieldKey={fieldKey}
          copied={copying.copied}
          failed={copying.failed}
          guideRef={guide ? firstRef : undefined}
          guideActivation={
            guide
              ? split
                ? "item.copy-password"
                : ["item.copy-password", "item.copy-generated"]
              : undefined
          }
          onCopy={guide && split ? copyFirst : copying.copy}
        />
      ) : null}
      {out && out.later !== "" ? (
        <CopyButton
          value={out.later}
          label="rest of password"
          fieldKey={`${fieldKey}:rest`}
          copied={copying.copied}
          failed={copying.failed}
          guideRef={guide ? restRef : undefined}
          guideActivation={
            guide && !first
              ? ["item.copy-password", "item.copy-generated"]
              : guide && firstDone
                ? "item.copy-generated"
                : undefined
          }
          onCopy={copying.copy}
        />
      ) : null}
    </>
  );
}

/**
 * A password reached the clipboard from this row: the moment autofill
 * would have saved the trip (ADR 0221). A failed copy never sets `copied`.
 */
function usePasswordCopiedSignal(copiedHere: boolean): void {
  useEffect(() => {
    if (copiedHere) signalRecommendation("password.copied");
  }, [copiedHere]);
}

/**
 * One password method on the detail page, produced through the one facade
 * (ADR 0174). Reveal shows the stored password (`completePassword`, or the
 * parts around a pepper slot joined). A copy puts out what comes before the
 * slot, and a second key copies what follows it; the pepper is never asked
 * for, never kept, and never painted into the revealed value. A password an
 * older version made from a typed pepper is converted once, here.
 */
export function AccountPasswordRow({
  item,
  method,
  title,
  copying,
  guide,
  onSave,
}: {
  item: Pick<AccountItem, "id" | "username">;
  method: PasswordMethod;
  title: string;
  copying: Copying;
  /** This row holds the tutorials' `item.copy-password` target. */
  guide: boolean;
  onSave: (method: PasswordMethod) => Promise<void>;
}) {
  const copyRef = useGuideTarget<HTMLButtonElement>("item.copy-password", {
    activation: "manual",
  });
  const completeRef = useGuideTarget<HTMLButtonElement>("item.copy-generated", {
    activation: "manual",
  });
  const [revealed, setRevealed] = useState(false);
  const produced = producePassword(method);
  const key = `password:${item.id}:${method.id}`;
  usePasswordCopiedSignal(copying.copied === key);

  // A computed password is rotated in the editor, never typed over here.
  const update = isAlgorithmic(method) ? null : (
    <UpdateSecretPanel
      itemId={`${item.id}:${method.id}`}
      label="password"
      guideCompare={guide}
      compare={async (candidate) =>
        (await comparePrivatePassword(item.id, candidate, false, method.id))
          .matches
      }
      onUpdate={(next) =>
        onSave({
          ...method,
          secret: next,
          changedAt: new Date().toISOString(),
        })
      }
    />
  );

  if (produced.status === "legacy") {
    return <LegacyConvert account={item} method={method} onConvert={onSave} />;
  }
  if (produced.status === "absent") return update;

  const out = handoff(produced);
  const whole = completePassword(produced);
  // A slotted password has no complete value: the stored password is the
  // parts around the slot, with nothing painted where the pepper goes.
  const shown =
    whole ??
    (produced.status === "slotted" ? `${produced.head}${produced.tail}` : "");
  const empty = produced.status === "slotted" && shown === "";
  return (
    <FieldRow
      label={title}
      actions={
        !empty ? (
          <PasswordActions
            out={out}
            copyRef={copyRef}
            completeRef={completeRef}
            copying={copying}
            fieldKey={key}
            revision={method.changedAt}
            guide={guide}
            revealed={revealed}
            onToggle={() => setRevealed((on) => !on)}
          />
        ) : null
      }
    >
      {empty ? (
        <span className="hint">
          No generated characters to copy. Select Edit to change this password.
        </span>
      ) : (
        <ConcealedValue
          value={revealed ? shown : ""}
          label="password"
          revealed={revealed}
        />
      )}
      {revealed && whole !== null ? <StrengthBar password={whole} /> : null}
      {update}
    </FieldRow>
  );
}
