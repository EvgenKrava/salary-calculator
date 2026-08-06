import type { InputHTMLAttributes, ReactNode } from 'react';
import './field.css';

/**
 * Label is always visible above the input — never a placeholder-as-label, which disappears
 * exactly when a user is checking what they typed.
 */
export function Field({
  label,
  error,
  numeric = false,
  hint,
  fieldSize,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  error?: string;
  numeric?: boolean;
  hint?: ReactNode;
  /**
   * Width class, chosen by DATA TYPE rather than by layout.
   *
   * Without this every input filled its container — a 4-digit year rendered ~1900px wide on a
   * desktop, which reads as broken and severs the label/value relationship. `num` and `time`
   * shrink to their content; `wide` is for names and emails.
   *
   * Named `fieldSize` rather than `size` because this component spreads
   * `InputHTMLAttributes`, where `size` is the native numeric character-width attribute — a
   * string value there is a type error, and silently shadowing a native attribute with a
   * different meaning is worse than a slightly longer prop name. (`Select` keeps `size`: it
   * spreads select attributes, where `size` is the visible-row count and is not used here.)
   */
  fieldSize?: 'num' | 'time' | 'wide';
}) {
  const id = props.id ?? props.name;
  // A numeric field is a numeric width unless told otherwise — the common case shouldn't need
  // both props passed at every call site.
  const width = fieldSize ?? (numeric ? 'num' : undefined);
  return (
    <div className={width ? `field field--${width}` : 'field'}>
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <input
        {...props}
        id={id}
        className={numeric ? 'field__input mono' : 'field__input'}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
      />
      {hint ? <p className="field__hint">{hint}</p> : null}
      {error ? (
        <p className="field__error" id={`${id}-error`}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
