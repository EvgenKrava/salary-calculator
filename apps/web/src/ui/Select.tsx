import type { SelectHTMLAttributes } from 'react';
import { MONTHS } from '../lib/i18n';
import './field.css';

/**
 * Labelled dropdown, matching `Field`'s label treatment so a form reads as one system.
 *
 * Exists because several screens hand-rolled `<div className="field"><label…><select…>`, which
 * drifted: some had no `htmlFor`, so clicking the label did nothing.
 */
export function Select({
  label,
  size,
  children,
  ...props
}: Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> & {
  label: string;
  /** Width by data type — see Field. `month` fits the longest Ukrainian month name. */
  size?: 'num' | 'time' | 'wide' | 'month';
}) {
  const id = props.id ?? props.name;
  return (
    <div className={size ? `field field--${size}` : 'field'}>
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <select {...props} id={id} className="field__input field__select">
        {children}
      </select>
    </div>
  );
}

/**
 * Month picker.
 *
 * Replaces a `type="number"` input, which required the manager to know that 8 means Серпень —
 * a needless translation step on a screen where picking the wrong month produces a payroll run
 * for the wrong period. The value stays a 1-12 string so call sites are unchanged.
 */
export function MonthSelect({
  label,
  value,
  onChange,
  name = 'month',
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  name?: string;
}) {
  return (
    <Select label={label} name={name} size="month" value={value} onChange={(e) => onChange(e.target.value)}>
      {MONTHS.map((m, i) => (
        <option key={m} value={String(i + 1)}>
          {m}
        </option>
      ))}
    </Select>
  );
}
