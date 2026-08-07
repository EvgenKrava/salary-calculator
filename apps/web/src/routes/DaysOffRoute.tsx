import { useState } from 'react';
import { Toolbar } from '../ui/Toolbar';
import { Card } from '../ui/Card';
import { Select } from '../ui/Select';
import { DayOffPicker } from './DayOffPicker';
import { MONTHS, t } from '../lib/i18n';

/**
 * An employee's own day-off screen.
 *
 * The horizon is the current month plus the next two. A bound rather than "any unpublished
 * month": an unlimited future invites marking December in March, which nobody will honour.
 */
export function DaysOffRoute() {
  const now = new Date();
  const options = [0, 1, 2].map((offset) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
  });
  const [chosen, setChosen] = useState(`${options[0].year}-${options[0].month}`);
  const [year, month] = chosen.split('-').map(Number);

  return (
    <>
      <Toolbar title={t.daysOff.myTitle}>
        <Select label={t.schedule.month} name="period" value={chosen} onChange={(e) => setChosen(e.target.value)}>
          {options.map((o) => (
            <option key={`${o.year}-${o.month}`} value={`${o.year}-${o.month}`}>
              {MONTHS[o.month - 1]} {o.year}
            </option>
          ))}
        </Select>
      </Toolbar>
      <Card>
        {/* No employeeId: the API resolves the caller to their own record. */}
        <DayOffPicker year={year} month={month} />
      </Card>
    </>
  );
}
