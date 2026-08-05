import { Table, Th, Td, NumCell } from '../ui/Table';
import { StatusPill } from '../ui/StatusPill';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { useExtractionJobs, useJobDecision } from '../lib/queries';
import { anyLoading, firstError } from '../ui/QueryGate';

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

  if (anyLoading(jobs)) return <p className="mono">loading…</p>;
  // A failing endpoint previously rendered "Nothing waiting for review" — indistinguishable
  // from a healthy empty queue, on the one screen whose job is catching bad data.
  const loadError = firstError(jobs);
  if (loadError) {
    return (
      <div className="panel" style={{ padding: 'var(--s4)', borderColor: 'var(--stop)', background: 'var(--stop-tint)' }}>
        <h2 style={{ color: 'var(--stop)', marginTop: 0, marginBottom: 'var(--s2)' }}>Could not load the review queue</h2>
        <p className="mono" style={{ margin: 0 }}>{loadError.message}</p>
        <p style={{ marginBottom: 0, color: 'var(--ink-muted)', fontSize: 'var(--text-xs)' }}>
          This is not the same as an empty queue — documents may be waiting.
        </p>
      </div>
    );
  }
  const rows = jobs.data ?? [];

  return (
    <>
      <h1 style={{ marginBottom: 'var(--s4)' }}>Review queue</h1>
      {rows.length === 0 ? (
        <EmptyState title="Nothing waiting for review." action="Uploaded documents appear here when the reading is uncertain." />
      ) : (
        <Table caption="Extractions needing review">
          <thead>
            <tr>
              <Th>Document</Th>
              <Th>Type</Th>
              <Th>Status</Th>
              <Th numeric>Confidence</Th>
              <Th>Extracted</Th>
              <Th>Decision</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((j) => (
              <tr key={j.id}>
                <Td><span className="mono">{j.s3Key.split('/').pop()}</span></Td>
                <Td>{j.docType}</Td>
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
                      Confirm
                    </Button>
                    <Button variant="danger" onClick={() => decide.mutate({ id: j.id, decision: 'reject' })}>
                      Reject
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
