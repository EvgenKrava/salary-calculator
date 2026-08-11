import { useState } from 'react';
import { Field } from './Field';
import { hasLetters, isTime24, maskTime, normalizeTime } from '../lib/time';
import { t } from '../lib/i18n';

/**
 * Time-of-day entry: 24-hour, mono, `HH:MM`, on every machine.
 *
 * Replaces `<input type="time">` everywhere in the app. The native control keeps its value in
 * `HH:MM` but *renders* in the OS locale, so on an en-US machine it shows and accepts `08:00 PM` —
 * a 12-hour clock in a Ukrainian interface whose wire format, database columns and every displayed
 * time are 24-hour. No attribute forces 24-hour display, so the native control cannot meet the
 * requirement and a masked text input is what does (see lib/time.ts).
 *
 * What the text input buys beyond locale safety: it is faster for the daily case. A manager types
 * `0800` and gets `08:00` — four keystrokes, no colon, no arrow keys, no spinner, no AM/PM segment
 * to tab past. And it is mono, which `type="time"` never is in Chrome, so a column of times finally
 * aligns digit-for-digit like every other figure in the app (docs/design/system.md § Typography).
 *
 * Two surfaces because there are two contexts, sharing `useTimeEntry` so the behaviour cannot
 * drift between them: `TimeField` is the labelled form field, `TimeInput` the bare input for a
 * dense table cell where the column header is already the label.
 */

/**
 * The input props that make a text box behave as a 24-hour time box.
 *
 * **Validation is on blur, not on keystroke.** `2` is on its way to `23`; complaining about it
 * mid-word trains the user to ignore the error line. On blur the value is completed (`8` → `08:00`)
 * and only then judged, so the message can name the actual fault.
 */
export function useTimeEntry(value: string, onChange: (value: string) => void) {
  /** Set on blur when the completed value is still not a time. Cleared as soon as editing resumes. */
  const [invalid, setInvalid] = useState(false);
  /**
   * Set when the user typed or pasted a letter — an AM/PM time, in practice.
   *
   * Tracked separately from the value because the mask strips letters, so by blur the box holds
   * `8:00` and nothing remains to tell `20:00` from `08:00`. Guessing either way would move a pay
   * figure by twelve hours silently — see `hasLetters`.
   */
  const [lettered, setLettered] = useState(false);

  return {
    invalid: invalid || lettered,
    props: {
      /*
       * `text`, not `time`: see above. `inputMode="numeric"` brings up the digit keypad on a phone —
       * times get entered behind a counter — and `autoComplete="off"` keeps the browser from
       * offering unrelated saved values over a five-character box.
       */
      type: 'text',
      inputMode: 'numeric' as const,
      autoComplete: 'off',
      /*
       * `pattern` and `maxLength` are the native backstop, so a form that somehow submits without
       * passing through the blur handler is still refused by the browser rather than sending a
       * malformed time the API would 400. Same shape as the API's own `timeString` schema.
       */
      pattern: '([01][0-9]|2[0-3]):[0-5][0-9]',
      maxLength: 5,
      placeholder: '00:00',
      value,
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
        setInvalid(false);
        // Judged on the RAW keystroke, before the mask strips the letters that carry the meaning.
        // Sticky until the box is emptied: the surviving digits are ambiguous, so any later blur
        // would happily accept them.
        if (hasLetters(e.target.value)) setLettered(true);
        else if (e.target.value.trim() === '') setLettered(false);
        onChange(maskTime(e.target.value));
      },
      onBlur: (e: React.FocusEvent<HTMLInputElement>) => {
        const normalized = normalizeTime(e.target.value);
        if (normalized !== e.target.value) onChange(normalized);
        // An empty box is not "invalid" — it is unfilled, which `required` and the submit handler
        // are what speak to. Only a non-empty value that cannot be a time earns the error.
        setInvalid(normalized !== '' && !isTime24(normalized));
      },
    },
  };
}

/** The labelled form field — locations, shift slots, a custom shift window. */
export function TimeField({
  label,
  name,
  value,
  onChange,
  error,
  required,
  disabled,
}: {
  label: string;
  name: string;
  value: string;
  /** Receives the masked value — always something that can still become a `HH:MM` time. */
  onChange: (value: string) => void;
  /** A submit-level error from the caller (e.g. the API's "closesAt must be after opensAt"). */
  error?: string;
  required?: boolean;
  disabled?: boolean;
}) {
  const { invalid, props } = useTimeEntry(value, onChange);
  return (
    <Field
      {...props}
      label={label}
      name={name}
      numeric
      fieldSize="time"
      required={required}
      disabled={disabled}
      /* The caller's error wins: it describes the submission ("closes must be after opens"), which
         is more specific than this field's own "that is not a time". */
      error={error ?? (invalid ? t.common.timeInvalid : undefined)}
    />
  );
}

/**
 * The bare input, for a time being edited inside a table row.
 *
 * No `Field` wrapper: the column header is the label, and a stacked label inside a 40px row would
 * double its height. The error is NOT rendered here for the same reason — the row owns one error
 * slot under its actions, and the caller validates before saving.
 */
export function TimeInput({
  value,
  onChange,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
}) {
  const { invalid, props } = useTimeEntry(value, onChange);
  return (
    <input
      {...props}
      className="field__input mono"
      aria-label={ariaLabel}
      aria-invalid={invalid ? true : undefined}
    />
  );
}
