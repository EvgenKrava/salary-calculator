import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Money } from '../src/ui/Money';
import { t } from '../src/lib/i18n';
import { StatusPill } from '../src/ui/StatusPill';
import { Table, Th, Td, NumCell } from '../src/ui/Table';
import { EmptyState } from '../src/ui/EmptyState';

describe('Money', () => {
  it('always renders exactly two decimals', () => {
    render(<Money value={1234.5} />);
    expect(screen.getByText('1234.50')).toBeInTheDocument();
  });

  it('renders zero as 0.00, not a dash', () => {
    // In payroll, 0.00 and "unknown" are different facts.
    render(<Money value={0} />);
    expect(screen.getByText('0.00')).toBeInTheDocument();
  });

  it('renders unknown as blank, distinct from zero', () => {
    const { container } = render(<Money value={null} />);
    expect(container.textContent).toBe('');
  });

  it('never abbreviates large values', () => {
    render(<Money value={12500} />);
    expect(screen.getByText('12500.00')).toBeInTheDocument();
    expect(screen.queryByText(/12\.5k/i)).not.toBeInTheDocument();
  });

  it('uses the mono/tabular class so columns align digit-for-digit', () => {
    const { container } = render(<Money value={1} />);
    expect(container.querySelector('.mono')).not.toBeNull();
  });
});

describe('StatusPill', () => {
  it('renders the status word, never colour alone', () => {
    render(<StatusPill status="needs_review" />);
    // Colour is never the only signal — accessibility, and managers print these.
    expect(screen.getByText(t.common.statusNeedsReview)).toBeInTheDocument();
  });
});

describe('Table', () => {
  it('renders semantic table markup with scoped headers', () => {
    render(
      <Table caption="Shifts">
        <thead>
          <tr>
            <Th>Employee</Th>
            <Th numeric>Hours</Th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <Td>Olena</Td>
            <NumCell>8.00</NumCell>
          </tr>
        </tbody>
      </Table>,
    );
    const th = screen.getByText('Employee');
    expect(th.tagName).toBe('TH');
    expect(th).toHaveAttribute('scope', 'col');
  });
});

describe('EmptyState', () => {
  it('states the next action rather than just saying empty', () => {
    render(<EmptyState title="No revenue recorded" action="Add a day" />);
    expect(screen.getByText(/add a day/i)).toBeInTheDocument();
  });
});
