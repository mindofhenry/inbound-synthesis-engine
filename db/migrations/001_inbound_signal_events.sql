-- 001_inbound_signal_events.sql
-- Tier 2 unified signal ledger — one row per observable account-level signal.
-- Source spec: docs/schema-spec.md §"Table 1: signal_events".
-- Net-new table; idempotent (safe to re-run).

CREATE TABLE IF NOT EXISTS signal_events (
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      text          NOT NULL,
  account_name    text,
  person_id       text,
  person_email    text,
  person_title    text,
  source          text          NOT NULL,  -- marketo, segment, bombora, g2, warmly, sfdc
  event_type      text          NOT NULL,
  event_payload   jsonb,
  signal_weight   numeric,
  first_party     boolean       DEFAULT false,
  occurred_at     timestamptz   NOT NULL,
  created_at      timestamptz   DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_signal_events_account
  ON signal_events(account_id);
CREATE INDEX IF NOT EXISTS idx_signal_events_occurred
  ON signal_events(occurred_at DESC);

ALTER TABLE signal_events ENABLE ROW LEVEL SECURITY;
