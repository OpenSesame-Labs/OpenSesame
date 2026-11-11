/**
 * The shell's recommender (ADR 0221): it listens for what a person just did
 * and makes the one recommendation that act brings up, once.
 *
 * The registry and the policy are app-core's (`lib/recommendations.ts`). This
 * is the part that knows the device: which switches are off and could be on,
 * which integration sections are drawn, whether a backup is saved. The
 * recommendation is an ordinary notice — it rings as a toast with one worded
 * key and stays in the tray until it is dismissed — so there is no second
 * surface and nothing new for a screen reader to learn.
 *
 * A "turn on" key is the feature's own switch, pressed from here: the same
 * proposal, the same commit and the same consent receipt as Settings ›
 * Features (ADR 0130). Nothing is fetched or activated before that press.
 *
 * It draws nothing, and guidance switched off silences it.
 */

import {
  type FeatureId,
  featureById,
  featureState,
  isSwitchable,
  switchFeature,
} from "@opensesame/app-core/lib/capabilities/features.js";
import type { IntegrationId } from "@opensesame/app-core/lib/capabilities/integrations.js";
import { capabilityPorts } from "@opensesame/app-core/lib/configuration/capabilities-ports.js";
import {
  loadGuidance,
  rememberRecommendationMade,
} from "@opensesame/app-core/lib/guidance.js";
import {
  type AppendStatusNoticeInput,
  appendStatusNotice,
  dismissNotice,
} from "@opensesame/app-core/lib/notices.js";
import { passwordResetVaultUiSeams } from "@opensesame/app-core/lib/password-reset/vault-ui-seam.js";
import {
  type Recommendation,
  type RecommendationFacts,
  type RecommendationTrigger,
  pickRecommendation,
  subscribeRecommendationSignals,
} from "@opensesame/app-core/lib/recommendations.js";
import { persistenceProvided } from "@opensesame/app-core/lib/vault/password-history.js";
import { useEffect, useRef } from "react";
import { useNavigate } from "react-router";
import { useComposition } from "../bindings/capabilities.js";
import { useIdentityConfigured } from "../lib/use-configured.js";
import { useIntegrationsDrawn } from "../sections/settings/use-integrations-drawn.js";
import {
  commitProposal,
  currentRoots,
} from "../sections/settings/useCapabilityChange.js";

/**
 * What the recommender needs to know about this device, read at the moment a
 * signal arrives. Everything but readiness and the saved backup, which are
 * asked for then.
 */
export type RecommenderDevice = Readonly<{
  featureOn: (id: FeatureId) => boolean;
  featureAvailable: (id: FeatureId) => boolean;
  integrationDrawn: (id: IntegrationId) => boolean;
  /** The plan's approved capabilities, for the readiness check. */
  approved: readonly string[] | undefined;
}>;

/** The device as the composition, the roads and the configuration say it is. */
function useDevice(): RecommenderDevice {
  const { plan } = useComposition();
  const identityApi = useIdentityConfigured();
  const drawn = useIntegrationsDrawn();
  return {
    featureOn: (id) => featureState(featureById(id), plan).on,
    featureAvailable: (id) => {
      const feature = featureById(id);
      return (
        isSwitchable(feature, plan, { identityApi }) &&
        featureState(feature, plan).available.length > 0
      );
    },
    integrationDrawn: (id) =>
      drawn.some(({ integration }) => integration.id === id),
    approved: plan?.approvedCapabilities,
  };
}

/** Switch a feature on in place: its own switch, pressed from a notice. */
async function turnOn(feature: FeatureId): Promise<string | null> {
  const snapshot = capabilityPorts.compositionStore.getSnapshot();
  const proposal = switchFeature(
    {
      roots: currentRoots(snapshot.selection),
      alternatives: snapshot.selection?.chosenAlternatives ?? {},
    },
    featureById(feature),
    true,
    snapshot.plan,
    capabilityPorts.CAPABILITY_CATALOG,
  );
  return commitProposal(snapshot, proposal);
}

export const recommenderSeams = {
  /** After the act's own navigation and toast have settled. */
  delayMs: 700,
  useDevice,
  /** Resolves null when the switch landed, else why it did not. */
  turnOn,
  /**
   * Whether a backup is already set up: the answer the backup sync itself
   * goes by — an enabled backup target, or a history remote that is bound.
   */
  backupSaved: persistenceProvided,
  /** What password reset lacks now: a runtime, a model, or nothing. */
  passwordResetBlocker: async (
    approved: readonly string[] | undefined,
  ): Promise<"runtime" | "model" | null> => {
    const readiness =
      await passwordResetVaultUiSeams.evaluateReadiness(approved);
    if (readiness.ok || readiness.reason === "feature-off") return null;
    return readiness.reason;
  },
};

const noticeId = (id: string) => `recommend.${id}`;

/**
 * Put the recommendation's one tray row, replacing what it said before. It
 * is appended, not set: a recommendation is an arrival, so it rings as a
 * toast, where a standing page condition would only move the badge.
 */
function ring(id: string, notice: Omit<AppendStatusNoticeInput, "id">): void {
  dismissNotice(id);
  appendStatusNotice({ ...notice, id });
}

/**
 * The switch in flight, if any. A switch reads the installation's selection
 * and commits it with one feature added; two pressed close together would
 * both read the same selection, and the second commit would drop the first
 * feature while both confirmations said it was on. So they take turns: each
 * reads the selection only after the one before it has landed.
 */
let switching: Promise<unknown> = Promise.resolve();

/** Why a switch did not land, as a sentence; a throw is a refusal too. */
function refusal(feature: FeatureId): Promise<string | null> {
  const turn = switching.then(async () => {
    try {
      return await recommenderSeams.turnOn(feature);
    } catch {
      return "";
    }
  });
  switching = turn;
  return turn;
}

function make(entry: Recommendation, navigate: (to: string) => void): void {
  const id = noticeId(entry.id);
  const { action } = entry;
  const run = () => {
    if (action.kind === "open") {
      dismissNotice(id);
      navigate(action.to);
      return;
    }
    const title = featureById(action.feature).title;
    const settings = {
      to: action.next ?? `/settings/features#feature-${action.feature}`,
      label: `Open ${title} settings`,
    };
    void refusal(action.feature).then((refused) => {
      if (refused === null) {
        ring(id, {
          tone: "info",
          title: `${title} is on`,
          body: action.next
            ? "One step is left: open its settings to finish connecting it."
            : "It can be switched off again in Settings, under Features.",
          open: settings,
        });
        return;
      }
      ring(id, {
        tone: "warn",
        title,
        body: refused
          ? `It could not be turned on: ${refused}`
          : "It could not be turned on.",
        open: {
          ...settings,
          to: `/settings/features#feature-${action.feature}`,
        },
      });
    });
  };
  ring(id, {
    tone: "info",
    title: entry.title,
    body: entry.body,
    // The act is a closure and is not kept across a reload; the route is. A
    // restored row still leads to where the recommendation is answered.
    open: {
      to:
        action.kind === "open"
          ? action.to
          : `/settings/features#feature-${action.feature}`,
      label: entry.label,
    },
    act: {
      label: entry.label,
      icon: action.kind === "feature" ? "power" : "settings",
      // Going to a settings section leaves the tray: it closes first, so it
      // is not left over the page the key just opened.
      opens: action.kind === "open",
      worded: true,
      run,
    },
  });
}

export function Recommender(): null {
  const navigate = useNavigate();
  const device = recommenderSeams.useDevice();
  // Read at signal time: a signal must see the device as it is then, and the
  // subscription must not be torn down and rebuilt on every plan change.
  const live = useRef({ device, navigate });
  live.current = { device, navigate };

  useEffect(() => {
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let mounted = true;
    const consider = async (trigger: RecommendationTrigger) => {
      if (loadGuidance().mode === "off") return;
      // Readiness is asked only where a recommendation turns on it.
      const passwordResetBlocker =
        trigger === "password.generated" &&
        live.current.device.featureOn("password-reset")
          ? await recommenderSeams.passwordResetBlocker(
              live.current.device.approved,
            )
          : null;
      // The check takes a moment. Everything else is read after it, so a
      // person who switched guidance off meanwhile, or a shell that is
      // gone, is not answered with a recommendation recorded as made.
      if (!mounted) return;
      const guidance = loadGuidance();
      if (guidance.mode === "off") return;
      const now = live.current;
      const facts: RecommendationFacts = {
        featureOn: now.device.featureOn,
        featureAvailable: now.device.featureAvailable,
        integrationDrawn: now.device.integrationDrawn,
        backupSaved: recommenderSeams.backupSaved(),
        passwordResetBlocker,
      };
      const entry = pickRecommendation(
        trigger,
        facts,
        new Set(guidance.recommendations),
      );
      if (entry === null) return;
      rememberRecommendationMade(entry.id);
      make(entry, now.navigate);
    };
    const stop = subscribeRecommendationSignals((trigger) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        // A readiness check that fails leaves nothing to recommend.
        void consider(trigger).then(undefined, () => undefined);
      }, recommenderSeams.delayMs);
      timers.add(timer);
    });
    return () => {
      mounted = false;
      stop();
      for (const timer of timers) clearTimeout(timer);
    };
  }, []);

  return null;
}
