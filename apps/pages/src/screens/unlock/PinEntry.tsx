import { MIN_PIN_LENGTH } from "@opensesame/app-core/lib/vault/unlock-methods.js";
import type { Ref } from "react";

export function PinEntry({
  firstRun,
  duress,
  reveal,
  value,
  problem,
  disabled,
  inputRef,
  onChange,
}: {
  firstRun: boolean;
  duress: boolean;
  reveal: boolean;
  value: string;
  problem: string | null;
  disabled: boolean;
  inputRef: Ref<HTMLInputElement>;
  onChange: (value: string) => void;
}) {
  return (
    <div className="field">
      <label htmlFor="unlock-pin">
        {duress ? "Code" : firstRun ? "Device PIN" : "PIN"}
      </label>
      <input
        id="unlock-pin"
        ref={inputRef}
        type={reveal ? "text" : "password"}
        inputMode="numeric"
        autoComplete={firstRun ? "new-password" : "one-time-code"}
        value={value}
        title={
          firstRun
            ? `${MIN_PIN_LENGTH}–12 characters, no repeated character, no sequential digits`
            : undefined
        }
        aria-invalid={problem ? true : undefined}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
      {problem ? (
        <p className="hint" aria-live="polite">
          {problem}
        </p>
      ) : null}
    </div>
  );
}
