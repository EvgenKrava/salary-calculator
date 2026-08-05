import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RevenueTable, RevenueForm } from '../src/routes/RevenueRoute';

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
    expect(screen.getByText('1234.50')).toBeInTheDocument();
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
    expect(screen.getByText(/add a day/i)).toBeInTheDocument();
  });
});

describe('revenue form', () => {
  it('submits location, date and amount', async () => {
    const onSubmit = vi.fn(async () => {});
    render(<RevenueForm locations={LOCATIONS} onSubmit={onSubmit} />);
    await userEvent.selectOptions(screen.getByLabelText(/location/i), 'l2');
    await userEvent.type(screen.getByLabelText(/date/i), '2026-05-06');
    await userEvent.type(screen.getByLabelText(/amount/i), '987.65');
    await userEvent.click(screen.getByRole('button', { name: /add/i }));
    expect(onSubmit).toHaveBeenCalledWith({ locationId: 'l2', revenueDate: '2026-05-06', amount: 987.65 });
  });

  it('surfaces the API conflict message rather than a generic error', async () => {
    // The API says "revenue already recorded for that location and day" — showing that is
    // the difference between a manager fixing it and a manager guessing.
    const onSubmit = vi.fn(async () => {
      throw new Error('revenue already recorded for that location and day');
    });
    render(<RevenueForm locations={LOCATIONS} onSubmit={onSubmit} />);
    await userEvent.type(screen.getByLabelText(/date/i), '2026-05-06');
    await userEvent.type(screen.getByLabelText(/amount/i), '1');
    await userEvent.click(screen.getByRole('button', { name: /add/i }));
    expect(await screen.findByText(/already recorded/i)).toBeInTheDocument();
  });

  it('uses a mono numeric input for the amount', () => {
    const { container } = render(<RevenueForm locations={LOCATIONS} onSubmit={vi.fn()} />);
    expect(container.querySelector('input.mono')).not.toBeNull();
  });
});
