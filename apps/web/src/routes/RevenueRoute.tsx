import { useState } from 'react';
import { Table, Th, Td, NumCell } from '../ui/Table';
import { Money } from '../ui/Money';
import { StatusPill } from '../ui/StatusPill';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { Select } from '../ui/Select';
import { EmptyState } from '../ui/EmptyState';
import { Toolbar } from '../ui/Toolbar';
import { Figure } from '../ui/Figure';
import { Modal } from '../ui/Modal';
import { PhotoImport } from './PhotoImport';
import { t, formatDate } from '../lib/i18n';
import { useAddRevenue, useLocations, useRevenue, type Location, type RevenueRow } from '../lib/queries';

export function RevenueTable({ rows, locations }: { rows: RevenueRow[]; locations: Location[] }) {
  if (rows.length === 0) {
    return <EmptyState title={t.revenue.empty} action={t.revenue.emptyAction} />;
  }
  const nameOf = (id: string) => locations.find((l) => l.id === id)?.name ?? '—';
  const total = rows.reduce((sum, r) => sum + r.amount, 0);
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
            <Td label={t.common.date}>
              <span className="mono">{formatDate(r.revenueDate)}</span>
            </Td>
            <Td label={t.common.location}>{nameOf(r.locationId)}</Td>
            <Td label={t.revenue.source}>
              {r.source === 'manual' ? t.revenue.sourceManual : t.revenue.sourceExtracted}
            </Td>
            <Td label={t.common.status}>
              <StatusPill status={r.status} />
            </Td>
            <NumCell money label={t.common.amount}>
              <Money value={r.amount} />
            </NumCell>
          </tr>
        ))}
      </tbody>
      {/*
       * A ledger that does not sum its own column makes the manager add it up by hand — which is
       * the arithmetic this app exists to remove. The table had no tfoot at all.
       */}
      <tfoot>
        <tr>
          <Td label={t.common.total}>{t.common.total}</Td>
          <Td> </Td>
          <Td> </Td>
          <Td> </Td>
          <NumCell money label={t.common.total}>
            <Money value={total} />
          </NumCell>
        </tr>
      </tfoot>
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
    <form onSubmit={submit}>
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
  // Two distinct ways in, both modals: type one figure, or photograph the sheet and let AI read
  // it. The form used to sit permanently below the table, which made the screen look like a data
  // entry form that happened to show history, rather than a record you occasionally add to.
  const [manualOpen, setManualOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  if (locations.isLoading || revenue.isLoading) {
    return <p className="mono">{t.common.loading}</p>;
  }
  if (locations.error || revenue.error) {
    return <p style={{ color: 'var(--stop)' }}>{((locations.error ?? revenue.error) as Error).message}</p>;
  }

  const rows = revenue.data ?? [];
  const total = rows.reduce((sum, r) => sum + r.amount, 0);

  return (
    <>
      <Toolbar title={t.revenue.title}>
        <Button onClick={() => setImportOpen(true)}>{t.nav.import}</Button>
        <Button variant="primary" onClick={() => setManualOpen(true)}>
          {t.revenue.addManually}
        </Button>
      </Toolbar>

      {/*
       * Ledger archetype: the total is the answer, the rows are the evidence
       * (docs/design/system.md § Page archetypes). Rendered only when there is something to sum —
       * a display-size "0.00" above an empty-state card would be a very loud way to say nothing.
       */}
      {rows.length > 0 ? (
        <div className="ledger__head">
          <Figure value={total.toFixed(2)} unit={t.common.currency} label={t.revenue.periodTotal} />
        </div>
      ) : null}

      <RevenueTable rows={rows} locations={locations.data ?? []} />

      <Modal
        open={manualOpen}
        onClose={() => setManualOpen(false)}
        title={t.revenue.addTitle}
      >
        <RevenueForm
          locations={locations.data ?? []}
          onSubmit={async (body) => {
            await add.mutateAsync(body);
            // Close on success only — an error keeps the modal open with the figures still in
            // the fields, so the manager does not have to retype them.
            setManualOpen(false);
          }}
        />
      </Modal>

      <Modal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        title={t.revenue.importTitle}
        description={t.photo.hint}
      >
        <PhotoImport docType="revenue" />
      </Modal>
    </>
  );
}
