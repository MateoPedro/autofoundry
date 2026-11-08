-- Each checkout checkout_link opened. A paid event names only the checkout, so the app finds
-- the lead here instead of trusting the event body.
create table checkouts (
  ref           text primary key,
  company_id    text not null references companies(id),
  lead_id       text not null references leads(id),
  amount_cents  integer not null,
  url           text not null,
  expires_at    timestamptz not null,
  created_at    timestamptz not null default now()
);
create index checkouts_lead on checkouts (lead_id, expires_at);
