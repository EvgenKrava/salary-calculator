import { useState } from 'react';
import { Table, Th, Td, NumCell } from '../ui/Table';
import { Money } from '../ui/Money';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { EmptyState } from '../ui/EmptyState';
import { Toolbar } from '../ui/Toolbar';
import {
  useAddLevel,
  useAddLocation,
  useDeleteLevel,
  useDeleteLocation,
  useLevels,
  useLocations,
  useUpdateLevel,
  useUpdateLocation,
  type Level,
  type Location,
} from '../lib/queries';
import { SlotEditor } from './SlotEditor';
import { t } from '../lib/i18n';

/**
 * One location row: read-only until edited, then the same three fields inline.
 *
 * Inline rather than a modal because the common task is correcting one time on one row, and the
 * value you are changing should stay visible next to the others you are comparing it against.
 *
 * The working hours are a **payroll input**, not decoration: a day rate is pro-rated against the
 * location's working day (calculateSalaries), so these fields decide what people are paid. The
 * deployed locations still carry placeholder 09:00–21:00 hours because until now the only way to
 * change them was a hand-written API call.
 */
export function LocationRow({ location }: { location: Location }) {
  const update = useUpdateLocation();
  const remove = useDeleteLocation();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(location.name);
  const [opensAt, setOpensAt] = useState(location.opensAt);
  const [closesAt, setClosesAt] = useState(location.closesAt);
  const [error, setError] = useState<string | null>(null);
  const [slotsOpen, setSlotsOpen] = useState(false);

  async function save() {
    setError(null);
    try {
      await update.mutateAsync({ id: location.id, name, opensAt, closesAt });
      setEditing(false);
    } catch (err) {
      // e.g. "closesAt must be after opensAt" — the API's own message names the fix.
      setError((err as Error).message);
    }
  }

  async function destroy() {
    setError(null);
    try {
      await remove.mutateAsync(location.id);
    } catch (err) {
      // Expected once the location has revenue/shifts/slots: the API returns a 409 explaining
      // that those are payroll history. Surfaced verbatim rather than pre-checked.
      setError((err as Error).message);
    }
  }

  if (!editing) {
    return (
      <>
        <tr>
          <Td label={t.setup.locationName}>{location.name}</Td>
          <Td label={t.setup.opensAt}><span className="mono">{location.opensAt}</span></Td>
          <Td label={t.setup.closesAt}><span className="mono">{location.closesAt}</span></Td>
          <Td label={t.common.actions}>
            <span className="row-actions">
              <Button size="sm" variant="quiet" onClick={() => setEditing(true)}>
                {t.common.edit}
              </Button>
              <Button size="sm" onClick={() => setSlotsOpen((v) => !v)}>
                {t.setup.slots}
              </Button>
              <Button
                size="sm"
                variant="danger"
                onClick={() => void destroy()}
                disabled={remove.isPending}
                aria-label={t.setup.deleteLocationFor(location.name)}
              >
                {t.setup.delete}
              </Button>
            </span>
            {error ? <p className="setup__rowError">{error}</p> : null}
          </Td>
        </tr>
        {slotsOpen ? (
          /*
           * Slots belong to this location, so they expand underneath it rather than living on a
           * separate screen where the connection would have to be restated.
           *
           * One cell spanning the row, not four. Spreading the editor across the table's columns
           * put it under "Відкриття" and left three empty cells, and the loading line rendered as
           * a stray word floating mid-table. A spanning cell is what a detail row actually is.
           */
          <tr className="setup__detailRow">
            <td className="td" colSpan={4}>
              <h3 className="sr-only">{t.setup.slotsFor(location.name)}</h3>
              <SlotEditor location={location} />
            </td>
          </tr>
        ) : null}
      </>
    );
  }

  return (
    <tr>
      <Td label={t.setup.locationName}>
        <input
          className="field__input"
          aria-label={t.setup.locationNameFor(location.name)}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Td>
      <Td label={t.setup.opensAt}>
        <input
          className="field__input mono"
          type="time"
          aria-label={t.setup.opensAtFor(location.name)}
          value={opensAt}
          onChange={(e) => setOpensAt(e.target.value)}
        />
      </Td>
      <Td label={t.setup.closesAt}>
        <input
          className="field__input mono"
          type="time"
          aria-label={t.setup.closesAtFor(location.name)}
          value={closesAt}
          onChange={(e) => setClosesAt(e.target.value)}
        />
      </Td>
      <Td label={t.common.actions}>
        <span className="row-actions">
          <Button size="sm" variant="primary" onClick={() => void save()} disabled={update.isPending}>
            {update.isPending ? t.common.saving : t.common.save}
          </Button>
          <Button
            size="sm"
            variant="quiet"
            onClick={() => {
              // Restore the stored values, so cancelling cannot leave edited text on screen
              // looking like it was saved.
              setName(location.name);
              setOpensAt(location.opensAt);
              setClosesAt(location.closesAt);
              setError(null);
              setEditing(false);
            }}
          >
            {t.common.cancel}
          </Button>
        </span>
        {error ? <p className="setup__rowError">{error}</p> : null}
      </Td>
    </tr>
  );
}

function LocationsPanel() {
  const locations = useLocations();
  const add = useAddLocation();
  const [name, setName] = useState('');
  const [opensAt, setOpensAt] = useState('');
  const [closesAt, setClosesAt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await add.mutateAsync({ name, opensAt, closesAt });
      setName('');
      setOpensAt('');
      setClosesAt('');
    } catch (err) {
      // e.g. "closesAt must be after opensAt" or "location name already exists" — the API's
      // own message tells the admin exactly what to fix.
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (locations.isLoading) return <p className="mono">{t.common.loading}</p>;
  const rows = locations.data ?? [];

  return (
    <>
      <h2 style={{ marginBottom: 'var(--s4)' }}>{t.setup.locations}</h2>
      {rows.length === 0 ? (
        <EmptyState title={t.setup.noLocations} action={t.setup.noLocationsAction} />
      ) : (
        <Table caption={t.setup.locations}>
          <thead>
            <tr>
              <Th>{t.setup.locationName}</Th>
              <Th>{t.setup.opensAt}</Th>
              <Th>{t.setup.closesAt}</Th>
              <Th>{t.common.actions}</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((l) => (
              <LocationRow key={l.id} location={l} />
            ))}
          </tbody>
        </Table>
      )}

      <form className="panel" style={{ padding: 'var(--s4)', marginTop: 'var(--s4)' }} onSubmit={submit}>
        <h2 style={{ marginBottom: 'var(--s4)' }}>{t.setup.addLocation}</h2>
        <Field label={t.setup.locationName} name="name" required value={name} onChange={(e) => setName(e.target.value)} />
        <Field
          label={t.setup.opensAt}
          name="opensAt"
          type="time"
          numeric
          required
          value={opensAt}
          onChange={(e) => setOpensAt(e.target.value)}
        />
        <Field
          label={t.setup.closesAt}
          name="closesAt"
          type="time"
          numeric
          required
          value={closesAt}
          onChange={(e) => setClosesAt(e.target.value)}
          error={error ?? undefined}
        />
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? t.setup.adding : t.setup.addLocation}
        </Button>
      </form>
    </>
  );
}

/**
 * One level row: name and day rate, editable inline.
 *
 * The rate is the single largest input to a payslip — hourly pay is this figure pro-rated by hours
 * worked — so it needs to be correctable without a redeploy. Deleting is expected to 409 while any
 * employee still references the level; the API's message is surfaced rather than second-guessed.
 */
export function LevelRow({ level }: { level: Level }) {
  const update = useUpdateLevel();
  const remove = useDeleteLevel();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(level.name);
  const [rate, setRate] = useState(String(level.ratePerDay));
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    const ratePerDay = Number(rate);
    if (!Number.isFinite(ratePerDay) || ratePerDay < 0) {
      setError(t.setup.rateInvalid);
      return;
    }
    try {
      await update.mutateAsync({ id: level.id, name, ratePerDay });
      setEditing(false);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function destroy() {
    setError(null);
    try {
      await remove.mutateAsync(level.id);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (!editing) {
    return (
      <tr>
        <Td label={t.setup.levelName}>{level.name}</Td>
        <NumCell money label={t.setup.ratePerDay}><Money value={level.ratePerDay} /></NumCell>
        <Td label={t.common.actions}>
          <span className="row-actions">
            <Button size="sm" variant="quiet" onClick={() => setEditing(true)}>
              {t.common.edit}
            </Button>
            <Button
              size="sm"
              variant="danger"
              onClick={() => void destroy()}
              disabled={remove.isPending}
              aria-label={t.setup.deleteLevelFor(level.name)}
            >
              {t.setup.delete}
            </Button>
          </span>
          {error ? <p className="setup__rowError">{error}</p> : null}
        </Td>
      </tr>
    );
  }

  return (
    <tr>
      <Td label={t.setup.levelName}>
        <input
          className="field__input"
          aria-label={t.setup.levelNameFor(level.name)}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Td>
      <Td label={t.setup.ratePerDay}>
        <input
          className="field__input mono"
          type="number"
          step="0.01"
          min="0"
          aria-label={t.setup.rateFor(level.name)}
          value={rate}
          onChange={(e) => setRate(e.target.value)}
        />
      </Td>
      <Td label={t.common.actions}>
        <span className="row-actions">
          <Button size="sm" variant="primary" onClick={() => void save()} disabled={update.isPending}>
            {update.isPending ? t.common.saving : t.common.save}
          </Button>
          <Button
            size="sm"
            variant="quiet"
            onClick={() => {
              setName(level.name);
              setRate(String(level.ratePerDay));
              setError(null);
              setEditing(false);
            }}
          >
            {t.common.cancel}
          </Button>
        </span>
        {error ? <p className="setup__rowError">{error}</p> : null}
      </Td>
    </tr>
  );
}

function LevelsPanel() {
  const levels = useLevels();
  const add = useAddLevel();
  const [name, setName] = useState('');
  const [ratePerDay, setRatePerHour] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await add.mutateAsync({ name, ratePerDay: Number(ratePerDay) });
      setName('');
      setRatePerHour('');
    } catch (err) {
      // e.g. "level name already exists"
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (levels.isLoading) return <p className="mono">{t.common.loading}</p>;
  const rows = levels.data ?? [];

  return (
    <>
      <h2 style={{ margin: 'var(--s8) 0 var(--s4)' }}>{t.setup.levels}</h2>
      {rows.length === 0 ? (
        <EmptyState title={t.setup.noLevels} action={t.setup.noLevelsAction} />
      ) : (
        <Table caption={t.setup.levels}>
          <thead>
            <tr>
              <Th>{t.setup.levelName}</Th>
              <Th numeric>{t.setup.ratePerDay}</Th>
              <Th>{t.common.actions}</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((l) => (
              <LevelRow key={l.id} level={l} />
            ))}
          </tbody>
        </Table>
      )}

      <form className="panel" style={{ padding: 'var(--s4)', marginTop: 'var(--s4)' }} onSubmit={submit}>
        <h2 style={{ marginBottom: 'var(--s4)' }}>{t.setup.addLevel}</h2>
        <Field label={t.setup.levelName} name="name" required value={name} onChange={(e) => setName(e.target.value)} />
        <Field
          label={t.setup.ratePerDay}
          name="ratePerDay"
          type="number"
          step="0.01"
          min="0"
          numeric
          required
          value={ratePerDay}
          onChange={(e) => setRatePerHour(e.target.value)}
          error={error ?? undefined}
        />
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? t.setup.adding : t.setup.addLevel}
        </Button>
      </form>
    </>
  );
}

/** Admin one-time setup: locations with their working hours, and levels with their pay rate. */
export function SetupRoute() {
  return (
    <>
      <Toolbar title={t.setup.title} />
      <LocationsPanel />
      <LevelsPanel />
    </>
  );
}
