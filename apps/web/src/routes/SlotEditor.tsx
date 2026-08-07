import { useState } from 'react';
import { Button } from '../ui/Button';
import {
  useDeleteShiftSlot,
  useSetShiftSlot,
  useShiftSlots,
  type Location,
} from '../lib/queries';
import { t } from '../lib/i18n';
import './slotEditor.css';

/**
 * A location's shift-slot windows.
 *
 * Slots are what the schedule importer maps its slot columns onto — the workbook has a vertical
 * block per slot, and an imported cell gets its hours from the matching slot window here. They had
 * a complete API and **no UI whatsoever**, which is why the deployed locations still run on
 * placeholder hours and why an import reports "missing slot" for a block it cannot place.
 *
 * Getting these wrong pays the wrong amount rather than failing: a shift's hours come from its
 * slot window, and revenue share prorates against the location's working day. So the editor states
 * the consequence rather than presenting four anonymous time fields.
 *
 * `PUT /:slotNumber` is an upsert, so the same form both creates and edits a slot — there is no
 * separate "add" endpoint and no need for two code paths.
 */
export function SlotEditor({ location }: { location: Location }) {
  const slots = useShiftSlots(location.id);
  const save = useSetShiftSlot();
  const remove = useDeleteShiftSlot();
  const [error, setError] = useState<string | null>(null);

  // The next free slot number, so adding does not silently overwrite slot 1.
  const used = new Set((slots.data ?? []).map((s) => s.slotNumber));
  let nextSlot = 1;
  while (used.has(nextSlot)) nextSlot += 1;

  const [slotNumber, setSlotNumber] = useState(String(nextSlot));
  const [startsAt, setStartsAt] = useState(location.opensAt);
  const [endsAt, setEndsAt] = useState(location.closesAt);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const n = Number(slotNumber);
    if (!Number.isInteger(n) || n < 1) {
      setError(t.setup.slotNumberInvalid);
      return;
    }
    try {
      await save.mutateAsync({ locationId: location.id, slotNumber: n, startsAt, endsAt });
      // Advance to the next free number so entering "slot 1, slot 2, slot 3" is a straight run.
      setSlotNumber(String(n + 1));
    } catch (err) {
      // The API rejects a window outside the location's own hours — otherwise the importer would
      // happily produce shifts for hours the shop is shut.
      setError((err as Error).message);
    }
  }

  async function destroy(n: number) {
    setError(null);
    try {
      await remove.mutateAsync({ locationId: location.id, slotNumber: n });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (slots.isLoading) return <p className="mono">{t.common.loading}</p>;

  return (
    <div className="slot-editor">
      <p className="slot-editor__hint">{t.setup.slotsHint}</p>

      {(slots.data ?? []).length === 0 ? (
        <p className="muted">{t.setup.noSlots}</p>
      ) : (
        <ul className="slot-editor__list">
          {[...(slots.data ?? [])]
            .sort((a, b) => a.slotNumber - b.slotNumber)
            .map((s) => (
              <li key={s.slotNumber} className="slot-editor__row">
                <span className="slot-editor__num">{t.setup.slotN(s.slotNumber)}</span>
                <span className="mono">
                  {s.startsAt}–{s.endsAt}
                </span>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => void destroy(s.slotNumber)}
                  disabled={remove.isPending}
                  aria-label={t.setup.deleteSlotN(s.slotNumber)}
                >
                  {t.setup.delete}
                </Button>
              </li>
            ))}
        </ul>
      )}

      <form className="slot-editor__form" onSubmit={submit}>
        <label className="slot-editor__field">
          <span className="slot-editor__label">{t.setup.slotNumber}</span>
          <input
            className="field__input mono"
            type="number"
            min="1"
            value={slotNumber}
            onChange={(e) => setSlotNumber(e.target.value)}
          />
        </label>
        <label className="slot-editor__field">
          <span className="slot-editor__label">{t.setup.opensAt}</span>
          <input
            className="field__input mono"
            type="time"
            required
            value={startsAt}
            onChange={(e) => setStartsAt(e.target.value)}
          />
        </label>
        <label className="slot-editor__field">
          <span className="slot-editor__label">{t.setup.closesAt}</span>
          <input
            className="field__input mono"
            type="time"
            required
            value={endsAt}
            onChange={(e) => setEndsAt(e.target.value)}
          />
        </label>
        <Button type="submit" variant="primary" size="sm" disabled={save.isPending}>
          {save.isPending ? t.common.saving : t.setup.saveSlot}
        </Button>
      </form>

      {error ? <p className="setup__rowError">{error}</p> : null}
    </div>
  );
}
