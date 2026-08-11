import { Table, Th, Td, NumCell } from '../ui/Table';
import { StatusPill } from '../ui/StatusPill';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { useExtractionJobs, useJobDecision } from '../lib/queries';
import { anyLoading, firstError, Loading } from '../ui/QueryGate';
import { LoadFailure } from '../ui/LoadFailure';
import { Toolbar } from '../ui/Toolbar';
import { t } from '../lib/i18n';
import './review.css';

const DOC_TYPE_LABEL: Record<string, string> = {
  revenue: t.review.typeRevenue,
  schedule: t.review.typeSchedule,
};

/**
 * The human half of the human-in-the-loop. The extracted payload is shown verbatim so a
 * manager checks what the model actually read — never a prettified summary that could hide
 * a misread digit.
 *
 * Confirming or rejecting here only updates the extraction_jobs row; it does not yet create
 * the corresponding daily_revenue/shifts rows — that commit step is a follow-up (see the
 * extraction plan), so this screen's copy should not imply the reading is already payroll
 * data.
 */
export function ReviewRoute() {
  const jobs = useExtractionJobs('needs_review');
  const decide = useJobDecision();

  if (anyLoading(jobs)) return <Loading what={t.review.title.toLowerCase()} />;
  // A failing endpoint previously rendered the empty-state copy — indistinguishable
  // from a healthy empty queue, on the one screen whose job is catching bad data.
  const loadError = firstError(jobs);
  if (loadError) {
    return <LoadFailure title={t.review.failedTitle} error={loadError} hint={t.review.failedHint} />;
  }
  const rows = jobs.data ?? [];

  return (
    <>
      {/* A Worklist states what needs the manager before showing the rows. */}
      <Toolbar
        title={t.review.title}
        description={rows.length > 0 ? t.review.awaitingReview(rows.length) : undefined}
      />
      {rows.length === 0 ? (
        <EmptyState title={t.review.empty} action={t.review.emptyAction} />
      ) : (
        <Table caption={t.review.caption}>
          <thead>
            <tr>
              <Th>{t.review.document}</Th>
              <Th>{t.review.type}</Th>
              <Th>{t.common.status}</Th>
              <Th numeric>{t.review.confidence}</Th>
              <Th>{t.review.extracted}</Th>
              <Th>{t.review.decision}</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((j) => (
              <tr key={j.id}>
                <Td label={t.review.document}><span className="mono">{j.s3Key.split('/').pop()}</span></Td>
                <Td label={t.review.type}>{DOC_TYPE_LABEL[j.docType] ?? j.docType}</Td>
                <Td label={t.common.status}><StatusPill status={j.status} /></Td>
                {/*
                 * Blank, not '0.00', when the model reported no confidence: per ui/Money's rule,
                 * blank means UNKNOWN and zero means zero, and those are different facts. A
                 * confidence of 0 would mean the model was certain it had read nothing.
                 */}
                <NumCell label={t.review.confidence}>
                  {j.confidence === null ? '' : j.confidence.toFixed(2)}
                </NumCell>
                <Td label={t.review.extracted}>
                  {/*
                   * The raw payload, scrollable in its own box rather than inline in the cell.
                   *
                   * It has to stay verbatim — a prettified summary could hide the misread digit
                   * this screen exists to catch — but an unbounded <pre> in a table cell became a
                   * horizontal scroll tunnel inside a stacked row at 390px. The class caps its
                   * height and wraps long lines instead.
                   */}
                  <pre className="review__payload mono">{JSON.stringify(j.extracted, null, 1)}</pre>
                </Td>
                <Td label={t.review.decision}>
                  <span className="row-actions">
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() => decide.mutate({ id: j.id, decision: 'approve' })}
                      aria-label={t.review.confirmFor(j.s3Key.split('/').pop() ?? '')}
                    >
                      {t.review.confirm}
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => decide.mutate({ id: j.id, decision: 'reject' })}
                      aria-label={t.review.rejectFor(j.s3Key.split('/').pop() ?? '')}
                    >
                      {t.review.reject}
                    </Button>
                  </span>
                  {/*
                   * A failed decision was rendered NOWHERE: the mutation error was never read, so
                   * confirming a job that 409'd left the row sitting there looking untouched — on
                   * the screen whose whole purpose is stopping bad data becoming payroll.
                   */}
                  {decide.error && decide.variables?.id === j.id ? (
                    <p className="setup__rowError" role="status">{(decide.error as Error).message}</p>
                  ) : null}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
