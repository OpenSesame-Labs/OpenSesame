import { signalRecommendation } from "@opensesame/app-core/lib/recommendations.js";
import { FIELD_LIMITS } from "@opensesame/app-core/lib/vault/field-limits.js";
import { reportGuideActivation } from "@opensesame/app-core/tutorial/registry/targets.js";
import type { PasswordMethod } from "@opensesame/vault-core";
import { useState } from "react";
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
  useGuideTargetPair,
} from "../../tutorial/registry/react.jsx";
import {
  hasNoGeneratedPassword,
  holdValue,
  regenerate,
  rotate,
  shownPassword,
} from "./account-secrets.js";

const GENERATED = new Set(["rules", "passphrase", "derived"]);
const GENERATION_FAILURE =
  "Could not generate a password. Check the password options and try again.";
const EMPTY_PEPPER_FAILURE =
  "Pepper position leaves no password to copy. Set the pepper position to end or turn off Include pepper, then generate again.";

function attemptGeneration(
  method: PasswordMethod,
): { made: PasswordMethod } | { error: string } {
  const made =
    method.generator.id === "derived" ? rotate(method) : regenerate(method);
  if (made && shownPassword(made)) return { made };
  return {
    error:
      made && hasNoGeneratedPassword(made)
        ? EMPTY_PEPPER_FAILURE
        : GENERATION_FAILURE,
  };
}

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
    message: string;
  } | null>(null);
  const generateRef = useGuideTarget<HTMLButtonElement>(
    "editor.generate-password",
    { activation: "manual" },
  );
  const optionsRef = useGuideTargetPair<HTMLButtonElement>(
    "editor.password-options",
    options.open ? "editor.password-options-open" : undefined,
  );
  const { generator } = method;
  const generationFailed =
    generationFailure?.generator === generator &&
    (generationFailure.message !== EMPTY_PEPPER_FAILURE ||
      hasNoGeneratedPassword(method));
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
          data-guide-pepper-recovery={
            generationFailed &&
            generationFailure.message === EMPTY_PEPPER_FAILURE
              ? "generate"
              : undefined
          }
          onClick={() => {
            const result = attemptGeneration(method);
            if ("error" in result) {
              setGenerationFailure({ generator, message: result.error });
              return;
            }
            onEdit(result.made);
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
        <span className="editor__generation-status">
          <StatusMark tone="err" label={generationFailure.message} />
        </span>
      ) : null}
      <IconKey
        label="Password options"
        keyRef={optionsRef}
        aria-expanded={options.open}
        aria-controls={options.controls}
        onClick={options.onToggle}
      >
        <IconSettings size={17} />
      </IconKey>
      <FailureNotice
        id={`password-generation:${method.id}`}
        title="Password"
        message={generationFailed ? generationFailure.message : null}
        occurrence={generationFailure}
        clearOnUnmount
      />
    </div>
  );
}
