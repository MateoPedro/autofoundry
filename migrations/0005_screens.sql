-- Each quick idea screen of a Scout batch (screen_batch). A batch is the pending clusters that got
-- leads since the previous finished screen's cutoff, so a late Scout run is picked up next time.
create table screens (
  id                  text primary key,               -- sc_...
  since               timestamptz not null,           -- leads saved after this are in the batch
  cutoff              timestamptz not null,           -- the next screen starts here once this one finishes
  status              text not null default 'started', -- started | done | failed
  candidate_count     integer not null default 0,
  model               text,
  provider_request_id text,
  billed_micro_usd    integer,
  error               text,
  result              jsonb,
  created_at          timestamptz not null default now(),
  finished_at         timestamptz
);
create index screens_created_at on screens (created_at);

-- One Compliance screen session per Scout cycle, started when all of that cycle's Scout runs end.
create table screen_triggers (
  cycle_start  timestamptz primary key,             -- start of the 3-hour Scout cycle (UTC)
  session_id   text,                                -- the Compliance session it started
  created_at   timestamptz not null default now()
);
