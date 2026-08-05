# Test fixtures

`makeScheduleFixture.ts` generates a synthetic `.xlsx` in memory that reproduces the
layout of the client's real `Графік роботи Coffee Shop.xlsx` — horizontal months, shift-slot
blocks, location-number cells, duplicate names, substitute abbreviations, annotation rows and
a trailing total column — using invented names.

The real workbook is **not** committed: it contains actual staff names and business data and
is gitignored via `docs/*.xlsx`. Keep it local. If the parser needs to be checked against it,
point a scratch script at the local path — never add it to the repo.
