import { Table, Th, Td, NumCell } from '../ui/Table';
import { StatusPill } from '../ui/StatusPill';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { useExtractionJobs, useJobDecision } from '../lib/queries';
import { anyLoading, firstError } from '../ui/QueryGate';
import { t } from '../lib/i18n';

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

  if (anyLoading(jobs)) return <p className="mono">{t.common.loading}</p>;
  // A failing endpoint previously rendered "Nothing waiting for review" — indistinguishable
  // from a healthy empty queue, on the one screen whose job is catching bad data.
  const loadError = firstError(jobs);
  if (loadError) {
    return (
      <div className="panel" style={{ padding: 'var(--s4)', borderColor: 'var(--stop)', background: 'var(--stop-tint)' }}>
        <h2 style={{ color: 'var(--stop)', marginTop: 0, marginBottom: 'var(--s2)' }}>{t.review.failedTitle}</h2>
        <p className="mono" style={{ margin: 0 }}>{loadError.message}</p>
        <p style={{ marginBottom: 0, color: 'var(--ink-muted)', fontSize: 'var(--text-xs)' }}>{t.review.failedHint}</p>
      </div>
    );
  }
  const rows = jobs.data ?? [];

  return (
    <>
      <h1 style={{ marginBottom: 'var(--s4)' }}>{t.review.title}</h1>
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
                <Td><span className="mono">{j.s3Key.split('/').pop()}</span></Td>
                <Td>{DOC_TYPE_LABEL[j.docType] ?? j.docType}</Td>
                <Td><StatusPill status={j.status} /></Td>
                <NumCell>{j.confidence === null ? '' : j.confidence.toFixed(2)}</NumCell>
                <Td>
                  <pre
                    className="mono"
                    style={{ margin: 0, maxWidth: 420, overflowX: 'auto', fontSize: 'var(--text-xs)' }}
                  >
                    {JSON.stringify(j.extracted, null, 1)}
                  </pre>
                </Td>
                <Td>
                  <span style={{ display: 'flex', gap: 'var(--s1)' }}>
                    <Button variant="primary" onClick={() => decide.mutate({ id: j.id, decision: 'approve' })}>
                      {t.review.confirm}
                    </Button>
                    <Button variant="danger" onClick={() => decide.mutate({ id: j.id, decision: 'reject' })}>
                      {t.review.reject}
                    </Button>
                  </span>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
