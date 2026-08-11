import type { ReactNode } from 'react';
import { Link, Outlet, useNavigate } from '@tanstack/react-router';
import { useAuth, useRole } from '../lib/auth';
import { useExtractionJobs, useShifts } from '../lib/queries';
import { t } from '../lib/i18n';
import './shell.css';

/**
 * The app frame: a grouped left rail plus the routed content.
 *
 * Why a rail rather than the top tab strip this replaced: nine destinations across three roles
 * do not fit one horizontal row, and on a phone they became a sideways-scrolling strip with half
 * the app off-screen. A rail gives each item a full-width target, room for a count badge, and —
 * the actual point — **grouping**, so navigation teaches the shape of the product instead of
 * presenting nine equal-weight links. See docs/design/system.md § Structure & navigation.
 *
 * Nav is filtered by role, so an employee never sees a link they would get a 403 from.
 */
export function AppShell() {
  const { email, signOut } = useAuth();
  const { isAdmin, isManager, isEmployee } = useRole();
  const navigate = useNavigate();

  /**
   * Sign out, then go to /login.
   *
   * `signOut` only clears auth state and the query cache; without an explicit navigation the
   * user stayed on the page they were on, looking signed in, until something happened to
   * re-render. `replace` so the back button cannot return to an authenticated screen.
   */
  function handleSignOut() {
    signOut();
    void navigate({ to: '/login', replace: true });
  }

  return (
    <div className="shell">
      {/*
       * "Перейти до вмісту", not t.nav.today — the skip link said "Сьогодні", so the first thing a
       * keyboard user tabbed into announced itself as a navigation item to the home screen rather
       * than as the shortcut past the rail that it is.
       */}
      <a className="shell__skip" href="#main">
        {t.nav.skipToContent}
      </a>

      <aside className="rail">
        <div className="rail__brand">
          <span className="rail__mark" aria-hidden="true" />
          <span className="rail__brandText">{t.common.appName}</span>
        </div>

        <nav className="rail__nav" aria-label={t.common.appName}>
          {isManager ? (
            <>
              <RailGroup label={t.nav.groupOps}>
                <RailLink to="/" label={t.nav.today} />
                <RailLink to="/revenue" label={t.nav.revenue} />
                <RailLink to="/shifts" label={t.nav.shifts} badge={<PendingShiftsBadge />} />
                <RailLink to="/schedule" label={t.nav.schedule} exact />
                <RailLink to="/schedule/edit" label={t.nav.scheduleEdit} />
              </RailGroup>

              <RailGroup label={t.nav.groupPayroll}>
                <RailLink to="/review" label={t.nav.review} badge={<ReviewBadge />} />
                <RailLink to="/runs" label={t.nav.runs} />
              </RailGroup>
            </>
          ) : null}

          {isManager || isAdmin ? (
            <RailGroup label={t.nav.groupSetup}>
              {isManager ? <RailLink to="/employees" label={t.nav.employees} /> : null}
              {isAdmin ? <RailLink to="/setup" label={t.nav.setup} /> : null}
            </RailGroup>
          ) : null}

          {isEmployee && !isManager ? (
            <RailGroup label={t.nav.groupOps}>
              <RailLink to="/me/shifts" label={t.nav.myShifts} />
              <RailLink to="/me/pay" label={t.nav.myPay} />
              <RailLink to="/me/days-off" label={t.nav.myDaysOff} />
            </RailGroup>
          ) : null}
        </nav>

        <div className="rail__foot">
          <span className="rail__user mono" title={email ?? undefined}>
            {email}
          </span>
          <button type="button" className="rail__signout" onClick={handleSignOut}>
            {t.common.signOut}
          </button>
        </div>
      </aside>

      <main className="shell__main" id="main">
        <Outlet />
      </main>
    </div>
  );
}

function RailGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rail__group">
      <p className="rail__groupLabel">{label}</p>
      {children}
    </div>
  );
}

function RailLink({
  to,
  label,
  badge,
  exact,
}: {
  to: string;
  label: string;
  badge?: ReactNode;
  /**
   * Match this path only, not its children.
   *
   * Needed by any link that is a path prefix of another: `/schedule` would otherwise render as
   * active while the manager is on `/schedule/edit`, showing two highlighted rail items.
   */
  exact?: boolean;
}) {
  return (
    // `exact` for "/" too — otherwise the index route matches every path as a prefix and
    // Today would render as active on every screen in the app.
    <Link to={to} className="rail__link" activeOptions={{ exact: exact ?? to === '/' }}>
      <span className="rail__linkText">{label}</span>
      {badge}
    </Link>
  );
}

/**
 * Count badges.
 *
 * These read from the same queries their destination screens use, so React Query serves them
 * from cache rather than issuing extra requests. A zero count renders **nothing**: a badge
 * showing "0" is noise, and it trains the manager to ignore the badges that do matter.
 */
function ReviewBadge() {
  const jobs = useExtractionJobs('needs_review');
  return <Badge count={jobs.data?.length ?? 0} />;
}

function PendingShiftsBadge() {
  const shifts = useShifts({ status: 'requested' });
  return <Badge count={shifts.data?.length ?? 0} />;
}

function Badge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="rail__badge">
      {/* The digits are decorative — the accessible name carries the meaning, so a screen
          reader announces "3 потребує уваги" instead of a bare "3". */}
      <span aria-hidden="true">{count}</span>
      <span className="sr-only">{t.nav.needsAttention(count)}</span>
    </span>
  );
}
