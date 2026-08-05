import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { t } from '../src/lib/i18n';

/**
 * Mapping spreadsheet names to employees.
 *
 * This is the step that makes an import mean anything: the parser deliberately never guesses
 * who gets paid, so the real workbook parses 3,337 shift cells and resolves NONE of them until
 * these mappings exist. Before this UI the unmapped names were a read-only list — the manager
 * was told there was a problem and given no way to fix it.
 */

const setMapping = vi.fn();
const employeesQuery = { data: [] as unknown[], isLoading: false, error: null as unknown };
const mapQuery = { data: [] as unknown[], isLoading: false, error: null as unknown };

vi.mock('../src/lib/queries', () => ({
  useEmployees: () => employeesQuery,
  useNameMap: () => mapQuery,
  useSetNameMapping: () => ({ mutateAsync: setMapping, isPending: false }),
}));
vi.mock('../src/lib/config', () => ({ config: { apiUrl: 'http://x', userPoolId: 'p', clientId: 'c' } }));
vi.mock('../src/lib/auth', () => ({ useAuth: () => ({ getToken: async () => 'tok' }) }));

const { NameMapper } = (await import('../src/routes/ImportRoute')) as unknown as {
  NameMapper: (p: { names: string[] }) => JSX.Element | null;
};

const EMPLOYEES = [
  { id: 'e1', name: 'Олена', levelId: 'l', revenuePercent: 0.05, cognitoSub: null, active: true },
  { id: 'e2', name: 'Тарас', levelId: 'l', revenuePercent: 0.05, cognitoSub: null, active: true },
  { id: 'e3', name: 'Колишній', levelId: 'l', revenuePercent: 0, cognitoSub: null, active: false },
];

beforeEach(() => {
  setMapping.mockReset();
  setMapping.mockResolvedValue({});
  employeesQuery.data = EMPLOYEES;
  employeesQuery.error = null;
  mapQuery.data = [];
  mapQuery.error = null;
});

describe('NameMapper', () => {
  it('renders nothing when every name is already mapped', () => {
    const { container } = render(<NameMapper names={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('offers a row per unmapped name, listing only ACTIVE employees', () => {
    render(<NameMapper names={['Андрій', 'Софія']} />);
    const select = screen.getByLabelText(t.importScreen.mapNameFor('Андрій'));
    expect(select).toBeInTheDocument();
    expect(screen.getByLabelText(t.importScreen.mapNameFor('Софія'))).toBeInTheDocument();
    // Assigning a departed employee's shifts would put them back on payroll.
    expect(screen.queryByText('Колишній')).not.toBeInTheDocument();
    // One option per active employee per row (2 rows x 2 active employees).
    expect(screen.getAllByText('Олена')).toHaveLength(2);
  });

  it('persists a mapping when an employee is chosen', async () => {
    const user = userEvent.setup();
    render(<NameMapper names={['Андрій']} />);
    await user.selectOptions(screen.getByLabelText(t.importScreen.mapNameFor('Андрій')), 'e2');
    expect(setMapping).toHaveBeenCalledWith({ sourceName: 'Андрій', employeeId: 'e2', ignored: false });
  });

  it('marks a placeholder row as not-a-person rather than forcing a wrong employee', async () => {
    // The sheet contains rows like "Бариста 1" that are shift slots, not staff. Without this
    // the manager either maps them to someone who did not work, or is re-prompted forever.
    const user = userEvent.setup();
    render(<NameMapper names={['Бариста 1']} />);
    await user.selectOptions(screen.getByLabelText(t.importScreen.mapNameFor('Бариста 1')), '__ignore__');
    expect(setMapping).toHaveBeenCalledWith({ sourceName: 'Бариста 1', ignored: true });
  });

  it('shows an existing mapping as the current selection', () => {
    mapQuery.data = [{ sourceName: 'Андрій', employeeId: 'e1', ignored: false }];
    render(<NameMapper names={['Андрій']} />);
    expect(screen.getByLabelText(t.importScreen.mapNameFor('Андрій'))).toHaveValue('e1');
  });

  it('shows an error instead of an empty picker when employees cannot be loaded', () => {
    // An empty dropdown would read as "no employees exist", inviting the manager to create
    // duplicates of people who are already there.
    employeesQuery.data = [];
    employeesQuery.error = new Error('403 forbidden');
    render(<NameMapper names={['Андрій']} />);
    expect(screen.getByText(t.common.couldNotLoad(t.nav.employees.toLowerCase()))).toBeInTheDocument();
    expect(screen.queryByLabelText(t.importScreen.mapNameFor('Андрій'))).not.toBeInTheDocument();
  });
});
