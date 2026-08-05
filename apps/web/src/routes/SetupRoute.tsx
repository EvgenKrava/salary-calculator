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

  if (locations.isLoading) return <p className="mono">loading…</p>;
  const rows = locations.data ?? [];

  return (
    <>
      <h2 style={{ marginBottom: 'var(--s4)' }}>Locations</h2>
      {rows.length === 0 ? (
        <EmptyState title="No locations yet." action="Add one below." />
      ) : (
        <Table caption="Locations">
          <thead>
            <tr>
              <Th>Name</Th>
              <Th>Opens</Th>
              <Th>Closes</Th>
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
        <h2 style={{ marginBottom: 'var(--s4)' }}>Add a location</h2>
        <Field label="Name" name="name" required value={name} onChange={(e) => setName(e.target.value)} />
        <Field
          label="Opens at"
          name="opensAt"
          type="time"
          numeric
          required
          value={opensAt}
          onChange={(e) => setOpensAt(e.target.value)}
        />
        <Field
          label="Closes at"
          name="closesAt"
          type="time"
          numeric
          required
          value={closesAt}
          onChange={(e) => setClosesAt(e.target.value)}
          error={error ?? undefined}
        />
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? 'Adding…' : 'Add location'}
        </Button>
      </form>
    </>
  );
}

function LevelsPanel() {
  const levels = useLevels();
  const add = useAddLevel();
  const [name, setName] = useState('');
  const [ratePerHour, setRatePerHour] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await add.mutateAsync({ name, ratePerHour: Number(ratePerHour) });
      setName('');
      setRatePerHour('');
    } catch (err) {
      // e.g. "level name already exists"
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (levels.isLoading) return <p className="mono">loading…</p>;
  const rows = levels.data ?? [];

  return (
    <>
      <h2 style={{ margin: 'var(--s8) 0 var(--s4)' }}>Levels</h2>
      {rows.length === 0 ? (
        <EmptyState title="No levels yet." action="Add one below." />
      ) : (
        <Table caption="Levels">
          <thead>
            <tr>
              <Th>Name</Th>
              <Th numeric>Rate per hour</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((l) => (
              <tr key={l.id}>
                <Td>{l.name}</Td>
                <NumCell money><Money value={l.ratePerHour} /></NumCell>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <form className="panel" style={{ padding: 'var(--s4)', marginTop: 'var(--s4)' }} onSubmit={submit}>
        <h2 style={{ marginBottom: 'var(--s4)' }}>Add a level</h2>
        <Field label="Name" name="name" required value={name} onChange={(e) => setName(e.target.value)} />
        <Field
          label="Rate per hour"
          name="ratePerHour"
          type="number"
          step="0.01"
          min="0"
          numeric
          required
          value={ratePerHour}
          onChange={(e) => setRatePerHour(e.target.value)}
          error={error ?? undefined}
        />
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? 'Adding…' : 'Add level'}
        </Button>
      </form>
    </>
  );
}

/** Admin one-time setup: locations with their working hours, and levels with their pay rate. */
export function SetupRoute() {
  return (
    <>
      <h1 style={{ marginBottom: 'var(--s4)' }}>Setup</h1>
      <LocationsPanel />
      <LevelsPanel />
    </>
  );
}
