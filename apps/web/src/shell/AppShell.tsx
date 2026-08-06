import { Link, Outlet, useNavigate } from '@tanstack/react-router';
import { useAuth, useRole } from '../lib/auth';
import { Button } from '../ui/Button';
import { t } from '../lib/i18n';
import './shell.css';

/** Nav is filtered by role — an employee never sees a link they'd get a 403 from. */
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
      <header className="shell__bar">
        <span className="shell__brand">{t.common.appName}</span>
        <nav className="shell__nav">
          {isManager ? (
            <>
              <Link to="/revenue" className="shell__link">{t.nav.revenue}</Link>
              <Link to="/shifts" className="shell__link">{t.nav.shifts}</Link>
              <Link to="/schedule" className="shell__link">{t.nav.schedule}</Link>
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
        <Button onClick={handleSignOut}>{t.common.signOut}</Button>
      </header>
      <main className="shell__main">
        <Outlet />
      </main>
    </div>
  );
}
