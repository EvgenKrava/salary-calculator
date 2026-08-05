import { Link, Outlet } from '@tanstack/react-router';
import { useAuth, useRole } from '../lib/auth';
import { Button } from '../ui/Button';
import './shell.css';

/** Nav is filtered by role — an employee never sees a link they'd get a 403 from. */
export function AppShell() {
  const { email, signOut } = useAuth();
  const { isAdmin, isManager, isEmployee } = useRole();

  return (
    <div className="shell">
      <header className="shell__bar">
        <span className="shell__brand">Salary&nbsp;Calculator</span>
        <nav className="shell__nav">
          {isManager ? (
            <>
              <Link to="/revenue" className="shell__link">Revenue</Link>
              <Link to="/shifts" className="shell__link">Shifts</Link>
              <Link to="/import" className="shell__link">Import</Link>
              <Link to="/runs" className="shell__link">Salary runs</Link>
              <Link to="/review" className="shell__link">Review</Link>
              <Link to="/employees" className="shell__link">Employees</Link>
            </>
          ) : null}
          {isAdmin ? <Link to="/setup" className="shell__link">Setup</Link> : null}
          {isEmployee && !isManager ? (
            <>
              <Link to="/me/shifts" className="shell__link">My shifts</Link>
              <Link to="/me/pay" className="shell__link">My pay</Link>
            </>
          ) : null}
        </nav>
        <span className="shell__user">{email}</span>
        <Button onClick={signOut}>Sign out</Button>
      </header>
      <main className="shell__main">
        <Outlet />
      </main>
    </div>
  );
}
