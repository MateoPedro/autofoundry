-- Each lead's sample page. A deploy replaces an app's whole file set, so publish_sample
-- redeploys every page a company has published.
create table samples (
  lead_id     text primary key references leads(id),
  company_id  text not null references companies(id),
  html        text not null,
  updated_at  timestamptz not null default now()
);
