import type { ReactNode } from 'react';
import { Card } from './Card';
import { t } from '../lib/i18n';
import './loadFailure.css';

/**
 * A screen (or panel) that could not load its data.
 *
 * This markup existed in **seven** places, in six different treatments: an inline
 * `<div className="panel" style={{ borderColor: 'var(--stop)' }}>` on shifts, review, employees
 * and schedule; a bare red `<p>` on revenue, my-shifts and my-pay; `.grid__failure` classes on
 * the schedule grid; and a `Card tone="stop"` on the pay matrix. Same object, so the same
 * rendering everywhere — and a bare red sentence was the wrong one, because it stated the
 * failure without warning the manager not to act on the (absent) figures.
 *
 * Built on `Card tone="stop"` rather than new CSS: a failed read blocks payroll work, which is
 * exactly what `--stop` and that tone are for (docs/design/system.md § Color, § Empty vs
 * blocked).
 *
 * The API's own message is shown verbatim and in mono. It is English, and deliberately not
 * translated — the API authors those strings, they name the actual fault ("closesAt must be
 * after opensAt"), and a Ukrainian paraphrase would be a second place for them to drift.
 */
export function LoadFailure({
  what,
  title,
  error,
  hint,
}: {
  /** What failed to load, in the accusative — "зміни". Ignored when `title` is given. */
  what?: string;
  /** Replaces the generated "Не вдалося завантажити …" heading. */
  title?: string;
  /** Shown verbatim beneath the heading. Omitted when the cause is already in the title. */
  error?: Error | null;
  /** Replaces the default "reload before acting on this" line. */
  hint?: ReactNode;
}) {
  return (
    <Card tone="stop" title={title ?? t.common.couldNotLoad(what ?? '')}>
      {error ? <p className="mono load-failure__detail">{error.message}</p> : null}
      <p className="load-failure__hint">{hint ?? t.common.reload}</p>
    </Card>
  );
}
