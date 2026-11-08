-- spawn's request_id, so a retry with the same id resumes the company instead of making another.
alter table companies add column request_id text unique;
