import { Table, Th, Td, NumCell } from '../ui/Table';
import { Money } from '../ui/Money';
import { EmptyState } from '../ui/EmptyState';
import { useMyPay } from '../lib/queries';
import { t, formatDate } from '../lib/i18n';

/** An employee's own pay lines across every salary run they have appeared in. */
export function MyPayRoute() {
  const pay = useMyPay();

  if (pay.isLoading) return <p className="mono">{t.common.loading}</p>;
  if (pay.error) return <p style={{ color: 'var(--stop)' }}>{(pay.error as Error).message}</p>;

  const rows = pay.data ?? [];

  return (
    <>
      <h1 style={{ marginBottom: 'var(--s4)' }}>{t.myPay.title}</h1>
      {rows.length === 0 ? (
        <EmptyState title={t.myPay.empty} action={t.myPay.emptyAction} />
      ) : (
        <Table caption={t.myPay.title}>
          <thead>
            <tr>
              <Th>{t.runs.periodStart}</Th>
              <Th>{t.runs.periodEnd}</Th>
              <Th numeric>{t.myPay.hourlyPay}</Th>
              <Th numeric>{t.myPay.revenueShare}</Th>
              <Th numeric>{t.myPay.bonus}</Th>
              <Th numeric>{t.common.total}</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.runId}>
                <Td><span className="mono">{formatDate(r.periodStart)}</span></Td>
                <Td><span className="mono">{formatDate(r.periodEnd)}</span></Td>
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
