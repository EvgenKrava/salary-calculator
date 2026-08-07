# Schedule Authoring — Design

**Date:** 2026-08-07
**Status:** Approved (design), pending implementation plan

## 1. Purpose

Make the app the place a schedule is **created**, and demote the xlsx import to a way of
*pre-filling* that same structure. Today the relationship is inverted: import writes shifts
straight to the database, so anything it reads wrongly becomes a conflict the manager cannot
correct, and anything it refuses to guess is simply lost.

Three problems this fixes, in order of consequence:

1. **148 substitutions are parsed, reported, and never imported.** A covering person's name is
   written in the cell where a location number belongs. Those people worked; nothing in the app
   knows it, so nobody is paid.
2. **There is no way to build a schedule without a workbook.** A new month, a mid-month change,
   or a shop with no spreadsheet habit has no path in.
3. **Staff cannot state when they need to be off.** The chain already works this way informally;
   the app has no representation for it, so a manager can only find out by being told.

## 2. Established facts

Confirmed against the code and the real client workbook (1047×559, sheet «Графік роботи») during
design. These correct earlier assumptions and are load-bearing:

- **A cell value is a location number.** `asNumber("1.0") → 1`, matched against
  `locations.name`. So a location must be named `"1"`; the `1.0` **location record** in the
  deployed database is spurious — created by someone entering a cell value verbatim — which is
  why both `1.0` and `1` exist.
- **One person may legitimately work several locations on one day.** Migration `0002` already
  relaxed the constraint to `UNIQUE (employee_id, work_date, location_id, starts_at)`. An earlier
  reading of the duplicate person+date pairs as double-counting was **wrong**: they are real
  multi-location days and multi-slot days.
- **`/api/shifts/me` has no status filter** (`shifts.ts:140`). It currently leaks `rejected`
  shifts to employees. This is an existing bug, not a new one — but `draft` makes it serious.
- **The workbook stacks one block per shift slot.** A person appearing twice on a date is normal
  and correct.

## 3. Data model

### 3.1 Draft shifts

`shifts.status` gains **`draft`**. A draft is an ordinary shift row that no payroll query counts
and no employee sees.

```
draft → approved     publish a month
draft → (row gone)   manager clears a cell
```

Chosen over a separate `schedule_drafts` table and over a per-month JSON blob because it keeps
one place a shift can live: the overlap check, the unique constraint, the day editor and the
calendar all keep working unchanged. The cost is that every payroll read must filter status —
addressed in §8.

Unresolved import output (a substitute's name, an unknown location number) **cannot** be a shift
row and is not forced into this table; it stays in the import's own report (§6).

### 3.2 Day-off requests

```sql
CREATE TABLE day_off_requests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id   UUID NOT NULL REFERENCES employees (id),
  request_date  DATE NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('required', 'preferred')),
  -- Cognito sub of whoever recorded it: the employee themselves, or the admin who entered it
  -- on their card. A manager asking "who marked this?" must have an answer.
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (employee_id, request_date)
);
```

`kind` is text with a CHECK rather than a boolean, so `required` (blocks publishing) and
`preferred` (warns only) are named rather than implied — and so a third kind is a migration, not
a schema change. Text-plus-CHECK rather than a Postgres enum, matching migration `0005`, which
converted every enum away because the RDS Data API will not implicitly coerce text to an enum.

`UNIQUE (employee_id, request_date)` — a day is either required, preferred, or neither.

### 3.3 Published months

```sql
CREATE TABLE schedule_publications (
  year         INT  NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  month        INT  NOT NULL CHECK (month BETWEEN 1 AND 12),
  published_by TEXT NOT NULL,             -- Cognito sub
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Recorded when publishing proceeded over a required-day-off conflict (§7). NULL otherwise.
  override_reason TEXT,
  PRIMARY KEY (year, month)
);
```

**Both §5 (the picker closes) and §7 (publish) need to answer "is this month published?", and
nothing in the schema answers it today.** Deriving it from "does any approved shift exist for the
month" would be wrong in a way that matters: a single hand-entered mid-month shift would mark an
otherwise-unbuilt month as published and lock staff out of choosing days off for it.

A row here is the answer. It also gives the audit trail publishing needs — who published, when,
and the reason if they overrode a required day off.

Publishing a month that already has a row is idempotent for shift status (drafts still flip) but
leaves the original `published_by`/`published_at` intact — the first publication is the event that
mattered.

### 3.4 Settings

```sql
CREATE TABLE app_settings (
  id                           BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  required_days_off_per_month  INT NOT NULL DEFAULT 2 CHECK (required_days_off_per_month  >= 0),
  preferred_days_off_per_month INT NOT NULL DEFAULT 4 CHECK (preferred_days_off_per_month >= 0)
);
INSERT INTO app_settings (id) VALUES (TRUE);
```

Standing configuration, not per-month: the admin sets it once in Налаштування and it applies to
every month until changed. One limit for all staff (not per level, not per employee), so a new
employee has a limit immediately with no extra step.

The `id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id)` idiom enforces a single row at the schema
level, so a second settings row is impossible rather than merely unexpected. Plain `BOOLEAN`
columns already round-trip correctly through the RDS Data API (`employees.active`,
`schedule_name_map.ignored`), but a boolean **primary key** is unusual enough that the migration
must be verified against the deployed Data API and not only against PGlite — that divergence has
produced four deploy-only failures in this project already. If it misbehaves, the fallback is
`id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1)`.

**No back-fill.** Changing a limit affects the month currently being built; it does not
retroactively invalidate a published month.

## 4. Grid authoring

**Route:** `/schedule/edit`. The read-only calendar at `/schedule` stays — it answers "who is
where today", which a grid does not.

One grid per shift slot, switched by tabs, mirroring the workbook's block layout:

```
Серпень 2026 ▾        [ Зміна 1 ·08:00–14:00 ] [ Зміна 2 ·14:00–20:00 ]
                       ▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔
              1   2   3   4   5   6   7   8   9  10  …   Σ
   Андрій     1   ·   2   2   ◉   ·   1   1   ·   1      6
   Софія      ·   1   ·   1   4   ○   ·   ·   1   ·      4
   Даяна      2   1   ·   ·   1   2   1   ·   ·   2      6
              ▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔
   Σ людей    2   2   1   2   3   1   2   1   1   2

   ◉ зміна на обов'язковому вихідному    ○ на бажаному
```

- **One cell = one location.** Click opens a popover of locations by name plus «Прибрати»;
  typing a digit sets it directly and arrow keys move between cells, so a month can be filled
  from the keyboard — which matters at 14 people × 31 days.
- **Each edit is its own request.** No explicit save, consistent with the rest of the app.
- **Three cell states:** empty, draft (normal), published (leading tick). Editing a published
  cell keeps it `approved` — a mid-month change is real, not a draft.
- **Day-off marks render even on an empty cell**, so a manager sees the request *before*
  assigning rather than discovering it at publish time.
- **Row and column totals.** A day with nobody assigned is the mistake a grid should make
  obvious.

**No virtualisation.** 434 cells per slot is well within the browser's reach, and virtualising
would break keyboard navigation and in-page find for no measured benefit.

## 5. Day-off picking

Two write paths to one table:

**Employee, in their own cabinet** (`/me/days-off`): a month picker covering the current month
and the next two, restricted to months not yet published. A 2-month horizon rather than
"anything unpublished" — an unbounded future invites marking December in March.

```
Мої бажані вихідні · Вересень 2026 ▾

  Пн Вт Ср Чт Пт Сб Нд          ◉ обов'язковий
   1  2  3  4  5  6  7          ○ бажаний
         ◉        ○
   8  9 10 11 12 13 14          Обов'язкових: 1/2
            ○                   Бажаних:      1/4

  Графік на цей місяць ще не опубліковано.
```

Clicking a day cycles: none → preferred → required → none.

**Admin, on the employee's card:** the same picker, for staff who have no login yet or who tell
the manager verbally. This is why the API cannot be scoped to "own records only".

**Limits are enforced on write**, counted per calendar month: a request beyond the configured
count is rejected with a message naming the limit. Enforcing at write rather than at publish
means the person choosing gets the feedback, not the manager discovering it later.

**Editing closes when the month is published** (a `schedule_publications` row exists, §3.3). After that the picker is read-only; a change to a
live schedule is a different conversation, not a preference.

## 6. Import as draft

Import stops writing `approved` shifts. It writes **`draft`** shifts and shows a diff against
whatever is already in that month:

```
ІМПОРТ · Травень 2026                     було → у файлі

  Софія    05.05    ·     →  1            [+ додати]
  Андрій   05.05    1     →  2            [змінити] [пропустити]
  Даяна    05.05    1     →  1            без змін
  Юра      05.05    2     →  ·            [прибрати?]
```

Four per-cell states — **unchanged / added / changed / removed** — and nothing is applied until
the manager confirms. Chosen over "replace the month" (destroys hand-entered corrections and
substitutions) and over "fill gaps only" (a genuine correction in the workbook would silently
not apply).

**Substitutions become one-click resolutions** rather than a dead-end report:

```
ПІДМІНИ (148)

  05.05  зміна 1  Кав'ярня 1
    у файлі: «Сві»   →  [Світлана К. ▾]  [✓ додати]
```

The name from the cell is shown verbatim and the picker is pre-filtered to likely matches, but
the app never guesses: an unconfirmed substitution stays unresolved. This is the path by which
those 148 shifts become payable.

**Already correct and unchanged:** the year-rollover fix (a workbook spanning Травень 2026 →
Серпень 2027) and the `targetYear` + `month` commit scoping. Both are retained.

## 7. Publish

`POST /api/schedule/publish { year, month }` flips that month's `draft` shifts to `approved`.

**Required days off block publishing until explicitly confirmed:**

```
Опублікувати серпень

 ✗ 2 зміни на обов'язкових вихідних:
     Андрій  05.08
     Софія   12.08

 ⚠ 4 зміни на бажаних вихідних (не блокує)

 Причина: [________________________]
 [Підтвердити і опублікувати]  [Скасувати]
```

A blocking confirmation rather than a hard prohibition: emergency cover on someone's required
day off is a real situation, and a rule that cannot be overridden gets worked around outside the
app, where nothing records it. The reason is stored with the publish.

Publishing runs the same overlap validation as the day editor and reports per-shift failures
rather than aborting the whole month.

## 8. Draft isolation (the risk this design creates)

A draft shift living in `shifts` means every payroll read must filter status. There are four
such reads today:

| Read | Current filter | Change |
|---|---|---|
| `salaryRuns` shift query | `status = 'approved'` | none needed |
| Import overlap check | `status = 'approved'` | none needed |
| `shifts.ts` overlap check | `status = 'approved'` | none needed |
| **`/api/shifts/me`** | **none** | **add one — existing bug** |

Mitigation is a dedicated test file that asserts the behaviour rather than the implementation:

```
✓ a draft shift is never counted in a salary run
✓ a draft shift is not visible on /api/shifts/me
✓ a draft shift does not block a real shift's overlap check
✓ publishing turns draft → approved
✓ every shifts query in src/ filters on status
```

The last one is a source-level assertion. It is deliberately crude, and it is the one that
catches the *next* query someone adds without a filter — the actual failure mode, which is a
draft shift reaching a payslip.

## 9. Delete coverage

Audited during design. "Delete everything" resolves to two missing UIs and two deliberate
refusals:

| Entity | API | UI | Decision |
|---|---|---|---|
| Locations | ✅ | ✅ | done |
| Levels | ✅ | ✅ | done |
| Shifts | ✅ | ✅ | done |
| Shift slots | ✅ | ✅ | done |
| **Revenue** | ✅ | ❌ | **add UI** — warn when a run used the day, then allow |
| **Name mappings** | ✅ | ❌ | **add UI** — a wrong mapping pays the wrong person |
| **Salary runs** | ❌ | ❌ | **add hard delete** — confirmation states period, total, line count |
| Employees | ❌ | — | **no delete.** Deactivate; salary history must survive |
| Extraction jobs | ❌ | — | no delete; approve/reject is the lifecycle |

Two decisions were made against the recommendation, and their consequences are accepted
deliberately:

- **Salary runs hard-delete** rather than void. A payslip an employee already saw can vanish with
  no trace of why. The confirmation therefore names exactly what is being destroyed.
- **Revenue deletes with a warning** rather than being blocked when a completed run consumed that
  day. That period stops being reproducible from its inputs. The warning names the run.

## 10. Staging

Two stages, each shippable and verifiable against the real workbook.

**Stage 1 — native authoring.** Draft status; `day_off_requests` and `app_settings`; the grid;
the day-off pickers (employee cabinet and admin card); publish with the required-day-off gate;
draft-isolation tests; the `/api/shifts/me` fix. Ships as: a manager can build and publish a
month by hand, and staff preferences are visible while doing it.

**Stage 2 — import feeds the same form.** Import writes drafts; the four-state diff;
substitution resolution; delete UIs from §9. Ships as: a workbook becomes a correctable draft
instead of a direct write.

Stage 1 is first because it is the structure Stage 2 pre-fills — building the import against a
form that does not exist yet would mean designing both at once and verifying neither.

## 11. Testing

- **Parser and grid arithmetic** are pure and tested directly: month grids, day-off limit
  counting, diff classification.
- **Draft isolation** as in §8.
- **Day-off limits:** writing beyond the configured count is rejected; the count is per calendar
  month; changing the limit does not retroactively invalidate existing requests.
- **Publish:** a required-day-off conflict blocks until confirmed; a preferred one does not; an
  overlap reports per-shift rather than aborting.
- **Import diff:** each of the four states is produced from a fixture; confirming applies only
  what was accepted.
- **End-to-end against the real workbook** (outside the repo, gitignored, real staff names —
  never committed, never printed in test output).
