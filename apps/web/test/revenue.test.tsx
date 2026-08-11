import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RevenueTable, RevenueForm } from '../src/routes/RevenueRoute';
import { t } from '../src/lib/i18n';

const LOCATIONS = [
  { id: 'l1', name: '1', opensAt: '08:00', closesAt: '20:00' },
  { id: 'l2', name: '2', opensAt: '08:00', closesAt: '20:00' },
];

describe('revenue table', () => {
  it('renders amounts with two decimals in a money cell', () => {
    render(
      <RevenueTable
        rows={[{ id: 'r1', locationId: 'l1', revenueDate: '2026-05-05', amount: 1234.5, source: 'manual', status: 'approved' }]}
        locations={LOCATIONS}
      />,
    );
    // Two matches, not one: the row and the totals row. With a single row they carry the same
    // figure, so this asserts the count rather than using getByText, which throws on ambiguity.
    expect(screen.getAllByText('1234.50')).toHaveLength(2);
  });

  it('sums the money column so the manager does not add it up by hand', () => {
    render(
      <RevenueTable
        rows={[
          { id: 'r1', locationId: 'l1', revenueDate: '2026-05-05', amount: 1234.5, source: 'manual', status: 'approved' },
          { id: 'r2', locationId: 'l2', revenueDate: '2026-05-05', amount: 65.5, source: 'manual', status: 'approved' },
        ]}
        locations={LOCATIONS}
      />,
    );
    // 1234.50 + 65.50 = 1300.00 — and the total must be distinguishable from either row.
    expect(screen.getByText('1300.00')).toBeInTheDocument();
  });

  it('shows the location name rather than its uuid', () => {
    render(
      <RevenueTable
        rows={[{ id: 'r1', locationId: 'l1', revenueDate: '2026-05-05', amount: 10, source: 'manual', status: 'approved' }]}
        locations={LOCATIONS}
      />,
    );
    expect(screen.queryByText('l1')).not.toBeInTheDocument();
  });

  it('tells the manager what to do when there is no revenue yet', () => {
    render(<RevenueTable rows={[]} locations={LOCATIONS} />);
    expect(screen.getByText(t.revenue.emptyAction)).toBeInTheDocument();
  });
});

describe('revenue form', () => {
  it('submits location, date and amount', async () => {
    const onSubmit = vi.fn(async () => {});
    render(<RevenueForm locations={LOCATIONS} onSubmit={onSubmit} />);
    await userEvent.selectOptions(screen.getByLabelText(t.common.location), 'l2');
    await userEvent.type(screen.getByLabelText(t.revenue.revenueDate), '2026-05-06');
    await userEvent.type(screen.getByLabelText(t.revenue.amountUah), '987.65');
    await userEvent.click(screen.getByRole('button', { name: t.common.add }));
    expect(onSubmit).toHaveBeenCalledWith({ locationId: 'l2', revenueDate: '2026-05-06', amount: 987.65 });
  });

  it('surfaces the API conflict message rather than a generic error', async () => {
    // The API says "revenue already recorded for that location and day" — showing that is
    // the difference between a manager fixing it and a manager guessing.
    const onSubmit = vi.fn(async () => {
      throw new Error('revenue already recorded for that location and day');
    });
    render(<RevenueForm locations={LOCATIONS} onSubmit={onSubmit} />);
    await userEvent.type(screen.getByLabelText(t.revenue.revenueDate), '2026-05-06');
    await userEvent.type(screen.getByLabelText(t.revenue.amountUah), '1');
    await userEvent.click(screen.getByRole('button', { name: t.common.add }));
    expect(await screen.findByText(/already recorded/i)).toBeInTheDocument();
  });

  it('uses a mono numeric input for the amount', () => {
    const { container } = render(<RevenueForm locations={LOCATIONS} onSubmit={vi.fn()} />);
    expect(container.querySelector('input.mono')).not.toBeNull();
  });

  it('sizes the date and amount for their own data, not for a 4-digit year', () => {
    /*
     * Both were falling through to `--num` (12ch, sized for a year). Measured in Chromium that put
     * each at 100px: the date input CLIPPED ITS OWN `dd.mm.yyyy` placeholder to "dd . mm . )" with
     * the calendar icon printing over the last segment, and the amount box was narrower than the
     * six-digit figures a day's takings run to.
     *
     * jsdom has no layout, so the widths themselves were verified in the browser (date 160px,
     * amount 211px, neither scrolling its own content with `05.08.2026` / `125000.50` in it). What
     * this pins is the class that selects the width, which is what regressed.
     */
    const { container } = render(<RevenueForm locations={LOCATIONS} onSubmit={vi.fn()} />);

    const date = screen.getByLabelText(t.revenue.revenueDate);
    expect(date.closest('.field')).toHaveClass('field--date');
    // Inferred from type="date" rather than passed, so the next date input in the app cannot
    // silently inherit the numeric width again.
    expect(date).toHaveAttribute('type', 'date');

    expect(screen.getByLabelText(t.revenue.amountUah).closest('.field')).toHaveClass('field--money');
    expect(container.querySelector('.field--num')).toBeNull();
  });

  it('lays the three inputs out as one row, since they are one record', () => {
    // Stacked, they left a wide modal with three short boxes down its left edge and the rest empty
    // — the same `field-row` idiom the location add-form and day editor use.
    const { container } = render(<RevenueForm locations={LOCATIONS} onSubmit={vi.fn()} />);
    const row = container.querySelector('.field-row');
    expect(row).not.toBeNull();
    expect(row!.querySelectorAll('.field')).toHaveLength(3);
  });
});
