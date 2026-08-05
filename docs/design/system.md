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
- Scale (rem): `0.75 / 0.8125 / 0.875 / 1 / 1.25 / 1.75`. Tight and few.
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

- **4px base unit.** Spacing: `4 / 8 / 12 / 16 / 24 / 32 / 48`.
- **Table row height 34px** (not 48+). A manager scanning a month of shifts should see the
  month, not scroll it. Comfortable-density toggle is out of scope.
- **Radius 2px.** Not pills, not sharp-zero. Buttons, inputs, panels all 2px.
- **Borders over shadows.** One `1px solid var(--rule)`. Shadow only on genuinely floating
  layers (dropdown, modal), and then a single tight shadow — no stacked glows.
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
