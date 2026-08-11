import { useState } from 'react';
import { Table, Th, Td } from '../ui/Table';
import { AddForm } from '../ui/AddForm';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Field } from '../ui/Field';
import { EmptyState } from '../ui/EmptyState';
import { Loading } from '../ui/QueryGate';
import { Toolbar } from '../ui/Toolbar';
import {
  useAddLevel,
  useAddLocation,
  useAppSettings,
  useDeleteLevel,
  useDeleteLocation,
  useLevels,
  useLocations,
  useUpdateAppSettings,
  useUpdateLevel,
  useUpdateLocation,
  type Level,
  type Location,
} from '../lib/queries';
import { SlotEditor } from './SlotEditor';
import { PayMatrixPanel } from './PayMatrixPanel';
import { t } from '../lib/i18n';
import './setup.css';

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

export function LocationsPanel() {
  const locations = useLocations();
  const add = useAddLocation();
  const [name, setName] = useState('');
  const [opensAt, setOpensAt] = useState('');
  const [closesAt, setClosesAt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** Clears the form, including the error: a reopened form must not show an abandoned failure. */
  function reset() {
    setName('');
    setOpensAt('');
    setClosesAt('');
    setError(null);
  }

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      await add.mutateAsync({ name, opensAt, closesAt });
      reset();
      return true;
    } catch (err) {
      // e.g. "closesAt must be after opensAt" or "location name already exists" — the API's
      // own message tells the admin exactly what to fix. Returning false keeps the form open,
      // so the reason stays next to the values that caused it.
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (locations.isLoading) return <Loading what={t.setup.locations.toLowerCase()} />;
  const rows = locations.data ?? [];

  return (
    <>
      <h2>{t.setup.locations}</h2>
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

      {/* Collapsed behind its own button (ui/AddForm): locations are configured once, so an admin
          opens this screen to read what is set far more often than to add to it, and the Card sat
          open below the table asking for input nobody was giving. */}
      <AddForm
        label={t.setup.addLocation}
        submitLabel={busy ? t.setup.adding : t.setup.addLocation}
        busy={busy}
        onSubmit={submit}
        onCancel={reset}
      >
        {/* A name and two times are one logical row of inputs, not a tall column. */}
        <div className="field-row">
          {/* `location-name`, not `name`: the levels form below has a name field too, and `Field`
              derives the input id from this — two `id="name"` inputs would point both labels at
              whichever rendered first, which is now reachable since both forms can be open. */}
          <Field
            label={t.setup.locationName}
            name="location-name"
            fieldSize="wide"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Field
            label={t.setup.opensAt}
            name="opensAt"
            type="time"
            numeric
            fieldSize="time"
            required
            value={opensAt}
            onChange={(e) => setOpensAt(e.target.value)}
          />
          <Field
            label={t.setup.closesAt}
            name="closesAt"
            type="time"
            numeric
            fieldSize="time"
            required
            value={closesAt}
            onChange={(e) => setClosesAt(e.target.value)}
          />
        </div>
        {/*
         * The error moves out of the closesAt field and up to form level.
         *
         * It was attached to `closesAt` because that field is last, not because that is where the
         * fault is: "location name already exists" printed under the closing-time box. A
         * submission-level failure belongs at submission level.
         */}
        {error ? <p className="form__error" role="status">{error}</p> : null}
      </AddForm>
    </>
  );
}

/**
 * One level row: name, editable inline. Pay lives on the (level, location) matrix, not here.
 *
 * Deleting is expected to 409 while any employee still references the level; the API's message
 * is surfaced rather than second-guessed.
 */
export function LevelRow({ level }: { level: Level }) {
  const update = useUpdateLevel();
  const remove = useDeleteLevel();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(level.name);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    try {
      await update.mutateAsync({ id: level.id, name });
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

export function LevelsPanel() {
  const levels = useLevels();
  const add = useAddLevel();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function reset() {
    setName('');
    setError(null);
  }

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      await add.mutateAsync({ name });
      reset();
      return true;
    } catch (err) {
      // e.g. "level name already exists"
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (levels.isLoading) return <Loading what={t.setup.levels.toLowerCase()} />;
  const rows = levels.data ?? [];

  return (
    <>
      <h2 className="setup__sectionTitle">{t.setup.levels}</h2>
      {/*
        * A level is a pure LABEL now — the day rate and revenue percent moved to the (level,
        * location) matrix below, because the same level is paid differently at different cafés.
        * The hint says so here, on the panel that used to own the rate field: an admin who
        * remembers entering a rate on a level needs to be told where it went, not left to
        * conclude the setting was lost.
        */}
      <p className="muted setup__sectionHint">{t.setup.levelsHint}</p>
      {rows.length === 0 ? (
        <EmptyState title={t.setup.noLevels} action={t.setup.noLevelsAction} />
      ) : (
        <Table caption={t.setup.levels}>
          <thead>
            <tr>
              <Th>{t.setup.levelName}</Th>
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

      {/* Collapsed like the locations form above, though this one is a single field: a level and a
          location are the same class of thing on this screen, and two disclosure behaviours for
          "add one of these" would make the difference look meaningful when it is not. */}
      <AddForm
        label={t.setup.addLevel}
        submitLabel={busy ? t.setup.adding : t.setup.addLevel}
        busy={busy}
        onSubmit={submit}
        onCancel={reset}
      >
        {/* One field, so the error stays ON it — "level name already exists" is about the name. */}
        <Field
          label={t.setup.levelName}
          name="level-name"
          fieldSize="wide"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={error ?? undefined}
        />
      </AddForm>
    </>
  );
}

/** Standing day-off limits. Admin-only, and they apply to every month until changed. */
export function DayOffLimitsPanel() {
  const settings = useAppSettings();
  const update = useUpdateAppSettings();
  const [required, setRequired] = useState('');
  const [preferred, setPreferred] = useState('');
  const [error, setError] = useState<string | null>(null);

  const current = settings.data;
  if (settings.isLoading || !current) return <Loading what={t.daysOff.limitsTitle.toLowerCase()} />;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const body: { requiredDaysOffPerMonth?: number; preferredDaysOffPerMonth?: number } = {};
    if (required.trim() !== '') body.requiredDaysOffPerMonth = Number(required);
    if (preferred.trim() !== '') body.preferredDaysOffPerMonth = Number(preferred);
    if (Object.keys(body).length === 0) return;
    try {
      await update.mutateAsync(body);
      setRequired('');
      setPreferred('');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <form onSubmit={submit} className="setup__settingsForm">
      <Card title={t.daysOff.limitsTitle} description={t.daysOff.limitsHint}>
      <div className="field-row">
        <Field
          label={t.daysOff.requiredPerMonth}
          name="requiredDaysOffPerMonth"
          type="number"
          min="0"
          numeric
          placeholder={String(current.requiredDaysOffPerMonth)}
          value={required}
          onChange={(e) => setRequired(e.target.value)}
        />
        <Field
          label={t.daysOff.preferredPerMonth}
          name="preferredDaysOffPerMonth"
          type="number"
          min="0"
          numeric
          placeholder={String(current.preferredDaysOffPerMonth)}
          value={preferred}
          onChange={(e) => setPreferred(e.target.value)}
        />
      </div>
      {error ? <p className="form__error" role="status">{error}</p> : null}
      <Button type="submit" variant="primary" disabled={update.isPending}>
        {update.isPending ? t.common.saving : t.common.save}
      </Button>
      </Card>
    </form>
  );
}

/**
 * Admin one-time setup: locations and their working hours, levels, and what each level is paid
 * at each location.
 *
 * Panel order is a dependency order, not a preference. The pay matrix's axes ARE the locations
 * and levels above it, so it can only be filled in once both exist — and an admin who scrolls
 * straight to it on a fresh install is told to add those first (`t.payMatrix.needsSetup`) rather
 * than shown an empty grid.
 */
export function SetupRoute() {
  return (
    <>
      <Toolbar title={t.setup.title} />
      <LocationsPanel />
      <LevelsPanel />
      <div className="setup__section">
        <PayMatrixPanel />
      </div>
      <DayOffLimitsPanel />
    </>
  );
}
