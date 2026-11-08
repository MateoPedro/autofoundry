create table foundry_state (
  id int primary key check (id = 1),
  running boolean not null default false,
  changed_at timestamptz not null default now()
);
insert into foundry_state (id) values (1);

create table crew (
  role text primary key,
  agent_id text not null,
  board_id text not null,
  identity_id text,
  inbox_id text,
  inbox_address text
);

create table work_cards (
  key text primary key,
  role text not null,
  company_id text references companies(id),
  board_id text not null,
  card_id text not null,
  title text not null,
  status text not null default 'open',
  created_at timestamptz not null default now(),
  closed_at timestamptz
);

create table session_spend (
  session_id text primary key,
  agent_name text not null,
  company_id text references companies(id),
  micro_usd bigint not null,
  started_at timestamptz not null,
  synced_at timestamptz not null default now()
);

create table inbound_seen (
  message_id text primary key,
  outcome text not null,
  at timestamptz not null default now()
);

alter table touches add column message_id text;
create index touches_message_id on touches (message_id) where message_id is not null;
