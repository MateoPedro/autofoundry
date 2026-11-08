-- The foundry's tables, from docs/foundry-contract.md section 3.

create table clusters (
  id                 text primary key,
  label              text not null unique,
  source             text not null,
  signal_count       integer not null default 0,
  unserved_score     real not null default 0,
  review_status      text not null default 'pending',
  review_reason      text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table offers (
  id                 text primary key,
  cluster_id         text not null references clusters(id),
  buyer              text not null,
  sample             text not null,
  product            text not null,
  price_cents        integer not null,
  channel            text not null,
  outreach_message   text not null,
  follow_up_message  text,
  delivery           text not null,
  review_status      text not null default 'pending',
  review_reason      text,
  parent_offer_id    text references offers(id),
  created_at         timestamptz not null default now()
);

create table companies (
  id                 text primary key,
  slug               text not null unique,
  offer_id           text not null references offers(id),
  cluster_id         text not null references clusters(id),
  parent_id          text references companies(id),
  status             text not null default 'spawning',
  granted_micro_usd  bigint not null default 0,
  spawned_at         timestamptz not null default now(),
  funded_at          timestamptz,
  killed_at          timestamptz
);

create table company_resources (
  company_id   text not null references companies(id),
  kind         text not null,
  role         text,
  naive_id     text not null,
  name         text,
  created_at   timestamptz not null default now(),
  primary key (company_id, kind, naive_id)
);

create table leads (
  id           text primary key,
  cluster_id   text not null references clusters(id),
  company_id   text references companies(id),
  name         text not null,
  url          text,
  contact_url  text,
  email        text,
  external_id  text,
  status       text not null default 'new',
  sample_url   text,
  data         jsonb not null default '{}',
  created_at   timestamptz not null default now(),
  unique (cluster_id, external_id)
);

create table touches (
  id              text primary key,
  company_id      text not null references companies(id),
  lead_id         text references leads(id),
  agent_name      text not null,
  channel         text not null,
  kind            text not null,
  detail          text,
  cost_micro_usd  bigint not null default 0,
  at              timestamptz not null default now()
);

create table payments (
  id              text primary key,
  company_id      text not null references companies(id),
  lead_id         text references leads(id),
  amount_cents    integer not null,
  refunded_cents  integer not null default 0,
  source          text not null,
  external_ref    text not null unique,
  livemode        boolean not null,
  at              timestamptz not null default now()
);

create table spend (
  company_id   text references companies(id),
  agent_id     text not null,
  agent_name   text not null,
  micro_usd    bigint not null,
  synced_at    timestamptz not null default now(),
  primary key (agent_id, synced_at)
);

create table decisions (
  id                text primary key,
  agent             text not null,
  kind              text not null,
  cluster_id        text references clusters(id),
  offer_id          text references offers(id),
  company_id        text references companies(id),
  amount_micro_usd  bigint,
  reason            text not null,
  at                timestamptz not null default now()
);

create table funding_policy (
  id                     integer primary key default 1 check (id = 1),
  pool_micro_usd         bigint not null,
  grant_micro_usd        bigint not null,
  max_grants_per_company integer not null,
  max_proposed           integer not null,
  max_active             integer not null,
  budget_split           jsonb not null,
  updated_at             timestamptz not null default now()
);

insert into funding_policy values
  (1, 10000000, 5000000, 3, 3, 2, '{"builder": 0.5, "outreach": 0.3, "closer": 0.2}', now());
