import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `ImportPanel`'s notification contract.
 *
 * The bug: `onCommitted` was called from a `useEffect` whose dependency array contained the
 * callback itself. Every caller passes an inline arrow, so the identity changed on each render —
 * effect fires, host refetches, host re-renders, new identity, effect fires again. The schedule
 * page died with "Something went wrong!" after every import; reproduced at 51 effect firings for
 * a single mount.
 *
 * The fix is structural: notify from the commit handler, where a discrete event belongs, so
 * there is no dependency array to get wrong. jsdom will not submit a form containing a
 * `required` file input, so the click-through cannot be driven here — these assertions pin the
 * structure that made the loop impossible instead of re-testing React's scheduler.
 */
const raw = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../src/routes/ImportRoute.tsx'),
  'utf8',
);
// Comments are stripped first: the file explains this very bug in prose, and matching the
// explanation would fail the test that the code is correct.
const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

describe('ImportPanel notification', () => {
  it('never calls onCommitted from an effect', () => {
    // The specific shape that looped: onCommitted in a dependency array.
    expect(src).not.toMatch(/useEffect\([^)]*onCommitted/s);
    expect(src).not.toMatch(/\[\s*committed\s*,\s*onCommitted\s*\]/);
  });

  it('calls onCommitted from the commit handler, after the result is stored', () => {
    const commitFn = /async function runCommit\(\)[\s\S]*?\n  \}/.exec(src);
    expect(commitFn, 'runCommit not found').not.toBeNull();
    const body = commitFn![0];
    expect(body).toContain('onCommitted?.()');
    // Order matters: the host refetches, so the result must be committed first.
    expect(body.indexOf('setCommitResult')).toBeLessThan(body.indexOf('onCommitted?.()'));
  });

  it('notifies only on a successful commit', () => {
    const body = /async function runCommit\(\)[\s\S]*?\n  \}/.exec(src)![0];
    // Inside the try, before the catch — a failed commit must not trigger a host refetch.
    const notify = body.indexOf('onCommitted?.()');
    const katch = body.indexOf('} catch');
    expect(notify).toBeGreaterThan(-1);
    expect(notify).toBeLessThan(katch);
  });

  it('does not notify from the preview path, which writes nothing', () => {
    const preview = /async function runPreview\([\s\S]*?\n  \}/.exec(src)![0];
    expect(preview).not.toContain('onCommitted');
  });
});
