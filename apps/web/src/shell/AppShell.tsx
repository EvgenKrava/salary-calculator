import { Link, Outlet } from '@tanstack/react-router';
import { useAuth, useRole } from '../lib/auth';
import { Button } from '../ui/Button';
import { t } from '../lib/i18n';
import './shell.css';

/** Nav is filtered by role — an employee never sees a link they'd get a 403 from. */
export function AppShell() {
  const { email, signOut } = useAuth();
  const { isAdmin, isManager, isEmployee } = useRole();

  return (
    <div className="shell">
      <header className="shell__bar">
        <span className="shell__brand">{t.common.appName}</span>
        <nav className="shell__nav">
          {isManager ? (
            <>
              <Link to="/revenue" className="shell__link">{t.nav.revenue}</Link>
              <Link to="/shifts" className="shell__link">{t.nav.shifts}</Link>
              <Link to="/import" className="shell__link">{t.nav.import}</Link>
              <Link to="/runs" className="shell__link">{t.nav.runs}</Link>
              <Link to="/review" className="shell__link">{t.nav.review}</Link>
              <Link to="/employees" className="shell__link">{t.nav.employees}</Link>
            </>
          ) : null}
          {isAdmin ? <Link to="/setup" className="shell__link">{t.nav.setup}</Link> : null}
          {isEmployee && !isManager ? (
            <>
              <Link to="/me/shifts" className="shell__link">{t.nav.myShifts}</Link>
              <Link to="/me/pay" className="shell__link">{t.nav.myPay}</Link>
            </>
          ) : null}
        </nav>
        <span className="shell__user">{email}</span>
        <Button onClick={signOut}>{t.common.signOut}</Button>
      </header>
      <main className="shell__main">
        <Outlet />
      </main>
    </div>
  );
}
