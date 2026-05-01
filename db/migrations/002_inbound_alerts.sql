-- 002_inbound_alerts.sql
-- Synthesized Tier 2 alert records — one row per HOT/warm/muted alert delivered to a rep.
-- Source spec: docs/schema-spec.md §"Table 2: inbound_alerts".
-- Net-new table; idempotent (safe to re-run).
-- FK assigned_rep_id -> reps(id) requires beacon-loop's 007_reps_table.sql to have run first.

CREATE TABLE IF NOT EXISTS inbound_alerts (
  id                      uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id              text          NOT NULL,
  account_name            text,
  score                   numeric       NOT NULL,
  state                   text          NOT NULL CHECK (state IN ('hot', 'warm', 'muted')),
  tier                    text          NOT NULL DEFAULT 'tier2' CHECK (tier IN ('tier1', 'tier2')),
  assigned_rep_id         integer       REFERENCES reps(id),
  assigned_rep_slack_id   text,
  best_contact_email      text,
  best_contact_name       text,
  best_contact_title      text,
  score_breakdown         jsonb,
  signal_event_ids        uuid[],
  velocity_window_days    integer,
  signal_count            integer,
  contact_count           integer,
  first_party_points      numeric,
  slack_message_ts        text,
  slack_channel_id        text,
  delivered_at            timestamptz,
  rep_action              text          DEFAULT 'none' CHECK (rep_action IN ('none', 'clicked_explain', 'clicked_outreach', 'muted_30d', 'dismissed')),
  rep_action_at           timestamptz,
  mute_until              timestamptz,
  created_at              timestamptz   DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inbound_alerts_account
  ON inbound_alerts(account_id);
CREATE INDEX IF NOT EXISTS idx_inbound_alerts_rep
  ON inbound_alerts(assigned_rep_id);
CREATE INDEX IF NOT EXISTS idx_inbound_alerts_created
  ON inbound_alerts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inbound_alerts_state_mute
  ON inbound_alerts(state, mute_until);

ALTER TABLE inbound_alerts ENABLE ROW LEVEL SECURITY;
