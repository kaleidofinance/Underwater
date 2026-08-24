"use client";

/** A row of mutually exclusive filters, joined into one control. */
export function Seg<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (value: T) => void;
  options: readonly (readonly [T, string])[];
  /** Names the group for a screen reader; the buttons alone read as a list. */
  label?: string;
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map(([key, text]) => (
        <button
          key={key}
          type="button"
          data-active={value === key}
          aria-pressed={value === key}
          onClick={() => onChange(key)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}
