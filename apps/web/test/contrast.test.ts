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
});
