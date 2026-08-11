import { Link } from '@tanstack/react-router';
import { Toolbar } from '../ui/Toolbar';
import { Card } from '../ui/Card';
import { Figure } from '../ui/Figure';
import { Table, Th, Td, NumCell } from '../ui/Table';
import { Money } from '../ui/Money';
import {
  useExtractionJobs,
  useShifts,
  useRevenue,
  useLocations,
  type RevenueRow,
} from '../lib/queries';
import { isoDaysAgo, isoRange, todayIso } from '../lib/dates';
import { t, formatDate } from '../lib/i18n';
import './today.css';

/**
 * The home screen: a worklist, not a dashboard.
 *
 * It replaced `<p>Choose a section from the navigation.</p>` — the front door of a payroll tool
 * asking the manager to work out where to go. Per docs/design/system.md § Structure, every
 * screen answers *"what needs me?"* before *"here is data"*, and this is the screen whose whole
 * job is that question.
 *
 * Two rules it holds to:
 * - **Every attention item links to the thing itself.** A badge saying "3" that the manager then
 *   has to go hunting for is worse than no badge at all.
 * - **A clean worklist is a first-class state.** When nothing needs attention it says so
 *   explicitly, rather than rendering an empty table that reads like a failed load.
 */
export function TodayRoute() {
  const jobs = useExtractionJobs('needs_review');
  const pending = useShifts({ status: 'requested' });

  // Last 7 days inclusive of today, so "виручка за 7 днів" matches what the rows below show.
  const from = isoDaysAgo(6);
  const to = todayIso();
  const revenue = useRevenue({ from, to });
  const locations = useLocations();

  const rows = revenue.data ?? [];
  const weekTotal = rows.reduce((sum, r) => sum + r.amount, 0);

  /*
   * Days in the window with no revenue recorded at all.
   *
   * This is the item a manager most often does not know about: an unentered day is invisible
   * until a salary run blocks on it. Today is excluded — the day is not over, so its absence is
   * not yet a gap and flagging it would cry wolf every morning.
   */
  const daysWithRevenue = new Set(rows.map((r) => r.revenueDate));
  const missingDays = isoRange(from, to).filter((d) => d !== to && !daysWithRevenue.has(d));

  const reviewCount = jobs.data?.length ?? 0;
  const pendingCount = pending.data?.length ?? 0;

  // Only claim "all clear" once the queries have actually answered; while they are loading we
  // know nothing, and an optimistic all-clear on a payroll worklist is the wrong default.
  const loaded = !jobs.isPending && !pending.isPending && !revenue.isPending;
  const attentionCount = reviewCount + pendingCount + missingDays.length;

  const locationName = (id: string) =>
    locations.data?.find((l) => l.id === id)?.name ?? id;

  return (
    <>
      <Toolbar title={t.today.title} description={formatDate(to)} />

      <div className="today">
        <Card title={t.today.needsAttention}>
          {loaded && attentionCount === 0 ? (
            <div className="today__clear">
              <p className="today__clearTitle">{t.today.allClear}</p>
              <p className="muted">{t.today.allClearHint}</p>
            </div>
          ) : (
            <ul className="today__list">
              {reviewCount > 0 ? (
                <AttentionItem to="/review" tone="warn" text={t.today.reviewQueue(reviewCount)} />
              ) : null}
              {pendingCount > 0 ? (
                <AttentionItem to="/shifts" tone="warn" text={t.today.pendingShifts(pendingCount)} />
              ) : null}
              {missingDays.length > 0 ? (
                <AttentionItem
                  to="/revenue"
                  tone="stop"
                  text={t.today.missingRevenue(missingDays.length)}
                  detail={missingDays.map(formatDate).join(' · ')}
                />
              ) : null}
              {!loaded ? <li className="today__loading mono">{t.common.loading}</li> : null}
            </ul>
          )}
        </Card>

        <Card>
          {/*
           * The one display figure on this screen. It is the number a manager opens the app to
           * see, which is what earns it the size (docs/design/system.md § Display numerals).
           */}
          <Figure
            value={weekTotal.toFixed(2)}
            unit={t.common.currency}
            label={t.today.weekRevenue}
          />
        </Card>
      </div>

      {rows.length > 0 ? (
        <Card title={t.today.weekRevenue} flush>
          <Table caption={t.today.weekRevenue}>
            <thead>
              <tr>
                <Th>{t.common.date}</Th>
                <Th>{t.common.location}</Th>
                <Th numeric>{t.common.amount}</Th>
              </tr>
            </thead>
            <tbody>
              {[...rows]
                // Newest first: the most recent day is the one being checked.
                .sort((a, b) => b.revenueDate.localeCompare(a.revenueDate))
                .map((r: RevenueRow) => (
                  <tr key={r.id}>
                    <Td label={t.common.date}>
                      <span className="mono">{formatDate(r.revenueDate)}</span>
                    </Td>
                    <Td label={t.common.location}>{locationName(r.locationId)}</Td>
                    <NumCell money label={t.common.amount}>
                      <Money value={r.amount} />
                    </NumCell>
                  </tr>
                ))}
            </tbody>
            <tfoot>
              <tr>
                <Td label={t.common.total}>{t.common.total}</Td>
                <Td />
                <NumCell money label={t.common.total}>
                  <Money value={weekTotal} />
                </NumCell>
              </tr>
            </tfoot>
          </Table>
        </Card>
      ) : null}
    </>
  );
}

/**
 * One attention row. The whole row is the link, not a trailing "open" affordance — a manager
 * tapping on a phone should not have to hit a small target at the end of a line.
 */
function AttentionItem({
  to,
  text,
  detail,
  tone,
}: {
  to: string;
  text: string;
  detail?: string;
  tone: 'warn' | 'stop';
}) {
  return (
    <li>
      <Link to={to} className={`today__item today__item--${tone}`}>
        <span className="today__itemBody">
          <span className="today__itemText">{text}</span>
          {detail ? <span className="today__itemDetail mono">{detail}</span> : null}
        </span>
        <span className="today__itemGo" aria-hidden="true">
          →
        </span>
      </Link>
    </li>
  );
}
