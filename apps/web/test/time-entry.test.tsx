import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { hasLetters, isTime24, maskTime, normalizeTime } from '../src/lib/time';
import { TimeField } from '../src/ui/TimeField';
import { t } from '../src/lib/i18n';

/**
 * 24-hour time entry.
 *
 * The app replaced `<input type="time">` because that control renders in the OS locale: on an
 * en-US machine it shows and accepts `08:00 PM`, a 12-hour clock in an interface that is entirely
 * Ukrainian and whose wire format, TIME columns and every displayed time are 24-hour. No attribute
 * forces 24-hour display, so the guarantee has to come from a masked text input.
 *
 * These times are payroll inputs — a slot window decides how many hours an imported shift is worth
 * and the location's working day is what a day rate prorates against — so "quietly accepted
 * something that was not the time the user meant" is the failure mode being pinned, not "looked
 * wrong".
 */

describe('maskTime', () => {
  it('inserts the colon once the hour is complete, so 0800 becomes 08:00', () => {
    // The fast path a manager uses daily: four digits, no colon key.
    expect(maskTime('0')).toBe('0');
    expect(maskTime('08')).toBe('08');
    expect(maskTime('080')).toBe('08:0');
    expect(maskTime('0800')).toBe('08:00');
  });

  it('reads a leading 3-9 as a single-digit hour, so 830 is 8:30 and not 83:0', () => {
    /*
     * The bug this pins. A fixed two-digit hour turned `830` — an ordinary way to type half eight —
     * into `83:0`, which then failed validation on a value the user had entered correctly. No
     * two-digit hour begins with 3-9, so the first digit alone says how long the hour is.
     */
    expect(maskTime('8')).toBe('8');
    expect(maskTime('83')).toBe('8:3');
    expect(maskTime('830')).toBe('8:30');
    expect(maskTime('1830')).toBe('18:30');
  });

  it('respects a colon the user typed, rather than re-deriving one by digit count', () => {
    // The bug a digits-only mask has: `8` + `:` + `00` becomes `80:0` — it discards the colon that
    // said "that single digit was the whole hour", then re-inserts one in the wrong place.
    expect(maskTime('8:')).toBe('8');
    expect(maskTime('8:0')).toBe('8:0');
    expect(maskTime('8:00')).toBe('8:00');
    expect(maskTime('08:00')).toBe('08:00');
  });

  it('drops characters that cannot be part of a time', () => {
    expect(maskTime('08:00 PM')).toBe('08:00');
    expect(maskTime('abc')).toBe('');
  });

  it('never grows past HH:MM', () => {
    expect(maskTime('080012')).toBe('08:00');
    expect(maskTime('08:0012')).toBe('08:00');
  });

  it('does not fight an in-progress hour', () => {
    // `2` is on the way to `23`. Rejecting the keystroke here would refuse a legal time with no
    // way for the user to know why; the range check happens on blur, where the value is complete.
    expect(maskTime('2')).toBe('2');
    expect(maskTime('23:30')).toBe('23:30');
  });
});

describe('normalizeTime', () => {
  it('completes a bare hour the way people say it', () => {
    expect(normalizeTime('8')).toBe('08:00');
    expect(normalizeTime('08')).toBe('08:00');
    expect(normalizeTime('20')).toBe('20:00');
    expect(normalizeTime('8:')).toBe('08:00');
  });

  it('pads a single-digit hour typed with its minutes', () => {
    expect(normalizeTime('8:30')).toBe('08:30');
    expect(normalizeTime('830')).toBe('08:30');
  });

  it('reads a lone minute digit literally rather than guessing', () => {
    // `8:3` becomes 08:03, not 08:30. Both are guesses; this one is what the characters say, and
    // it is visible in the box so a wrong guess is correctable before submitting.
    expect(normalizeTime('8:3')).toBe('08:03');
  });

  it('leaves an empty box empty — unfilled is not invalid', () => {
    expect(normalizeTime('')).toBe('');
    expect(normalizeTime('   ')).toBe('');
  });

  it('returns an impossible time UNCHANGED, so the user sees what they typed', () => {
    // Mangling 25:00 into 02:50 would leave the user reverse-engineering what happened. Keeping it
    // verbatim next to the error is answerable.
    expect(normalizeTime('25:00')).toBe('25:00');
    expect(normalizeTime('08:99')).toBe('08:99');
  });

  it('is idempotent on an already-valid time', () => {
    for (const v of ['00:00', '08:00', '13:45', '23:59']) {
      expect(normalizeTime(v)).toBe(v);
    }
  });
});

describe('hasLetters', () => {
  it('flags a 12-hour entry in either language', () => {
    // The value this protects: the mask strips the letters, so `8:00 PM` would arrive as `08:00` —
    // twelve hours off, on a figure someone is paid from, with nothing on screen to show it.
    expect(hasLetters('8:00 PM')).toBe(true);
    expect(hasLetters('8:00 a.m.')).toBe(true);
    expect(hasLetters('8:00 пп')).toBe(true);
  });

  it('flags a single letter, since a keystroke arrives one character at a time', () => {
    // Matching the word "PM" cannot work: a controlled input re-renders through the mask, so the
    // `P` is already stripped by the time the `M` is typed and the two never coexist.
    expect(hasLetters('8:00 P')).toBe(true);
    expect(hasLetters('P')).toBe(true);
  });

  it('passes a plain 24-hour entry and its in-progress forms', () => {
    for (const v of ['', '0', '08', '08:0', '08:00', '23:59']) expect(hasLetters(v)).toBe(false);
  });
});

describe('isTime24', () => {
  it('accepts the full 24-hour range', () => {
    for (const v of ['00:00', '09:15', '13:00', '23:59']) expect(isTime24(v)).toBe(true);
  });

  it('rejects a 12-hour clock, an out-of-range hour, and a short form', () => {
    // The three things the native picker's locale rendering let through or produced.
    expect(isTime24('8:00 PM')).toBe(false);
    expect(isTime24('08:00 PM')).toBe(false);
    expect(isTime24('25:00')).toBe(false);
    expect(isTime24('24:00')).toBe(false);
    expect(isTime24('08:60')).toBe(false);
    expect(isTime24('8:00')).toBe(false); // unpadded — the API's schema refuses it too
    expect(isTime24('')).toBe(false);
  });
});

/** A controlled host, since TimeField pushes normalisation back through `onChange`. */
function Harness({ initial = '', error }: { initial?: string; error?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <TimeField label={t.setup.opensAt} name="opensAt" value={value} onChange={setValue} error={error} />
      {/* Somewhere for focus to go, so blur actually fires. */}
      <button type="button">поза полем</button>
    </>
  );
}

describe('TimeField', () => {
  it('is a text box, not a native time picker whose display follows the OS locale', () => {
    render(<Harness />);
    const input = screen.getByLabelText(t.setup.opensAt);
    expect(input).toHaveAttribute('type', 'text');
    // Mono per the design system: `type="time"` is never mono in Chrome, so columns of times
    // could not align digit-for-digit with the rest of the app's figures.
    expect(input).toHaveClass('mono');
    // The digit keypad on a phone — times get entered behind a counter.
    expect(input).toHaveAttribute('inputMode', 'numeric');
  });

  it('turns four typed digits into HH:MM without the user typing a colon', async () => {
    render(<Harness />);
    const input = screen.getByLabelText(t.setup.opensAt);
    await userEvent.type(input, '0800');
    expect(input).toHaveValue('08:00');
  });

  it('completes a bare hour on blur', async () => {
    render(<Harness />);
    const input = screen.getByLabelText(t.setup.opensAt);
    await userEvent.type(input, '8');
    await userEvent.tab();
    expect(input).toHaveValue('08:00');
  });

  it('rejects an out-of-range hour with the format named below the field', async () => {
    render(<Harness />);
    const input = screen.getByLabelText(t.setup.opensAt);
    await userEvent.type(input, '2500');
    await userEvent.tab();

    expect(await screen.findByText(t.common.timeInvalid)).toBeInTheDocument();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    // The typed value stays put: a field that blanks itself on a mistake hides what the mistake was.
    expect(input).toHaveValue('25:00');
  });

  it('refuses an AM/PM entry rather than silently reading it as the morning', async () => {
    /*
     * The sharpest hazard in this whole change. The mask strips the letters, so without the letter
     * check `8:00 PM` normalises to a perfectly valid-looking `08:00` — twelve hours earlier than
     * the person meant, on a value that decides what someone is paid, with nothing on screen to say
     * so. Reading it as `20:00` instead would be the same class of guess. So it is refused.
     */
    render(<Harness />);
    const input = screen.getByLabelText(t.setup.opensAt);
    await userEvent.type(input, '8:00 PM');
    await userEvent.tab();

    expect(screen.getByText(t.common.timeInvalid)).toBeInTheDocument();
    expect(input).toHaveAttribute('aria-invalid', 'true');
  });

  it('keeps refusing after the letters are stripped, since the digits left are ambiguous', async () => {
    // The error must be sticky: by blur the box holds `08:00`, which on its own looks fine. Only
    // clearing the field resets it.
    render(<Harness />);
    const input = screen.getByLabelText(t.setup.opensAt);
    await userEvent.type(input, '8:00 PM');
    await userEvent.tab();
    expect(screen.getByText(t.common.timeInvalid)).toBeInTheDocument();

    await userEvent.clear(input);
    await userEvent.type(input, '2000');
    await userEvent.tab();
    expect(screen.queryByText(t.common.timeInvalid)).not.toBeInTheDocument();
    expect(input).toHaveValue('20:00');
  });

  it('does not complain about an in-progress value before the user leaves the field', async () => {
    render(<Harness />);
    await userEvent.type(screen.getByLabelText(t.setup.opensAt), '2');
    // Erroring on `2` — a legal prefix of 23:00 — trains the user to ignore the error line.
    expect(screen.queryByText(t.common.timeInvalid)).not.toBeInTheDocument();
  });

  it('treats an empty box as unfilled rather than invalid', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByLabelText(t.setup.opensAt));
    await userEvent.tab();
    expect(screen.queryByText(t.common.timeInvalid)).not.toBeInTheDocument();
  });

  it('clears its own error as soon as editing resumes', async () => {
    render(<Harness />);
    const input = screen.getByLabelText(t.setup.opensAt);
    await userEvent.type(input, '2500');
    await userEvent.tab();
    expect(screen.getByText(t.common.timeInvalid)).toBeInTheDocument();

    await userEvent.clear(input);
    await userEvent.type(input, '0');
    expect(screen.queryByText(t.common.timeInvalid)).not.toBeInTheDocument();
  });

  it("shows the caller's submit error instead of its own, being the more specific one", async () => {
    render(<Harness initial="08:00" error="closesAt must be after opensAt" />);
    expect(screen.getByText('closesAt must be after opensAt')).toBeInTheDocument();
    expect(screen.queryByText(t.common.timeInvalid)).not.toBeInTheDocument();
  });

  it('carries a native pattern backstop matching the API schema', () => {
    // If a submit ever bypasses the blur handler, the browser refuses the form rather than the
    // API rejecting a malformed time in English.
    render(<Harness />);
    expect(screen.getByLabelText(t.setup.opensAt)).toHaveAttribute(
      'pattern',
      '([01][0-9]|2[0-3]):[0-5][0-9]',
    );
  });

  it('reports every keystroke as a value the caller can store', async () => {
    // The masked value is always something that can still BECOME a time, so a parent holding it in
    // state never has to sanitise what it receives.
    const onChange = vi.fn();
    render(<TimeField label={t.setup.opensAt} name="opensAt" value="" onChange={onChange} />);
    await userEvent.type(screen.getByLabelText(t.setup.opensAt), '9');
    expect(onChange).toHaveBeenCalledWith('9');
  });
});
