# Interface Design System — Salary Calculator

**Status:** Locked. Change this file before changing components, not after.

## Context

An internal payroll tool for a Ukrainian coffee-shop chain. Three roles:

- **Admin** — one-time setup (locations, working hours, shift slots, levels).
- **Manager** — daily operations: enter revenue, approve shifts, import the schedule, run
  payroll. Uses it several times a week, often quickly, sometimes on a phone.
- **Employee** — checks their own shifts and their own pay.

The content is **numbers people are paid from**. A misread digit is a payroll dispute.
Every decision below serves reading numbers accurately and fast.

## Direction: "Steel & Amber" — an operations console, not a dashboard

The interface reads as a **working ledger**: dense, gridded, cool-neutral, with amber
reserved almost entirely for money. It embraces being a table rather than hiding tables
inside cards.

**What this is not, deliberately:**

- **Not** cream paper + serif display + terracotta accent. That is the current
  house-default aesthetic for AI-generated interfaces; it would read as generic, and its
  warmth undersells a tool whose job is precision.
- **Not** indigo/violet gradients on white with rounded cards and generous padding — the
  default SaaS dashboard. It wastes vertical space this data cannot spare.
- **Not** dark mode by default. Managers enter revenue in daylight in a shop; light
  ground with high-contrast ink is more legible and prints better.

**The one memorable thing:** the **money column**. Monospaced, tabular, right-aligned,
amber-tinted, with a hairline rule to its left — so the eye finds totals instantly on any
screen, and columns of figures align digit-for-digit down the page.

## Structure & navigation

The surface rules below (colour, type, the money column) were followed, and the app still
read as assembled rather than designed. The reason was **structure**, not paint: every
screen was an identical heading-plus-table, navigation was six equal-weight links with no
grouping, and the home route said *"Choose a section from the navigation."* — a payroll
tool whose front door asks the manager to figure out where to go.

**Left rail, not a top tab strip.** Nine destinations across three roles do not fit one
horizontal row; on a phone they became a sideways-scrolling strip where half the app was
off-screen. A rail gives each item a full-width hit target, room for a count badge, and —
most importantly — **grouping**, so the nav teaches the shape of the product:

| Group | Contains | Why together |
|---|---|---|
| **Операції** (Operations) | Today, Revenue, Shifts, Schedule | Recurring work, most days |
| **Розрахунки** (Payroll) | Review, Runs | Money leaving the business; needs more care |
| **Налаштування** (Setup) | Employees, Parameters | Rarely touched, admin-only |

The rail collapses to a bottom bar below 900px (thumb reach), and the count badge is the
only place in the app where a number appears outside a mono face — it is a notification,
not a figure to verify.

**Every screen answers "what needs me?" before "here is data."** That is what the `Today`
home screen exists for: unreviewed extractions, days missing revenue, shifts awaiting a
decision, blocked runs. Each item is a **link to the thing itself**, never a bare count —
a badge saying "3" that a manager has to go hunting for is worse than no badge.

### Page archetypes

Three, and every route is exactly one of them. Mixing them is what made the screens feel
interchangeable.

1. **Worklist** — attention items with an action per row (Today, Review, pending shifts).
   Opens with what is wrong; a *clean* worklist is a first-class state and says so
   explicitly rather than rendering an empty table.
2. **Ledger** — dense figures (Revenue, Runs, My pay). Leads with the period total in
   display-size numerals, then the rows. The total is the answer; the rows are evidence.
3. **Form** — labelled fields, no tables (Setup, Employees, modals). Never dense.

### Display numerals

A ledger's period total is set in `--text-display` mono, tabular, amber, with the unit and
period beneath it in muted small caps. This is the second memorable element after the money
column, and it earns its size: the total is what the manager came to the screen for.

Rules that keep it from becoming decoration:
- **One per screen.** Two competing display figures means neither is the answer.
- **Only for a figure the user came for** — a period total or a run total. Never a count of
  rows, never a percentage.
- Ledger rows stay at `--row-h`; the display figure does not license loosening the table.

## Typography

| Role | Family | Why |
|---|---|---|
| UI / prose | **IBM Plex Sans** (400/500/600) | Utilitarian, slightly technical, characterful without being decorative. Not Inter, not a system stack. Sibling of the mono face, so the pairing is coherent by construction. |
| Numbers, money, IDs, times, dates | **IBM Plex Mono** (400/500) | True tabular figures, unambiguous `0/O` and `1/l` — the whole point. |

Rules:

- **Every** numeral a user might compare or verify is IBM Plex Mono: money, hours, dates,
  times, percentages, counts, UUID fragments. Prose numerals stay in IBM Plex Sans.
- `font-variant-numeric: tabular-nums` on all numeric cells so digits align in columns.
- No serif display face. Utilitarian is the point.
- Scale (rem): `0.75 / 0.8125 / 0.9375 / 1.0625 / 1.375 / 1.75`, plus `2.75` for the ledger
  display figure only. Base is 15px, not 14px: at 14px a manager reading a dense payroll
  table had to lean in, and it made every heading look timid by comparison.
- **Cyrillic is first-class, and this constrains the type choice.** The entire UI is Ukrainian,
  so any candidate face must ship a Cyrillic subset — verify it before adopting one rather than
  assuming. This rule previously named **Instrument Sans**, which ships **latin and latin-ext
  only**: every Ukrainian label fell back to a system font, silently defeating the type system
  on every screen. IBM Plex Sans and IBM Plex Mono both cover Cyrillic (confirmed against the
  Google Fonts CSS response). Never letter-space Cyrillic.

## Color

Cool neutral ground, ink text, amber for value, and functional colors used *only* for
state. Defined once as CSS variables.

```css
:root {
  /* Ground — cool gray, not cream, not pure white */
  --ground:      #F2F4F5;   /* app background */
  --surface:     #FFFFFF;   /* tables, panels */
  --surface-sunk:#E8EBED;   /* table headers, inset rows */

  /* Ink */
  --ink:         #16191C;   /* primary text */
  --ink-muted:   #5A636B;   /* labels, secondary */
  --ink-faint:   #8B959D;   /* placeholders, disabled */

  /* Structure — visible, embraced */
  --rule:        #D3D9DD;   /* 1px table/section rules */
  --rule-strong: #A9B2B9;   /* emphasized dividers */

  /* Amber — value and primary action. Used sparingly. */
  --amber:       #B26B00;   /* money text, primary button bg */
  --amber-tint:  #FBF0DC;   /* money column wash, selected row */
  --amber-edge:  #E0A64B;

  /* State — functional only, never decorative */
  --ok:          #1F6B4A;   /* approved, paid, verified */
  --warn:        #8A5A00;   /* needs review, low confidence */
  --stop:        #A32020;   /* blocked run, conflict, overlap */
  --stop-tint:   #FBEBEB;
}
```

Discipline:

- **Amber is not a brand wash.** It appears on money figures, the primary action in a
  view, and a selected row. Two amber elements per screen is usually one too many.
- `--stop` is reserved for things that **block payroll** — a blocked salary run, an
  overlapping shift, a missing revenue day. Never for a dismissible message.
- Never encode meaning in color alone: pair every state color with a word or a glyph
  (accessibility, and managers print these).

## Space, density, shape

- **4px base unit.** Spacing: `4 / 8 / 12 / 16 / 20 / 24 / 32 / 40 / 48`.
- **Table row height 40px.** This rule said 34px, on the reasoning that a manager scanning a
  month should see the month rather than scroll it. That reasoning holds for *density* but
  34px is below the 44px minimum tap target, and revenue gets entered on a phone behind a
  counter — so the rule was failing the primary use case to serve the secondary one. 40px
  with `--tap: 44px` on interactive cells still fits a month on a laptop screen.
- **Radius scales with element size:** `4px` inline chips, `6px` controls (buttons, inputs),
  `10px` containers (cards, panels), pill only for count badges. A single 2px value on
  everything is what made this read as a 2010s admin panel — and it removed the size cue that
  tells you a button is a button next to a card.
- **Borders over shadows.** One `1px solid var(--rule)`. Shadow only on genuinely floating
  layers (dropdown, modal, sticky bar), and then a single tight shadow — no stacked glows.
- **Full-bleed tables.** Tables run edge-to-edge in their panel with no inner padding
  gutter; the row rules are the structure.

## Components

**Table** — the primary surface, not a fallback.
- Sticky header, `--surface-sunk` background, `--ink-muted` uppercase 0.75rem labels.
- Row rules `1px var(--rule)`; no zebra striping (it fights the money column).
- Hover: `--surface-sunk`. Selected: `--amber-tint`.
- Money/number cells right-aligned, mono, tabular. Text cells left-aligned.
- The money column carries `border-left: 1px solid var(--rule)` and `--amber-tint`.

**Money** — one component, used everywhere money appears.
- Mono, tabular, right-aligned, `--amber`, always exactly 2 decimals.
- Zero renders as `0.00`, never `—` or blank; blank means *unknown*, and in payroll those
  are different facts.
- Never abbreviate (`12.5k` is unacceptable in a pay breakdown).

**Status pill** — word + color, 2px radius, no icon-only states.
`approved` `--ok` · `requested` `--ink-muted` · `needs review` `--warn` · `blocked`/`rejected` `--stop`.

**Buttons** — Primary: `--amber` bg, white text. Secondary: `--surface` bg, `--rule`
border. Destructive: `--stop` text on `--surface` with `--stop` border; filled red only
inside a confirmation dialog.

**Forms** — Label above input, always visible (no placeholder-as-label). Numeric and time
inputs are mono. Errors sit below the field in `--stop` with the reason, never a generic
"invalid".

**Empty vs blocked** — Empty state states what to do next ("No revenue recorded for this
period. Add a day."). A *blocked* state names the blocker and links to it — a blocked
salary run lists the missing location-days as links, because that is the manager's next
action.

## Motion

Restrained, functional. This is a tool used repeatedly; delight decays into friction.

- Transitions `120ms ease-out` on hover/focus/selection only.
- No page-load stagger, no scroll reveals, no skeleton shimmer — a 34px row does not
  benefit from a shimmer. Use a small inline mono `loading…`.
- Exactly one expressive moment: when a salary run finishes, the total row draws its left
  rule and the figure counts up over `400ms`. It marks the one irreversible action in the
  product.
- Respect `prefers-reduced-motion: reduce` — drop to no transition.

## Accessibility (non-negotiable)

- Ink on ground/surface exceeds 7:1; `--ink-muted` exceeds 4.5:1. `--amber` on
  `--surface` is used at 500 weight for AA at body size.
- Visible focus ring: `2px solid var(--ink)` with `2px` offset. Never `outline: none`.
- Full keyboard reach for every manager flow; tables are navigable and every action has a
  real `<button>`.
- Semantic `<table>` with `<th scope>` — these get read by screen readers and copied into
  spreadsheets.

## Responsive

- Manager flows must work at **390px** — revenue gets entered on a phone behind a counter.
- Below 720px, wide tables become stacked records with the money figure kept
  right-aligned and mono; horizontal scroll is a fallback, not the plan.
- No hover-only affordances anywhere.
