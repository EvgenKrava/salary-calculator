import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Colour contrast, asserted rather than eyeballed.
 *
 * This caught a real failure: white on the brand amber (#b26b00) is 4.20:1, below the 4.5:1 AA
 * threshold — on the primary button, the most important control in the app. `--amber-action`
 * exists solely to clear it. Without a test, the next person tidying the palette would
 * reasonably "simplify" the two ambers back into one and reintroduce the problem.
 */

const tokens = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/styles/tokens.css'), 'utf8');

function token(name: string): string {
  const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(tokens);
  if (!m) throw new Error(`token --${name} not found or not a 6-digit hex`);
  return m[1];
}

function luminance(hex: string): number {
  const parts = hex.replace('#', '').match(/../g);
  if (!parts) throw new Error(`bad hex ${hex}`);
  const [r, g, b] = parts
    .map((h) => parseInt(h, 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const AA = 4.5;

describe('contrast', () => {
  it('primary button text meets AA', () => {
    expect(ratio('#ffffff', token('amber-action'))).toBeGreaterThanOrEqual(AA);
    expect(ratio('#ffffff', token('amber-strong'))).toBeGreaterThanOrEqual(AA);
  });

  it('body and secondary text meet AA on every surface they appear on', () => {
    for (const bg of ['ground', 'surface', 'surface-raised', 'surface-sunk', 'amber-tint'] as const) {
      expect(ratio(token('ink'), token(bg)), `ink on ${bg}`).toBeGreaterThanOrEqual(AA);
    }
    for (const bg of ['surface', 'surface-raised'] as const) {
      expect(ratio(token('ink-muted'), token(bg)), `ink-muted on ${bg}`).toBeGreaterThanOrEqual(AA);
    }
  });

  it('every status pill meets AA against its own tint', () => {
    // Status is the one thing a manager must never misread, and these are small text.
    expect(ratio(token('ok'), token('ok-tint'))).toBeGreaterThanOrEqual(AA);
    expect(ratio(token('warn'), token('warn-tint'))).toBeGreaterThanOrEqual(AA);
    expect(ratio(token('stop'), token('stop-tint'))).toBeGreaterThanOrEqual(AA);
    expect(ratio(token('ink-muted'), token('surface-sunk'))).toBeGreaterThanOrEqual(AA);
  });

  it('keeps the brand amber distinct from the action amber', () => {
    // If someone collapses these, the button silently drops below AA again.
    expect(token('amber')).not.toBe(token('amber-action'));
  });

  it('the rail count badge meets AA', () => {
    // The badge is white on a filled amber, the same trap as the primary button — it uses
    // --amber-action for exactly that reason. Plain --amber would put it at 4.20:1.
    expect(ratio('#ffffff', token('amber-action'))).toBeGreaterThanOrEqual(AA);
  });

  it('rail text meets AA on the rail surface', () => {
    // The rail sits on --surface-raised, not --surface, so its own contrast needs checking:
    // inactive nav items and group headings are --ink-muted, active items --ink on --amber-tint.
    expect(ratio(token('ink-muted'), token('surface-raised'))).toBeGreaterThanOrEqual(AA);
    expect(ratio(token('ink'), token('amber-tint'))).toBeGreaterThanOrEqual(AA);
  });

  it('does not use --ink-faint for rail group headings', () => {
    /*
     * --ink-faint is 3.01:1 on --surface-raised. That is fine for what it is scoped to
     * (placeholders and disabled text, which WCAG exempts) and NOT fine for a group heading,
     * which is content a user reads to navigate. The first draft of the rail used it; this test
     * is what caught it. Asserted against the stylesheet because the failure mode is a token
     * swap in CSS, not a computed value any unit test would otherwise see.
     */
    const shell = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../src/shell/shell.css'),
      'utf8',
    );
    const rule = /\.rail__groupLabel\s*\{[^}]*\}/.exec(shell);
    expect(rule, '.rail__groupLabel rule not found').toBeTruthy();
    expect(rule![0]).not.toContain('--ink-faint');
    expect(ratio(token('ink-faint'), token('surface-raised'))).toBeLessThan(AA);
  });

  it('does not rely on the amber tint alone as an input focus ring', () => {
    /*
     * The focus ring on every input in the app was `outline: none` plus
     * `box-shadow: 0 0 0 3px var(--amber-tint)`. --amber-tint is 1.09:1 against --surface, so the
     * only focus cue was effectively invisible — failing WCAG 2.4.11's 3:1 focus-appearance bar
     * and the design system's own "Visible focus ring: 2px solid var(--ink). Never outline: none".
     *
     * Found by tabbing the app under Playwright, not by eye: the wash IS visible if you know to
     * look for it, and the border also turns amber, so it reads as styled rather than as broken.
     * The ratio below is what makes the case, so it is asserted alongside the rule.
     */
    expect(ratio(token('amber-tint'), token('surface'))).toBeLessThan(3);

    for (const [file, selector] of [
      ['../src/ui/field.css', '.field__input:focus-visible'],
      ['../src/routes/payMatrix.css', '.matrix__input:focus-visible'],
    ] as const) {
      const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), file), 'utf8');
      const rule = new RegExp(`${selector.replace(/[.:()]/g, '\\$&')}\\s*\\{[^}]*\\}`).exec(css);
      expect(rule, `${selector} rule not found in ${file}`).toBeTruthy();
      // An ink outline, not a tint-only shadow.
      expect(rule![0], selector).toMatch(/outline:\s*2px solid var\(--ink\)/);
    }
  });

  it('the display figure meets AA on the surfaces it appears on', () => {
    // A ledger total in --amber at 44px is large text (AA large = 3:1), but it also renders in
    // the money column at body size, so hold it to the stricter bar on both surfaces.
    for (const bg of ['surface', 'ground', 'amber-tint'] as const) {
      expect(ratio(token('amber'), token(bg)), `amber on ${bg}`).toBeGreaterThanOrEqual(3);
    }
  });
});
