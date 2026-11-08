-- Scout's memory: the Feedback agent's short notes on what VC funded and killed, and why. Scout reads
-- the live summary and live notes (scout_memory). Once 10 notes are live, Feedback folds them and the
-- previous summary into one new summary (compact_feedback); folded rows stay, marked compacted_into.
create table scout_feedback (
  id              text primary key,                        -- fb_...
  kind            text not null check (kind in ('note', 'summary')),
  body            text not null,
  through_at      timestamptz not null,                    -- the newest VC decision this row covers
  through_id      text not null references decisions(id),
  compacted_into  text references scout_feedback(id),      -- null while live
  created_at      timestamptz not null default now()
);
create index scout_feedback_live on scout_feedback (created_at) where compacted_into is null;
create unique index scout_feedback_note_through on scout_feedback (through_id) where kind = 'note';
