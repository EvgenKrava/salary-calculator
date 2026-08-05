import { useState } from 'react';
import { Table, Th, Td, NumCell } from '../ui/Table';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { EmptyState } from '../ui/EmptyState';
import { StatusPill } from '../ui/StatusPill';
import { anyLoading, firstError } from '../ui/QueryGate';
import {
  useAddEmployee,
  useEmployees,
  useInviteEmployee,
  useLevels,
  useUpdateEmployee,
  type Employee,
  type Level,
} from '../lib/queries';
import { t } from '../lib/i18n';

/**
 * Manage employees — the screen the nav has always linked to.
 *
 * Two fields here decide what people are paid, so both are shown explicitly rather than
 * hidden behind defaults:
 * - **Level** sets the hourly rate.
 * - **Revenue %** is that person's share of a location-day's revenue, prorated by the hours
 *   they worked (design §3).
 *
 * The Cognito link (`cognitoSub`) is NOT editable here. It is written by the Invite action from
 * Cognito's own response — asking a manager to paste a UUID leaked an implementation detail into
 * the UI, and a typo would silently link an employee to no login at all, leaving them unable to
 * see their own shifts or pay (those endpoints key off the verified JWT `sub`).
 */

/** Percent shown to humans (12.5) vs. the fraction the API stores (0.125). */
export function percentToFraction(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return 0;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0 || value > 100) return null;
  // Round to 4 decimal places — the column is NUMERIC(6,4), so more precision than that is
  // silently discarded by the database and the UI would misreport what was saved.
  return Math.round((value / 100) * 10_000) / 10_000;
}

export function fractionToPercent(fraction: number): string {
  return String(Math.round(fraction * 100 * 10_000) / 10_000);
}

function AddEmployee({ levels }: { levels: Level[] }) {
  const add = useAddEmployee();
  const [name, setName] = useState('');
  const [levelId, setLevelId] = useState('');
  const [percent, setPercent] = useState('0');
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!levelId) {
      setError(t.employees.chooseLevelFirst);
      return;
    }
    const fraction = percentToFraction(percent);
    if (fraction === null) {
      setError(t.employees.badPercent);
      return;
    }
    try {
      await add.mutateAsync({
        name: name.trim(),
        levelId,
        revenuePercent: fraction,
        // Blank means "not linked yet" — send null, not an empty string, which the API rejects.
        // Deliberately NOT sent: the login is created by the Invite action, which sets this
        // from Cognito's own response. Asking a manager to paste a UUID was an internal
        // implementation detail leaking into the UI, and a typo would silently link an
        // employee to nobody.
      });
      setName('');
      setPercent('0');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <form className="panel" style={{ padding: 'var(--s4)', marginBottom: 'var(--s6)' }} onSubmit={submit}>
      <h2 style={{ marginBottom: 'var(--s4)' }}>{t.employees.addTitle}</h2>
      <Field label={t.employees.name} name="name" value={name} onChange={(e) => setName(e.target.value)} required />
      <div className="field">
        <label className="field__label" htmlFor="levelId">{t.employees.levelWithRate}</label>
        <select
          id="levelId"
          className="field__input"
          value={levelId}
          onChange={(e) => setLevelId(e.target.value)}
        >
          <option value="">{t.employees.chooseLevel}</option>
          {levels.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name} — {l.ratePerDay} ₴/{t.employees.perDay}
            </option>
          ))}
        </select>
      </div>
      <Field
        label={t.employees.revenuePercent}
        name="revenuePercent"
        numeric
        inputMode="decimal"
        value={percent}
        onChange={(e) => setPercent(e.target.value)}
      />
      {error ? <p style={{ color: 'var(--stop)' }}>{error}</p> : null}
      <Button type="submit" variant="primary" disabled={add.isPending || levels.length === 0}>
        {add.isPending ? t.employees.adding : t.employees.addButton}
      </Button>
      {levels.length === 0 ? (
        <p style={{ color: 'var(--warn)', fontSize: 'var(--text-xs)' }}>
          {t.employees.noLevels}
        </p>
      ) : null}
    </form>
  );
}

/**
 * Invite form for one employee.
 *
 * This is what turns an employee record into someone who can actually sign in. Before it
 * existed, onboarding meant two `aws cognito-idp` CLI calls plus copying a `sub` UUID by hand
 * into the field above — not something a coffee-shop manager will do.
 *
 * The role choice is explicit and has no default, because it decides what payroll data the
 * person can see: `employee` sees only their own shifts and pay, `manager` sees everyone's.
 */
function InviteEmployee({ emp, onDone }: { emp: Employee; onDone: () => void }) {
  const invite = useInviteEmployee();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'manager' | 'employee'>('employee');
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await invite.mutateAsync({ id: emp.id, email: email.trim(), role });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <form onSubmit={submit} style={{ display: 'flex', gap: 'var(--s2)', alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <input
        className="field__input"
        type="email"
        required
        placeholder="email@example.com"
        aria-label={t.employees.loginEmailFor(emp.name)}
        value={email}
        onChange={(ev) => setEmail(ev.target.value)}
      />
      <select
        className="field__input"
        aria-label={t.employees.roleFor(emp.name)}
        value={role}
        onChange={(ev) => setRole(ev.target.value as 'admin' | 'manager' | 'employee')}
      >
        <option value="employee">{t.employees.roleEmployee}</option>
        <option value="manager">{t.employees.roleManager}</option>
        <option value="admin">{t.employees.roleAdmin}</option>
      </select>
      <Button type="submit" variant="primary" disabled={invite.isPending}>
        {invite.isPending ? t.employees.inviting : t.employees.sendInvite}
      </Button>
      <Button type="button" onClick={onDone}>{t.common.cancel}</Button>
      {error ? <p style={{ color: 'var(--stop)', margin: 0, flexBasis: '100%' }}>{error}</p> : null}
      <p style={{ color: 'var(--ink-muted)', fontSize: 'var(--text-xs)', margin: 0, flexBasis: '100%' }}>
        {t.employees.inviteHint}
      </p>
    </form>
  );
}

function EmployeeRow({ emp, levels }: { emp: Employee; levels: Level[] }) {
  const update = useUpdateEmployee();
  const [editing, setEditing] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [percent, setPercent] = useState(fractionToPercent(emp.revenuePercent));
  const [levelId, setLevelId] = useState(emp.levelId);
  const [error, setError] = useState<string | null>(null);

  const levelName = levels.find((l) => l.id === emp.levelId)?.name ?? '—';

  async function save() {
    setError(null);
    const fraction = percentToFraction(percent);
    if (fraction === null) {
      setError(t.employees.badPercent);
      return;
    }
    try {
      await update.mutateAsync({
        id: emp.id,
        levelId,
        revenuePercent: fraction,
        // cognitoSub is managed by Invite, not hand-edited.
      });
      setEditing(false);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function toggleActive() {
    setError(null);
    try {
      await update.mutateAsync({ id: emp.id, active: !emp.active });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (!editing) {
    return (
      <tr>
        <Td>{emp.name}</Td>
        <Td>{levelName}</Td>
        <NumCell>{fractionToPercent(emp.revenuePercent)}%</NumCell>
        <Td>
          {emp.cognitoSub ? (
            <span className="mono">{t.employees.canSignIn}</span>
          ) : inviting ? (
            <InviteEmployee emp={emp} onDone={() => setInviting(false)} />
          ) : (
            <>
              <span className="mono" style={{ color: 'var(--warn)' }}>{t.employees.noLogin}</span>{' '}
              {emp.active ? (
                <Button onClick={() => setInviting(true)}>{t.employees.invite}</Button>
              ) : null}
            </>
          )}
        </Td>
        <Td><StatusPill status={emp.active ? 'active' : 'inactive'} /></Td>
        <Td>
          <Button onClick={() => setEditing(true)}>{t.common.edit}</Button>{' '}
          <Button onClick={toggleActive} disabled={update.isPending}>
            {emp.active ? t.employees.deactivate : t.employees.reactivate}
          </Button>
          {error ? <p style={{ color: 'var(--stop)', margin: 0 }}>{error}</p> : null}
        </Td>
      </tr>
    );
  }

  return (
    <tr>
      <Td>{emp.name}</Td>
      <Td>
        <select className="field__input" aria-label={t.employees.levelFor(emp.name)} value={levelId} onChange={(e) => setLevelId(e.target.value)}>
          {levels.map((l) => (
            <option key={l.id} value={l.id}>{l.name}</option>
          ))}
        </select>
      </Td>
      <NumCell>
        <input
          className="field__input"
          style={{ textAlign: 'right', maxWidth: '8ch' }}
          inputMode="decimal"
          aria-label={t.employees.revenuePercentFor(emp.name)}
          value={percent}
          onChange={(e) => setPercent(e.target.value)}
        />
      </NumCell>
      {/* Login state is read-only here: it is set by Invite from Cognito's own response, so
          there is nothing for a manager to type or mistype. */}
      <Td>
        {emp.cognitoSub ? (
          <span className="mono">{t.employees.canSignIn}</span>
        ) : (
          <span className="mono" style={{ color: 'var(--warn)' }}>{t.employees.noLogin}</span>
        )}
      </Td>
      <Td><StatusPill status={emp.active ? 'active' : 'inactive'} /></Td>
      <Td>
        <Button variant="primary" onClick={save} disabled={update.isPending}>
          {update.isPending ? t.common.saving : t.common.save}
        </Button>{' '}
        <Button onClick={() => setEditing(false)}>{t.common.cancel}</Button>
        {error ? <p style={{ color: 'var(--stop)', margin: 0 }}>{error}</p> : null}
      </Td>
    </tr>
  );
}

export function EmployeesRoute() {
  const employees = useEmployees();
  const levels = useLevels();

  if (anyLoading(employees, levels)) return <p className="mono">{t.common.loading}</p>;
  const loadError = firstError(employees, levels);
  if (loadError) {
    return (
      <div className="panel" style={{ padding: 'var(--s4)', borderColor: 'var(--stop)', background: 'var(--stop-tint)' }}>
        <h2 style={{ color: 'var(--stop)', marginTop: 0, marginBottom: 'var(--s2)' }}>{t.common.couldNotLoad(t.employees.title.toLowerCase())}</h2>
        <p className="mono" style={{ margin: 0 }}>{loadError.message}</p>
      </div>
    );
  }

  const rows = employees.data ?? [];
  const levelList = levels.data ?? [];

  return (
    <>
      <h1 style={{ marginBottom: 'var(--s4)' }}>{t.employees.title}</h1>
      <AddEmployee levels={levelList} />

      {rows.length === 0 ? (
        <EmptyState title={t.employees.empty} action={t.employees.emptyAction} />
      ) : (
        <Table caption={t.employees.title}>
          <thead>
            <tr>
              <Th>{t.employees.name}</Th>
              <Th>{t.common.level}</Th>
              <Th numeric>{t.employees.revenuePercentShort}</Th>
              <Th>{t.employees.login}</Th>
              <Th>{t.common.status}</Th>
              <Th>{t.common.actions}</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((emp) => (
              <EmployeeRow key={emp.id} emp={emp} levels={levelList} />
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
