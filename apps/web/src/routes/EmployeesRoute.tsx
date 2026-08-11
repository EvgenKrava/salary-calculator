import { useState } from 'react';
import { Table, Th, Td } from '../ui/Table';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Field } from '../ui/Field';
import { Select } from '../ui/Select';
import { EmptyState } from '../ui/EmptyState';
import { StatusPill } from '../ui/StatusPill';
import { anyLoading, firstError, Loading } from '../ui/QueryGate';
import { LoadFailure } from '../ui/LoadFailure';
import { Toolbar } from '../ui/Toolbar';
import './employees.css';
import {
  useAddEmployee,
  useEmployees,
  useInviteEmployee,
  useLevels,
  useUpdateEmployee,
  type Employee,
  type Level,
} from '../lib/queries';
import { DayOffPicker } from './DayOffPicker';
import { t } from '../lib/i18n';

/**
 * Manage employees — the screen the nav has always linked to.
 *
 * **Level is the only pay input here, and it is half of one.** Pay lives on the (level,
 * location) matrix in Setup: the level picks the row, the shift's location picks the column, and
 * the cell holds both the day rate and the revenue percent. So this screen decides *which* pay
 * row a person is on, and the matrix decides what that row is worth — which is why the revenue-%
 * field that used to sit beside the level is gone rather than moved.
 *
 * The Cognito link (`cognitoSub`) is NOT editable here. It is written by the Invite action from
 * Cognito's own response — asking a manager to paste a UUID leaked an implementation detail into
 * the UI, and a typo would silently link an employee to no login at all, leaving them unable to
 * see their own shifts or pay (those endpoints key off the verified JWT `sub`).
 */

function AddEmployee({ levels }: { levels: Level[] }) {
  const add = useAddEmployee();
  const [name, setName] = useState('');
  const [levelId, setLevelId] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!levelId) {
      setError(t.employees.chooseLevelFirst);
      return;
    }
    try {
      await add.mutateAsync({
        name: name.trim(),
        levelId,
        // Blank means "not linked yet" — send null, not an empty string, which the API rejects.
        // Deliberately NOT sent: the login is created by the Invite action, which sets this
        // from Cognito's own response. Asking a manager to paste a UUID was an internal
        // implementation detail leaking into the UI, and a typo would silently link an
        // employee to nobody.
      });
      setName('');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    /*
     * `field-row`, not a stacked column. Two short fields down the left edge of a 1200px card
     * left the rest of it empty and made the form look unfinished; a name and a level are one
     * logical row of inputs and now read as one.
     *
     * `Card`, not a hand-rolled `<div className="panel" style={{ padding }}>` — the padding and
     * heading treatment are what drifted screen to screen before the primitive existed.
     */
    <form onSubmit={submit}>
      <Card title={t.employees.addTitle}>
        <div className="field-row">
          {/* `fieldSize`, not `size` — Field extends input attributes, where `size` is the native
              numeric character-width attribute and a string is a type error. */}
          <Field
            label={t.employees.name}
            name="name"
            fieldSize="wide"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          {/* `Select`, not a hand-rolled field/label/select — drifting copies of that markup are
              why the primitive exists (some lost their htmlFor, so the label did nothing). */}
          <Select
            label={t.employees.level}
            name="levelId"
            size="month"
            value={levelId}
            onChange={(e) => setLevelId(e.target.value)}
          >
            <option value="">{t.employees.chooseLevel}</option>
            {levels.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        </div>
        {/* role=status: the only feedback on a failed add, and focus stays on the form. */}
        {error ? <p className="form__error" role="status">{error}</p> : null}
        <Button type="submit" variant="primary" disabled={add.isPending || levels.length === 0}>
          {add.isPending ? t.employees.adding : t.employees.addButton}
        </Button>
        {/* Not --stop: nothing is broken and no payroll is blocked, an admin simply has to create a
            level first. --stop is reserved for what blocks payroll now. */}
        {levels.length === 0 ? <p className="form__note">{t.employees.noLevels}</p> : null}
      </Card>
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
    /*
     * Visible labels, not a placeholder and an unlabelled select.
     *
     * The email field's only visible label was `placeholder="email@example.com"`, which
     * disappears the moment anyone types — exactly when they are checking what they entered — and
     * the role select had no visible label at all, on the control that decides what payroll data
     * the person can see. The design system forbids placeholder-as-label outright, and this was
     * the only place in the app still doing it. The `aria-label`s that carried the meaning are now
     * `Field`/`Select` labels, which is both visible and announced.
     */
    <form onSubmit={submit} className="invite">
      <div className="field-row">
        <Field
          label={t.employees.inviteEmail}
          name={`invite-email-${emp.id}`}
          type="email"
          fieldSize="wide"
          required
          value={email}
          onChange={(ev) => setEmail(ev.target.value)}
        />
        <Select
          label={t.employees.role}
          name={`invite-role-${emp.id}`}
          size="wide"
          value={role}
          onChange={(ev) => setRole(ev.target.value as 'admin' | 'manager' | 'employee')}
        >
          <option value="employee">{t.employees.roleEmployee}</option>
          <option value="manager">{t.employees.roleManager}</option>
          <option value="admin">{t.employees.roleAdmin}</option>
        </Select>
      </div>
      <span className="row-actions">
        <Button type="submit" size="sm" variant="primary" disabled={invite.isPending}>
          {invite.isPending ? t.employees.inviting : t.employees.sendInvite}
        </Button>
        <Button type="button" size="sm" variant="quiet" onClick={onDone}>
          {t.common.cancel}
        </Button>
      </span>
      {error ? <p className="setup__rowError" role="status">{error}</p> : null}
      <p className="invite__hint">{t.employees.inviteHint}</p>
    </form>
  );
}

function EmployeeRow({ emp, levels }: { emp: Employee; levels: Level[] }) {
  const update = useUpdateEmployee();
  const [editing, setEditing] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [levelId, setLevelId] = useState(emp.levelId);
  const [error, setError] = useState<string | null>(null);
  const [daysOffOpen, setDaysOffOpen] = useState(false);
  const monthNow = { year: new Date().getUTCFullYear(), month: new Date().getUTCMonth() + 1 };

  const levelName = levels.find((l) => l.id === emp.levelId)?.name ?? '—';

  async function save() {
    setError(null);
    try {
      await update.mutateAsync({
        id: emp.id,
        levelId,
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
      <>
        <tr>
          <Td label={t.employees.name}>{emp.name}</Td>
          <Td label={t.common.level}>{levelName}</Td>
          <Td label={t.employees.login}>
            {emp.cognitoSub ? (
              <span className="mono">{t.employees.canSignIn}</span>
            ) : inviting ? (
              <InviteEmployee emp={emp} onDone={() => setInviting(false)} />
            ) : (
              <span className="row-actions">
                <span className="mono employees__noLogin">{t.employees.noLogin}</span>
                {emp.active ? (
                  <Button size="sm" onClick={() => setInviting(true)}>{t.employees.invite}</Button>
                ) : null}
              </span>
            )}
          </Td>
          <Td label={t.common.status}><StatusPill status={emp.active ? 'active' : 'inactive'} /></Td>
          <Td label={t.common.actions}>
            {/*
             * `sm` + `quiet` for edit: two identically-outlined full-size buttons gave the manager
             * no cue which was the ordinary action, and at 40px they inflated the row. Edit is the
             * routine one and stays quiet; activate/deactivate keeps its border because it changes
             * whether a person can be paid.
             */}
            <span className="row-actions">
              <Button size="sm" variant="quiet" onClick={() => setEditing(true)}>
                {t.common.edit}
              </Button>
              <Button size="sm" onClick={toggleActive} disabled={update.isPending}>
                {emp.active ? t.employees.deactivate : t.employees.reactivate}
              </Button>
              <Button size="sm" onClick={() => setDaysOffOpen((v) => !v)} aria-expanded={daysOffOpen}>
                {t.employees.daysOff}
              </Button>
            </span>
            {error ? <p className="setup__rowError" role="status">{error}</p> : null}
          </Td>
        </tr>
        {daysOffOpen ? (
          <tr className="setup__detailRow">
            <td className="td" colSpan={5}>
              <h3 className="sr-only">{t.daysOff.title}</h3>
              {/* Admin write path: staff with no login, or who tell the manager verbally. */}
              <DayOffPicker employeeId={emp.id} year={monthNow.year} month={monthNow.month} />
            </td>
          </tr>
        ) : null}
      </>
    );
  }

  return (
    // The same data-labels as the read-only row above: without them the stacked 390px layout
    // labelled a record or not depending on whether it happened to be in edit mode.
    <tr>
      <Td label={t.employees.name}>{emp.name}</Td>
      <Td label={t.common.level}>
        <select className="field__input field__select" aria-label={t.employees.levelFor(emp.name)} value={levelId} onChange={(e) => setLevelId(e.target.value)}>
          {levels.map((l) => (
            <option key={l.id} value={l.id}>{l.name}</option>
          ))}
        </select>
      </Td>
      {/* Login state is read-only here: it is set by Invite from Cognito's own response, so
          there is nothing for a manager to type or mistype. */}
      <Td label={t.employees.login}>
        {emp.cognitoSub ? (
          <span className="mono">{t.employees.canSignIn}</span>
        ) : (
          <span className="mono employees__noLogin">{t.employees.noLogin}</span>
        )}
      </Td>
      <Td label={t.common.status}><StatusPill status={emp.active ? 'active' : 'inactive'} /></Td>
      <Td label={t.common.actions}>
        {/* `sm` + row-actions, matching the read-only row and the setup tables: full-size buttons
            in a 40px row push it apart, and the two rows should not change height on edit. */}
        <span className="row-actions">
          <Button size="sm" variant="primary" onClick={save} disabled={update.isPending}>
            {update.isPending ? t.common.saving : t.common.save}
          </Button>
          <Button size="sm" variant="quiet" onClick={() => setEditing(false)}>
            {t.common.cancel}
          </Button>
        </span>
        {error ? <p className="setup__rowError">{error}</p> : null}
      </Td>
    </tr>
  );
}

export function EmployeesRoute() {
  const employees = useEmployees();
  const levels = useLevels();

  if (anyLoading(employees, levels)) return <Loading what={t.employees.title.toLowerCase()} />;
  const loadError = firstError(employees, levels);
  if (loadError) return <LoadFailure what={t.employees.title.toLowerCase()} error={loadError} />;

  const rows = employees.data ?? [];
  const levelList = levels.data ?? [];

  return (
    <>
      <Toolbar title={t.employees.title} />
      <AddEmployee levels={levelList} />

      {rows.length === 0 ? (
        <EmptyState title={t.employees.empty} action={t.employees.emptyAction} />
      ) : (
        <Table caption={t.employees.title}>
          <thead>
            <tr>
              <Th>{t.employees.name}</Th>
              <Th>{t.common.level}</Th>
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
