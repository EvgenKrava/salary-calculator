-- Levels carry a DAY rate, not an hourly one.
--
-- This is how the business actually thinks and talks about pay ("ставка за день"), and it is
-- what the admin screen now asks for. The pay model keeps pro-rating by hours, because a day
-- is regularly split between two people — the owner's own words: "Буває що не цілий день а
-- декілька годин, а решту допрацьовує інша людина." Paying each of them a full day would
-- roughly double that day's wage bill.
--
-- So: pay = rate_per_day * (hours worked / length of that location's working day).
-- A whole day pays exactly the day rate; half a day pays half. See calculateSalaries.ts.
--
-- The rename is a rename, not a re-scale: existing values would be reinterpreted, so this is
-- only safe while the table is empty (verified before applying — 0 rows). If levels ever hold
-- data, replace this with an explicit UPDATE that multiplies by the standard day length.
ALTER TABLE levels RENAME COLUMN rate_per_hour TO rate_per_day;

-- The old CHECK moved with the column but keeps its old name, which would confuse anyone
-- reading the schema later.
ALTER TABLE levels RENAME CONSTRAINT levels_rate_per_hour_check TO levels_rate_per_day_check;
