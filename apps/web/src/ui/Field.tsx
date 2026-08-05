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
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  error?: string;
  numeric?: boolean;
  hint?: ReactNode;
}) {
  const id = props.id ?? props.name;
  return (
    <div className="field">
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
