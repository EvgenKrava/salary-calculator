import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(join(dir, '..', p), 'utf8');

/**
 * Control geometry, asserted in the stylesheet.
 *
 * A live audit of the deployed app found three interactive heights coexisting on the same
 * screens — buttons 44px, inputs and selects 38px, the rail's sign-out 32px — so a button never
 * lined up with the field it submitted. These are CSS-only regressions that no rendering test
 * catches (jsdom computes no layout), and the obvious "tidy-up" is to hardcode a pixel value
 * back into one of them.
 */
describe('control geometry', () => {
  it('buttons and inputs derive their height from the same token', () => {
    expect(read('src/ui/button.css')).toMatch(/min-height:\s*var\(--control-h\)/);
    expect(read('src/ui/field.css')).toMatch(/min-height:\s*var\(--control-h\)/);
  });

  it('defines --control-h', () => {
    expect(read('src/styles/tokens.css')).toMatch(/--control-h:\s*\d+px/);
  });

  it('still gives touch devices the full 44px target', () => {
    // Sharing a 40px desktop height must not silently shrink the phone tap target — a manager
    // enters revenue one-handed behind a counter.
    for (const f of ['src/ui/button.css', 'src/ui/field.css']) {
      const css = read(f);
      expect(css, f).toMatch(/@media\s*\(pointer:\s*coarse\)/);
      expect(css, f).toMatch(/min-height:\s*var\(--tap\)/);
    }
  });
});

describe('form labels', () => {
  it('does not uppercase form labels', () => {
    /*
     * All-caps strips the word-shape cues readers rely on, and it is worse in Cyrillic than in
     * Latin. Table headers keep uppercase (one or two words, and they should read as chrome);
     * a form label is content. "ВІДСОТОК ВІД ВИРУЧКИ (0–100)" also wrapped to three lines.
     */
    const rule = /\.field__label\s*\{[^}]*\}/.exec(read('src/ui/field.css'));
    expect(rule, '.field__label rule not found').toBeTruthy();
    expect(rule![0]).not.toContain('uppercase');
  });

  it('lets a long label widen its field without overflowing into the next one', () => {
    /*
     * Two opposite bugs, one line apart. `.field` caps at 12ch for numeric inputs, which wrapped
     * a long label onto three ragged lines; putting `min-width: max-content` on the LABEL fixed
     * that and made the label overflow its own field, printing on top of the neighbouring one in
     * a `field-row`. The constraint belongs on the field, so the field grows with its label.
     */
    const css = read('src/ui/field.css');
    const label = /\.field__label\s*\{[^}]*\}/.exec(css);
    expect(label![0]).not.toMatch(/min-width:\s*max-content/);

    const rowField = /\.field-row\s*>\s*\.field\s*\{[^}]*\}/.exec(css);
    expect(rowField, '.field-row > .field rule not found').toBeTruthy();
    expect(rowField![0]).toMatch(/min-width:\s*max-content/);
  });
});

describe('table captions', () => {
  it('hides the caption visually while keeping it for screen readers', () => {
    /*
     * Every table sits inside a Card whose title says the same thing, or under a page <h1> that
     * does — "Виручка за день" rendered twice, ~40px apart. The <caption> must stay in the DOM
     * (it is how a screen reader announces what the table contains) but must not print.
     */
    const rule = /\.table__caption\s*\{[^}]*\}/.exec(read('src/ui/table.css'));
    expect(rule, '.table__caption rule not found').toBeTruthy();
    expect(rule![0]).toMatch(/clip:\s*rect\(0, 0, 0, 0\)/);
    expect(rule![0]).not.toMatch(/font-size:\s*var\(--text-md\)/);
  });
});
