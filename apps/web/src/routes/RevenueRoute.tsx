import { useState } from 'react';
import { Table, Th, Td, NumCell } from '../ui/Table';
import { Money } from '../ui/Money';
import { StatusPill } from '../ui/StatusPill';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { Select } from '../ui/Select';
import { EmptyState } from '../ui/EmptyState';
import { t, formatDate } from '../lib/i18n';
import { useAddRevenue, useLocations, useRevenue, type Location, type RevenueRow } from '../lib/queries';

export function RevenueTable({ rows, locations }: { rows: RevenueRow[]; locations: Location[] }) {
  if (rows.length === 0) {
    return <EmptyState title={t.revenue.empty} action={t.revenue.emptyAction} />;
  }
  const nameOf = (id: string) => locations.find((l) => l.id === id)?.name ?? '—';
  return (
    <Table caption={t.revenue.title}>
      <thead>
        <tr>
          <Th>{t.common.date}</Th>
          <Th>{t.common.location}</Th>
          <Th>{t.revenue.source}</Th>
          <Th>{t.common.status}</Th>
          <Th numeric>{t.common.amount}</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <Td>
              <span className="mono">{formatDate(r.revenueDate)}</span>
            </Td>
            <Td>{nameOf(r.locationId)}</Td>
            <Td>{r.source === 'manual' ? t.revenue.sourceManual : t.revenue.sourceExtracted}</Td>
            <Td>
              <StatusPill status={r.status} />
            </Td>
            <NumCell money>
              <Money value={r.amount} />
            </NumCell>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

export function RevenueForm({
  locations,
  onSubmit,
}: {
  locations: Location[];
  onSubmit: (body: { locationId: string; revenueDate: string; amount: number }) => Promise<void>;
}) {
  const [locationId, setLocationId] = useState(locations[0]?.id ?? '');
  const [revenueDate, setRevenueDate] = useState('');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await onSubmit({ locationId, revenueDate, amount: Number(amount) });
      setAmount('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel" style={{ padding: 'var(--s4)', marginTop: 'var(--s6)' }} onSubmit={submit}>
      <h2 style={{ marginBottom: 'var(--s4)' }}>{t.revenue.addTitle}</h2>
      <Select
        label={t.common.location}
        name="locationId"
        size="wide"
        value={locationId}
        onChange={(e) => setLocationId(e.target.value)}
      >
        {locations.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
      </Select>
      <Field
        label={t.revenue.revenueDate}
        name="revenueDate"
        type="date"
        numeric
        required
        value={revenueDate}
        onChange={(e) => setRevenueDate(e.target.value)}
      />
      <Field
        label={t.revenue.amountUah}
        name="amount"
        type="number"
        step="0.01"
        min="0"
        numeric
        required
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        error={error ?? undefined}
      />
      <Button type="submit" variant="primary" disabled={busy}>
        {busy ? t.revenue.saving : t.common.add}
      </Button>
    </form>
  );
}

export function RevenueRoute() {
  const locations = useLocations();
  const revenue = useRevenue();
  const add = useAddRevenue();

  if (locations.isLoading || revenue.isLoading) {
    return <p className="mono">{t.common.loading}</p>;
  }
  if (locations.error || revenue.error) {
    return <p style={{ color: 'var(--stop)' }}>{((locations.error ?? revenue.error) as Error).message}</p>;
  }

  return (
    <>
      <h1 style={{ marginBottom: 'var(--s4)' }}>{t.revenue.title}</h1>
      <RevenueTable rows={revenue.data ?? []} locations={locations.data ?? []} />
      <RevenueForm
        locations={locations.data ?? []}
        onSubmit={async (body) => {
          await add.mutateAsync(body);
        }}
      />
    </>
  );
}
