import { Radio, RadioGroup, RadioIndicator } from "@ui-sdk/react/radio";
import { useId } from "react";

export function ConnectorModes<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
  legendHidden = false,
}: {
  label: string;
  value: T;
  options: readonly { id: T; label: string; disabled?: boolean }[];
  onChange: (next: T) => void;
  disabled?: boolean;
  legendHidden?: boolean;
}) {
  const name = useId();
  return (
    <fieldset className="cx-block">
      <legend className={legendHidden ? "visually-hidden" : undefined}>
        {label}
      </legend>
      <RadioGroup
        className="cx-modes"
        aria-label={label}
        name={name}
        value={options.some((option) => option.id === value) ? value : null}
        disabled={disabled}
        onValueChange={(next) => {
          const choice = options.find(
            (option) => option.id === next && !option.disabled,
          );
          if (!disabled && choice) onChange(choice.id);
        }}
      >
        {options.map((option) => (
          <Radio
            className="cx-mode"
            key={option.id}
            value={option.id}
            disabled={option.disabled}
          >
            <span className="cx-mode__mark" aria-hidden="true">
              <RadioIndicator className="cx-mode__indicator" />
            </span>
            <span>{option.label}</span>
          </Radio>
        ))}
      </RadioGroup>
    </fieldset>
  );
}
