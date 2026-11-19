import { signalRecommendation } from "@opensesame/app-core/lib/recommendations.js";
import { FIELD_LIMITS } from "@opensesame/app-core/lib/vault/field-limits.js";
import { reportGuideActivation } from "@opensesame/app-core/tutorial/registry/targets.js";
import type { PasswordMethod } from "@opensesame/vault-core";
import { useCallback, useState } from "react";
import { FailureNotice } from "../../components/FailureNotice.js";
import { IconKey } from "../../components/IconKey.js";
import {
  IconEye,
  IconEyeOff,
  IconRefresh,
  IconSettings,
} from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import {
  useGuideTarget,
  useOptionalGuideTarget,
} from "../../tutorial/registry/react.jsx";
import {
  holdValue,
  regenerate,
  rotate,
  shownPassword,
} from "./account-secrets.js";

const GENERATED = new Set(["rules", "passphrase", "derived"]);
const GENERATION_FAILURE =
  "Could not generate a password. Check the password options and try again.";

/**
 * The password itself: typed, generated or computed, with its reveal,
 * regenerate and options keys inside its rule. An algorithmic password is computed from its root, and its
 * key rotates it. What is shown is what the product produces before the
 * person's own pepper, if the method includes one (ADR 0174). Typing over a
 * generated one is choosing to type it, so it becomes typed.
 */
export function PasswordControl({
  method,
  onEdit,
  options,
}: {
  method: PasswordMethod;
  onEdit: (next: PasswordMethod) => void;
  /** The key that opens the generator's options, and whether they are open. */
  options: { open: boolean; controls: string; onToggle: () => void };
}) {
  const [reveal, setReveal] = useState(false);
  const [generationFailure, setGenerationFailure] = useState<{
    generator: PasswordMethod["generator"];
  } | null>(null);
  const generateRef = useGuideTarget<HTMLButtonElement>(
    "editor.generate-password",
    { activation: "manual" },
  );
  const optionsRef = useGuideTarget<HTMLButtonElement>(
    "editor.password-options",
  );
  // The state marker must survive closing the options panel.
  const enabledRef = useOptionalGuideTarget<HTMLButtonElement>(
    method.pepper ? "editor.pepper-enabled" : undefined,
  );
  const bindOptions = useCallback(
    (element: HTMLButtonElement | null) => {
      optionsRef(element);
      enabledRef(element);
    },
    [optionsRef, enabledRef],
  );
  const { generator } = method;
  const generationFailed = generationFailure?.generator === generator;
  return (
    <div className="editor__inline editor__inline--adorned">
      <input
        id={`${method.id}-password`}
        type={reveal ? "text" : "password"}
        autoComplete="new-password"
        spellCheck={false}
        maxLength={FIELD_LIMITS.secret}
        value={shownPassword(method)}
        onChange={(event) => onEdit(holdValue(method, event.target.value))}
      />
      <IconKey
        label={reveal ? "Hide password" : "Show password"}
        aria-pressed={reveal}
        onClick={() => setReveal((on) => !on)}
      >
        {reveal ? <IconEyeOff size={17} /> : <IconEye size={17} />}
      </IconKey>
      {GENERATED.has(generator.id) ? (
        <IconKey
          label="Generate another password"
          keyRef={generateRef}
          onClick={() => {
            const made =
              generator.id === "derived" ? rotate(method) : regenerate(method);
            if (!made || !shownPassword(made)) {
              setGenerationFailure({ generator });
              return;
            }
            onEdit(made);
            setReveal(true);
            setGenerationFailure(null);
            signalRecommendation("password.generated");
            reportGuideActivation("editor.generate-password");
          }}
        >
          <IconRefresh size={17} />
        </IconKey>
      ) : null}
      {generationFailed ? (
        <StatusMark tone="err" label={GENERATION_FAILURE} />
      ) : null}
      <IconKey
        label="Password options"
        keyRef={bindOptions}
        aria-expanded={options.open}
        aria-controls={options.controls}
        onClick={options.onToggle}
      >
        <IconSettings size={17} />
      </IconKey>
      <FailureNotice
        id={`password-generation:${method.id}`}
        title="Password"
        message={generationFailed ? GENERATION_FAILURE : null}
        occurrence={generationFailure}
        clearOnUnmount
      />
    </div>
  );
}
