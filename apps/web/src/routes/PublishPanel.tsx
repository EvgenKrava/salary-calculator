import { useState } from 'react';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Field } from '../ui/Field';
import { ApiError } from '../lib/api';
import {
  isPublishOverlapBody,
  usePublicationState,
  usePublishMonth,
  usePublishPreview,
  type PublishAssessment,
  type PublishConflict,
} from '../lib/queries';
import { MONTHS, t, formatDate, formatTimestampDate } from '../lib/i18n';

/**
 * Turn a month's drafts into the live schedule.
 *
 * Two kinds of blocker, treated differently on purpose:
 *
 * - A **required day off** blocks until the manager gives a reason. Not a hard prohibition, because
 *   emergency cover on someone's day off is real, and a rule that cannot be overridden gets worked
 *   around outside the app where nothing records it. The reason is kept as an audit trail.
 * - An **overlap** — one person in two shifts at once — cannot be overridden at all. It would pay
 *   the same hours twice, which is not a judgement call.
 */
export function PublishPanel({ year, month }: { year: number; month: number }) {
  const state = usePublicationState({ year, month });
  const preview = usePublishPreview();
  const publish = usePublishMonth();
  const [assessment, setAssessment] = useState<PublishAssessment | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [overlaps, setOverlaps] = useState<PublishConflict[] | null>(null);
  const [published, setPublished] = useState<number | null>(null);

  async function check() {
    setError(null);
    setPublished(null);
    setOverlaps(null);
    try {
      const result = await preview.mutateAsync({ year, month });
      setAssessment(result);
      // Preview reports overlaps rather than refusing, so the manager sees the blocker before
      // pressing publish instead of hitting a 409.
      setOverlaps(result.overlaps && result.overlaps.length > 0 ? result.overlaps : null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function commit() {
    setError(null);
    setOverlaps(null);
    try {
      const result = await publish.mutateAsync({
        year,
        month,
        overrideReason: reason.trim() === '' ? undefined : reason.trim(),
      });
      setPublished(result.published);
      setAssessment(null);
      setReason('');
    } catch (err) {
      /*
       * The overlap 409 carries a structured body so this panel can render Ukrainian copy naming
       * the days. Every other error only has an API-authored English message, shown as-is — the
       * API owns those. Same split as the day-off limit 409 in DayOffPicker.
       */
      const body = err instanceof ApiError ? err.body : undefined;
      if (isPublishOverlapBody(body)) setOverlaps(body.overlaps);
      else setError((err as Error).message);
    }
  }

  const requiredConflicts = assessment?.conflicts.required ?? [];
  const blockedByDayOff = requiredConflicts.length > 0;
  const blockedByOverlap = (overlaps?.length ?? 0) > 0;
  const history = state.data?.overrides ?? [];

  return (
    <Card title={t.publish.title(`${MONTHS[month - 1]} ${year}`)}>
      {state.data?.published && state.data.publishedAt ? (
        <p className="muted">{t.publish.alreadyPublished(formatTimestampDate(state.data.publishedAt))}</p>
      ) : null}

      {/*
        A hard blocker, so it renders whether or not an assessment is on screen — including after a
        refused publish attempt.
      */}
      {blockedByOverlap ? (
        <div className="publish__blocker">
          <p className="publish__blockerTitle">{t.publish.overlapsTitle(overlaps!.length)}</p>
          <p className="publish__blockerHint">{t.publish.overlapsHint}</p>
          <ul className="publish__list mono">
            {overlaps!.map((c) => (
              <li key={`${c.employeeId}-${c.workDate}`}>
                {c.employeeName} · {formatDate(c.workDate)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {assessment ? (
        <>
          <p>
            {assessment.draftCount === 0
              ? t.publish.nothingToPublish
              : t.publish.willPublish(assessment.draftCount)}
          </p>

          {blockedByDayOff ? (
            <div className="publish__blocker">
              <p className="publish__blockerTitle">{t.publish.requiredConflicts(requiredConflicts.length)}</p>
              <ul className="publish__list mono">
                {requiredConflicts.map((c) => (
                  <li key={`${c.employeeId}-${c.workDate}`}>
                    {c.employeeName} · {formatDate(c.workDate)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {assessment.conflicts.preferred.length > 0 ? (
            <p className="publish__warn">
              {t.publish.preferredConflicts(assessment.conflicts.preferred.length)}
            </p>
          ) : null}

          {blockedByDayOff && !blockedByOverlap ? (
            <Field
              label={t.publish.reasonLabel}
              name="overrideReason"
              fieldSize="wide"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              hint={t.publish.reasonRequired}
            />
          ) : null}

          <Button
            variant="primary"
            onClick={() => void commit()}
            disabled={
              publish.isPending ||
              assessment.draftCount === 0 ||
              // An overlap cannot be overridden, so the action is simply unavailable.
              blockedByOverlap ||
              (blockedByDayOff && reason.trim() === '')
            }
          >
            {publish.isPending
              ? t.publish.publishing
              : blockedByDayOff
                ? t.publish.confirmOverride
                : t.publish.button}
          </Button>
        </>
      ) : (
        <Button onClick={() => void check()} disabled={preview.isPending}>
          {t.publish.button}
        </Button>
      )}

      {published !== null ? <p className="publish__ok">{t.publish.publishedNow(published)}</p> : null}
      {error ? <p className="publish__error">{error}</p> : null}

      {/*
        The override audit trail. The whole point of requiring a typed reason is that it is kept and
        readable — recording it and never showing it makes the requirement theatre.
      */}
      {history.length > 0 ? (
        <div className="publish__history">
          <h3 className="publish__historyTitle">{t.publish.historyTitle}</h3>
          <ul className="publish__list">
            {history.map((o) => (
              <li key={`${o.createdAt}-${o.reason}`}>
                <span className="publish__historyMeta mono">
                  {t.publish.historyEntry(formatTimestampDate(o.createdAt), o.createdBy)}
                </span>
                <span className="publish__historyReason">{o.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}
