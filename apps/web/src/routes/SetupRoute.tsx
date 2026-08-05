import { useState } from 'react';
import { Table, Th, Td, NumCell } from '../ui/Table';
import { Money } from '../ui/Money';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { EmptyState } from '../ui/EmptyState';
import {
  useAddLevel,
  useAddLocation,
  useLevels,
  useLocations,
} from '../lib/queries';
import { t } from '../lib/i18n';

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
            </tr>
          </thead>
          <tbody>
            {rows.map((l) => (
              <tr key={l.id}>
                <Td>{l.name}</Td>
                <Td><span className="mono">{l.opensAt}</span></Td>
                <Td><span className="mono">{l.closesAt}</span></Td>
              </tr>
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
            </tr>
          </thead>
          <tbody>
            {rows.map((l) => (
              <tr key={l.id}>
                <Td>{l.name}</Td>
                <NumCell money><Money value={l.ratePerDay} /></NumCell>
              </tr>
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
      <h1 style={{ marginBottom: 'var(--s4)' }}>{t.setup.title}</h1>
      <LocationsPanel />
      <LevelsPanel />
    </>
  );
}
