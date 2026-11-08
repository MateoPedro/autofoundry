-- Every Monid read Scout makes through monid_read. A row is written before the billed run starts,
-- at the worst-case price, so the daily cap holds even when a response is lost.
create table monid_reads (
  id              text primary key,                 -- mr_...
  source          text not null,                    -- github_issues | hackernews | reddit | x_search
  query           text not null,
  run_id          text,                             -- Monid's run id, once known
  status          text not null default 'started',  -- started | COMPLETED | FAILED | ... | lost
  cost_micro_usd  integer not null,                 -- worst case until the run reports its cost
  created_at      timestamptz not null default now()
);
create index monid_reads_created_at on monid_reads (created_at);
