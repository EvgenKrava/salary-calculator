/**
 * Time-of-day entry: masking, normalising and validating `HH:MM` in 24-hour form.
 *
 * **Why the app does not use `<input type="time">`.** That control stores `HH:MM` correctly but
 * *renders* itself in the OS locale, so on a machine set to en-US it shows and accepts `08:00 PM`
 * — a 12-hour clock in an interface that is entirely Ukrainian, where the wire format, the
 * database `TIME` columns and every displayed time are 24-hour. There is no attribute that forces
 * 24-hour display: no `locale`, no `hour12`. So a masked text input is the only way to guarantee
 * what requirement this file exists for — the same reading and the same entry on every machine.
 *
 * These are the three operations that split cleanly:
 *  - `maskTime` runs on every keystroke and keeps the box in a shape that can still become a time.
 *  - `normalizeTime` runs on blur and completes what the user meant (`8` → `08:00`).
 *  - `isTime24` is the gate a submit handler asks before sending.
 *
 * Durations live in `lib/hours.ts` (how long a shift is); DATE strings live in `lib/dates.ts`.
 * This file is only about a time of day.
 */

/** The wire and display format, matching the API's own `timeString` schema and core's `TIME_RE`. */
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** True if `value` is a `HH:MM` 24-hour time the API will accept. */
export function isTime24(value: string): boolean {
  return TIME_RE.test(value);
}

/**
 * True if the raw entry contains a letter — which no 24-hour time ever does.
 *
 * **Why a blanket letter check rather than matching "PM".** The mask drops anything that cannot be
 * part of a time, so `8:00 PM` would otherwise arrive as `8:00` and normalise to `08:00` — twelve
 * hours earlier than the person meant, on a value that decides what someone is paid, with nothing
 * on screen to show it happened. (Silently reading it as `20:00` instead would be the same class of
 * mistake in the other direction: a guess about pay.)
 *
 * Matching the *word* `PM` cannot catch it. A controlled input re-renders through the mask on every
 * keystroke, so typing `P` then `M` never produces a value containing `PM` — the `P` is already
 * gone by the time the `M` arrives. Only a per-character rule sees it, and "letters are not part of
 * a time" is both that rule and the true one. It covers `AM`/`PM`, `a.m.`, and the Ukrainian
 * `дп`/`пп` without enumerating spellings.
 */
export function hasLetters(raw: string): boolean {
  return /\p{L}/u.test(raw);
}

/**
 * Keep a partly-typed time in a shape that can still become one, on every keystroke.
 *
 * Splits on an explicitly typed colon rather than counting digits alone, because both entry habits
 * have to work: `0800` and `8:00` are the same time and a manager types whichever is faster. A
 * digits-only mask turns `8`,`:`,`0`,`0` into `80:0` — it drops the colon that said "those two
 * digits were the hour", then re-inserts one in the wrong place.
 *
 * Deliberately does NOT reject an out-of-range hour mid-typing: `2` is on the way to `23`, and a
 * box that refuses the keystroke gives no reason why. Range is checked on blur, where there is a
 * complete value to name in the error.
 */
export function maskTime(raw: string): string {
  const { hh, mm } = split(raw);
  // No colon until there are minutes to put after it, so a half-typed hour is not decorated with
  // punctuation the user did not reach for.
  return mm === '' ? hh : `${hh}:${mm}`;
}

/**
 * Complete a blurred entry into `HH:MM`, or return it untouched if it cannot be one.
 *
 * Returning the input verbatim on failure is deliberate: the field then shows what the user
 * actually typed with the error beside it, rather than a mangled guess they have to reverse-engineer
 * (`25:00` staying `25:00` is answerable; silently becoming `02:50` is not).
 */
export function normalizeTime(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '') return '';

  const { hh, mm } = split(trimmed);
  // Left-pad both halves. A lone minute digit is read literally (`8:3` → `08:03`) rather than
  // guessed as `08:30`: either reading is a guess, and the padded one is at least what the
  // characters say — and it is visible in the box, so a wrong guess is correctable.
  const candidate = `${hh.padStart(2, '0')}:${(mm === '' ? '00' : mm).padStart(2, '0')}`;
  return isTime24(candidate) ? candidate : trimmed;
}

/**
 * Split a raw entry into its hour and minute digits.
 *
 * Shared by the mask and the normaliser so the two cannot disagree about where the hour ends — they
 * did, and `830` (a perfectly ordinary way to type 08:30) masked to `83:0` and then failed
 * validation on a value the user had typed correctly.
 *
 * With no typed colon, the hour's length is inferred from the FIRST digit: a two-digit hour can only
 * begin 0, 1 or 2, so a leading 3-9 must be a single-digit hour and everything after it is minutes.
 * That is what makes `830` → `8:30` while `1830` → `18:30`.
 */
function split(raw: string): { hh: string; mm: string } {
  const colon = raw.indexOf(':');
  if (colon !== -1) {
    return {
      hh: digits(raw.slice(0, colon)).slice(0, 2),
      mm: digits(raw.slice(colon + 1)).slice(0, 2),
    };
  }
  const d = digits(raw);
  const hourLen = d.length > 0 && Number(d[0]) > 2 ? 1 : 2;
  return { hh: d.slice(0, hourLen), mm: d.slice(hourLen, hourLen + 2) };
}

function digits(s: string): string {
  return s.replace(/\D/g, '');
}
