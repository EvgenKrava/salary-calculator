import { Table, Th, Td, NumCell } from '../ui/Table';
import { Money } from '../ui/Money';
import { EmptyState } from '../ui/EmptyState';
import { Loading } from '../ui/QueryGate';
import { LoadFailure } from '../ui/LoadFailure';
import { Toolbar } from '../ui/Toolbar';
import { Figure } from '../ui/Figure';
import { useMyPay } from '../lib/queries';
import { t, formatDate } from '../lib/i18n';

/** An employee's own pay lines across every salary run they have appeared in. */
export function MyPayRoute() {
  const pay = useMyPay();

  if (pay.isLoading) return <Loading what={t.myPay.title.toLowerCase()} />;
  if (pay.error) return <LoadFailure what={t.myPay.title.toLowerCase()} error={pay.error as Error} />;

  const rows = pay.data ?? [];
  /*
   * The most recent period's pay, not a lifetime sum.
   *
   * An employee opening this screen wants "what am I getting for the period just ended" — a
   * running total of everything ever earned would be a bigger number that answers a question
   * nobody asked. Rows are sorted here rather than trusted from the API so the figure and the
   * first row cannot disagree.
   */
  const latest = [...rows].sort((a, b) => b.periodStart.localeCompare(a.periodStart))[0];

  return (
    <>
      <Toolbar title={t.myPay.title} />
      {rows.length === 0 ? (
        <EmptyState title={t.myPay.empty} action={t.myPay.emptyAction} />
      ) : (
        <>
        <div className="ledger__head">
          <Figure
            value={latest.total.toFixed(2)}
            unit={t.common.currency}
            label={`${t.myPay.latestPeriod} · ${formatDate(latest.periodStart)} — ${formatDate(latest.periodEnd)}`}
          />
        </div>
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
                <Td label={t.runs.periodStart}><span className="mono">{formatDate(r.periodStart)}</span></Td>
                <Td label={t.runs.periodEnd}><span className="mono">{formatDate(r.periodEnd)}</span></Td>
                <NumCell label={t.myPay.hourlyPay}><Money value={r.hourlyPay} /></NumCell>
                <NumCell label={t.myPay.revenueShare}><Money value={r.revenueShare} /></NumCell>
                <NumCell label={t.myPay.bonus}><Money value={r.bonus} /></NumCell>
                <NumCell money label={t.common.total}><Money value={r.total} /></NumCell>
              </tr>
            ))}
          </tbody>
        </Table>
        </>
      )}
    </>
  );
}
