import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RevenueTable } from '../src/routes/RevenueRoute';
import { t } from '../src/lib/i18n';

const LOCATIONS = [{ id: 'l1', name: 'Кавʼярня 1', opensAt: '08:00', closesAt: '20:00' }];
const ROWS = [
  { id: 'r1', locationId: 'l1', revenueDate: '2026-05-05', amount: 12400, source: 'manual', status: 'approved' },
];

/**
 * Below 640px the table becomes a stack of labelled rows, and each cell prints its own column
 * name from `data-label` — so a figure is never separated from what it means. That is a CSS
 * `::before`, which jsdom cannot render, so what is asserted here is the **attribute the CSS
 * depends on**. Without it the mobile layout silently degrades to an unlabelled column of
 * values: "05.05.2026 / Кавʼярня 1 / 12400.00" with nothing saying which is which.
 */
describe('mobile stacked table labels', () => {
  it('labels every cell so the phone layout is readable', () => {
    render(<RevenueTable rows={ROWS} locations={LOCATIONS} />);
    // Scoped to tbody: with one row the total carries the same figure, so an unscoped query
    // matches twice.
    const amount = document.querySelector('tbody .td--money');
    expect(amount).toHaveAttribute('data-label', t.common.amount);

    const date = screen.getByText('05.05.2026').closest('td');
    expect(date).toHaveAttribute('data-label', t.common.date);

    const location = screen.getByText('Кавʼярня 1').closest('td');
    expect(location).toHaveAttribute('data-label', t.common.location);
  });

  it('labels the totals row, which is the figure most worth not losing', () => {
    render(<RevenueTable rows={ROWS} locations={LOCATIONS} />);
    const labelled = Array.from(document.querySelectorAll('tfoot td[data-label]'));
    expect(labelled.length).toBeGreaterThan(0);
  });
});
