import { Table, Th, Td, NumCell } from '../ui/Table';
import { Money } from '../ui/Money';
import { EmptyState } from '../ui/EmptyState';
import { useMyPay } from '../lib/queries';

/** An employee's own pay lines across every salary run they have appeared in. */
export function MyPayRoute() {
  const pay = useMyPay();

  if (pay.isLoading) return <p className="mono">loading…</p>;
  if (pay.error) return <p style={{ color: 'var(--stop)' }}>{(pay.error as Error).message}</p>;

  const rows = pay.data ?? [];

  return (
    <>
      <h1 style={{ marginBottom: 'var(--s4)' }}>My pay</h1>
      {rows.length === 0 ? (
        <EmptyState title="No pay records yet." action="Pay appears here after a manager runs payroll for a period you worked." />
      ) : (
        <Table caption="My pay">
          <thead>
            <tr>
              <Th>Period start</Th>
              <Th>Period end</Th>
              <Th numeric>Hourly</Th>
              <Th numeric>Revenue share</Th>
              <Th numeric>Bonus</Th>
              <Th numeric>Total</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.runId}>
                <Td><span className="mono">{r.periodStart}</span></Td>
                <Td><span className="mono">{r.periodEnd}</span></Td>
                <NumCell><Money value={r.hourlyPay} /></NumCell>
                <NumCell><Money value={r.revenueShare} /></NumCell>
                <NumCell><Money value={r.bonus} /></NumCell>
                <NumCell money><Money value={r.total} /></NumCell>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
