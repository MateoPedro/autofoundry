-- One row per Scout run that ended, from each Scout deployment's on_idle webhook. Compliance's screen
-- starts once a cycle has 8 (screen_batch), so it runs soon after Scout is done.
create table scout_pings (
  id           bigserial primary key,
  cycle_start  timestamptz not null,               -- start of the 3-hour Scout cycle (UTC)
  received_at  timestamptz not null default now()
);
create index scout_pings_cycle on scout_pings (cycle_start);

-- The app no longer starts Compliance sessions itself (that needed an admin-minted key).
drop table screen_triggers;
