import { useState } from 'react';
import { buildMonthGrid } from './ScheduleRoute';
import {
  useAppSettings,
  useClearDayOff,
  useDayOffRequests,
  usePublicationState,
  useSetDayOff,
  type DayOffRequest,
} from '../lib/queries';
import { ApiError } from '../lib/api';
import { t } from '../lib/i18n';
import './dayOffPicker.css';

/**
 * The limit-reached 409 body, shaped by `packages/api/src/routes/dayOffRequests.ts`.
 *
 * Every other error surfaces `err.message` (English, from the API) as-is, but this one has
 * Ukrainian copy purpose-built for it (`t.daysOff.limitReached`), so it needs its own fields
 * rather than the message string.
 */
interface LimitReachedBody {
  code: 'limit_reached';
  limit: number;
  kind: 'required' | 'preferred';
}

function isLimitReachedBody(body: unknown): body is LimitReachedBody {
  return (
    typeof body === 'object' &&
    body !== null &&
    (body as { code?: unknown }).code === 'limit_reached'
  );
}

/**
 * Pick the days an employee wants off, one month at a time.
 *
 * Clicking a day cycles none → bажаний → обов'язковий → none, so a single control expresses
 * three states with no mode switch — the whole interaction is "click the days you need".
 *
 * Shared by the employee cabinet and the admin's employee card, which is why `employeeId` is a
 * prop rather than implied: staff with no login yet still need their days recorded, and the API
 * accepts either write path.
 */
export function DayOffPicker({
  employeeId,
  year,
  month,
}: {
  employeeId?: string;
  year: number;
  month: number;
}) {
  const requests = useDayOffRequests({ employeeId, year, month });
  const settings = useAppSettings();
  const publication = usePublicationState({ year, month });
  const setDayOff = useSetDayOff();
  const clearDayOff = useClearDayOff();
  const [error, setError] = useState<string | null>(null);

  const published = publication.data?.published ?? false;
  const cells = buildMonthGrid(year, month);
  const byDate = new Map((requests.data ?? []).map((r) => [r.requestDate, r]));

  const prefix = `${year}-${String(month).padStart(2, '0')}`;
  const inMonth = (requests.data ?? []).filter((r) => r.requestDate.startsWith(prefix));
  const usedRequired = inMonth.filter((r) => r.kind === 'required').length;
  const usedPreferred = inMonth.filter((r) => r.kind === 'preferred').length;
  const limits = settings.data ?? { requiredDaysOffPerMonth: 0, preferredDaysOffPerMonth: 0 };

  /** none → preferred → required → none. */
  async function cycle(iso: string) {
    if (published) return;
    setError(null);
    const current = byDate.get(iso);
    try {
      if (!current) {
        await setDayOff.mutateAsync({ employeeId, requestDate: iso, kind: 'preferred' });
      } else if (current.kind === 'preferred') {
        await setDayOff.mutateAsync({ employeeId, requestDate: iso, kind: 'required' });
      } else {
        // Clearing needs an explicit id: the DELETE query string has no "me" shorthand.
        const target = employeeId ?? current.employeeId;
        await clearDayOff.mutateAsync({ employeeId: target, date: iso });
      }
    } catch (err) {
      // The limit-reached 409 carries a structured `code` so it can be rendered in Ukrainian
      // via `t.daysOff.limitReached`; every other error only has an API-authored English
      // message, so it's shown as-is — the API owns those messages, not this component.
      const body = err instanceof ApiError ? err.body : undefined;
      if (isLimitReachedBody(body)) {
        // `limitReached`'s `kind` slots into a Ukrainian genitive-plural phrase ("не більше 2
        // обов'язкових вихідних"), so it takes `requiredShort`/`preferredShort`, not the raw
        // English `kind` value from the API.
        const kindWord = body.kind === 'required' ? t.daysOff.requiredShort : t.daysOff.preferredShort;
        setError(t.daysOff.limitReached(body.limit, kindWord));
      } else {
        setError((err as Error).message);
      }
    }
  }

  function markOf(r: DayOffRequest | undefined): string {
    if (!r) return '';
    return r.kind === 'required' ? 'day-off__cell--required' : 'day-off__cell--preferred';
  }

  return (
    <div className="day-off">
      <p className="muted">{published ? t.daysOff.monthPublished : t.daysOff.hint}</p>

      <div className="day-off__grid">
        {t.schedule.weekdays.map((wd) => (
          <div key={wd} className="day-off__weekday">
            {wd}
          </div>
        ))}
        {cells.map((cell) => {
          const request = byDate.get(cell.iso);
          return (
            <button
              key={cell.iso}
              type="button"
              className={[
                'day-off__cell',
                cell.inMonth ? '' : 'day-off__cell--outside',
                markOf(request),
                published ? 'day-off__cell--locked' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={() => void cycle(cell.iso)}
              disabled={published || !cell.inMonth}
              aria-pressed={request ? true : false}
            >
              <span className="day-off__daynum">{cell.day}</span>
              {request ? (
                <span className="day-off__mark">
                  {request.kind === 'required' ? t.daysOff.required : t.daysOff.preferred}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      <dl className="day-off__counts">
        <dt>{t.daysOff.required}</dt>
        <dd className="mono">{t.daysOff.used(usedRequired, limits.requiredDaysOffPerMonth)}</dd>
        <dt>{t.daysOff.preferred}</dt>
        <dd className="mono">{t.daysOff.used(usedPreferred, limits.preferredDaysOffPerMonth)}</dd>
      </dl>

      {error ? <p className="day-off__error">{error}</p> : null}
    </div>
  );
}
