import type { Ref } from "react";

export function ConfirmPin({
  value,
  reveal,
  disabled,
  onChange,
  inputRef,
}: {
  value: string;
  reveal: boolean;
  disabled: boolean;
  onChange: (value: string) => void;
  inputRef?: Ref<HTMLInputElement>;
}) {
  return (
    <div className="field">
      <label htmlFor="confirm">Confirm PIN</label>
      <input
        id="confirm"
        ref={inputRef}
        type={reveal ? "text" : "password"}
        inputMode="numeric"
        autoComplete="new-password"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}
