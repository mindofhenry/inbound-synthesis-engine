-- 003_inbound_tier1_leads_v2.sql
-- Tier 1 ephemeral SLA state v2 — one row per Tier 1 lead under SLA.
-- Source spec: docs/schema-spec.md §"Table 3: inbound_tier1_leads_in_flight v2".
--
-- DESTRUCTIVE: this migration drops and rebuilds inbound_tier1_leads_in_flight.
-- The live table holds 0 rows (verified MIN-61) and diverges from both the
-- Notion proposal and the v2 spec across PK type, column set, and FK shape.
-- The schema diff is too wide to express as ALTER TABLE operations cleanly,
-- so MIN-41 Path C reconciliation is drop-and-rebuild. No data is lost.
-- This is the only non-idempotent operation in any of the v2 migrations.

DROP TABLE IF EXISTS inbound_tier1_leads_in_flight CASCADE;

CREATE TABLE IF NOT EXISTS inbound_tier1_leads_in_flight (
  id                      uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  sfdc_lead_id            text          NOT NULL,
  account_id              text,
  account_name            text,
  contact_email           text,
  contact_name            text,
  contact_title           text,
  event_type              text,
  assigned_rep_id         integer       REFERENCES reps(id),
  assigned_rep_slack_id   text,
  sla_start_time          timestamptz   NOT NULL DEFAULT now(),
  sla_tier                text          NOT NULL DEFAULT 'tier1_60min',
  ack_status              text          NOT NULL DEFAULT 'pending'
                                          CHECK (ack_status IN ('pending', 'acknowledged', 'claimed', 'escalated')),
  ack_time                timestamptz,
  escalation_stage        integer       DEFAULT 0,
  open_opp_on_account     boolean       DEFAULT false,
  open_opp_id             text,
  breach_1_fired          boolean       DEFAULT false,
  breach_2_fired          boolean       DEFAULT false,
  slack_message_ts        text,
  claimed_by_slack_id     text,
  created_at              timestamptz   DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tier1_ack_status
  ON inbound_tier1_leads_in_flight(ack_status);
CREATE INDEX IF NOT EXISTS idx_tier1_sla_start
  ON inbound_tier1_leads_in_flight(sla_start_time);
CREATE INDEX IF NOT EXISTS idx_tier1_assigned_rep
  ON inbound_tier1_leads_in_flight(assigned_rep_id);

ALTER TABLE inbound_tier1_leads_in_flight ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE inbound_tier1_leads_in_flight IS
  'Tier 1 inbound lead SLA state. Ephemeral — rows resolve within ~2hr. Not a CRM replacement.';
