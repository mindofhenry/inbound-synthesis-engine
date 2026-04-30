# Inbound Synthesis Engine — Schema Spec v2

## Overview

Three tables back the Inbound Synthesis Engine, all in the shared Beacon
Supabase project (`qzeehftbbvccqoqdpoey`):

1. `signal_events` — Tier 2 unified signal ledger. Every observable
   account-level interaction lands here.
2. `inbound_alerts` — synthesized Tier 2 alert records. One row per HOT
   (or warm) alert delivered to a rep.
3. `inbound_tier1_leads_in_flight` v2 — Tier 1 SLA state. Ephemeral
   per-lead timer state for speed-to-lead enforcement.

Conventions across all three tables:

- **RLS:** enabled. No per-user policies. Service role bypasses RLS;
  the n8n workflows write and read with the service-role key only.
  Anon/authenticated reads are not granted.
- **Migrations:** numbered `001_*.sql`, `002_*.sql`, `003_*.sql` under
  `db/migrations/`. Idempotent where possible (`CREATE TABLE IF NOT
  EXISTS`, `CREATE INDEX IF NOT EXISTS`). The one exception is the
  `inbound_tier1_leads_in_flight` v2 migration, which is destructive
  by design (see §3 Migration notes).
- **PK style:** `uuid PRIMARY KEY DEFAULT gen_random_uuid()` for
  content tables. `INTEGER` only for the existing `reps` lookup
  (which the new tables FK into).
- **External IDs:** `text` (`account_id`, `sfdc_lead_id`, Slack IDs,
  Salesforce IDs).

This doc is the source of truth. The live Supabase schema for
`inbound_tier1_leads_in_flight` has drifted from the proposal; the
reconciliation lives here, not in the database. MIN-62 writes the
migrations against this spec; MIN-63 applies them.

---

## Table 1: `signal_events`

### Purpose

Tier 2 unified ledger. One row per observable signal, keyed on account.
Every input the synthesis layer reads is logged here with source,
timestamp, person, and raw payload. Queryable for account-level
rollups, score recomputation, and the "see sources" explainability path.

### DDL

```sql
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
```

### Indexes

| Name | Columns | Rationale |
|---|---|---|
| `idx_signal_events_account` | `account_id` | Account-level rollup is the primary read pattern. |
| `idx_signal_events_occurred` | `occurred_at DESC` | Velocity windows query "last N days" — descending scan is the hot path. |

### RLS

Enabled. No policies are added — service-role-only access. The n8n
workflows authenticate with the service-role key.

### Sample rows

Two rows that exercise the column shape: one first-party Marketo form
fill, one third-party Bombora surge.

```sql
INSERT INTO signal_events (account_id, account_name, person_id, person_email, person_title, source, event_type, event_payload, signal_weight, first_party, occurred_at) VALUES
  ('acct_orion_001', 'Orion Analytics', 'pers_sandy_001', 'sandy@orion.co', 'Analyst', 'marketo', 'form_fill',
    '{"form_id":"contact_sales","mkto_lead_id":"4451223","page_url":"/pricing"}'::jsonb,
    25.0, true, '2026-04-28T14:12:33Z'),
  ('acct_orion_001', 'Orion Analytics', NULL, NULL, NULL, 'bombora', 'topic_surge',
    '{"topic":"customer data platform","surge_score":78,"week_of":"2026-04-21"}'::jsonb,
    5.0, false, '2026-04-22T00:00:00Z');
```

### Migration notes

- Lands as `db/migrations/001_signal_events.sql`.
- Net-new table; no live drift to reconcile.
- DDL adopted verbatim from the Notion Deliverables companion page —
  Notion is authoritative for `signal_events`.

---

## Table 2: `inbound_alerts`

### Purpose

The synthesized output of the Tier 2 pipeline. One row per alert
delivered to a rep, with the score breakdown, the contact picked, the
underlying `signal_events` IDs, the Slack delivery metadata, and the
rep's response (if any). Mute decisions live on the alert record so
suppression survives across runs.

### DDL

```sql
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
```

### Indexes

| Name | Columns | Rationale |
|---|---|---|
| `idx_inbound_alerts_account` | `account_id` | Suppression check ("any active alert for this account?") and the explain handler both filter on account. |
| `idx_inbound_alerts_rep` | `assigned_rep_id` | "What's in this rep's queue" view, and rep-level metrics. |
| `idx_inbound_alerts_created` | `created_at DESC` | Recent-alerts feed for the demo dashboard and Loom. |
| `idx_inbound_alerts_state_mute` | `(state, mute_until)` | Synthesis pipeline's pre-write check: skip accounts where a non-expired muted alert exists. |

### RLS

Enabled. No policies — service-role-only.

### Design rationale

Four non-obvious design choices:

1. **`tier` lives on `inbound_alerts`, not in two separate tables.**
   One alerts table covers both Tier 1 SLA-driven alerts and Tier 2
   synthesis-driven alerts. The check constraint allows either value.
   `inbound_tier1_leads_in_flight` is operational SLA state (timer,
   ack, escalation), not the alert record itself. Keeping tier on the
   alert lets a future Tier 1 alert row reference its corresponding
   `inbound_tier1_leads_in_flight` row by `account_id + sfdc_lead_id`
   without forcing the schemas to merge.

2. **`signal_event_ids uuid[]` instead of a join table.** Writes are
   single-row, and the typical read is "give me the events backing this
   alert" — a single `WHERE id = ANY (signal_event_ids)` query. A join
   table adds a write per event with no read-side payoff at demo scope.
   The tradeoff: Postgres cannot foreign-key into an array element, so
   referential integrity is enforced by the synthesis pipeline, not the
   schema. If a `signal_events` row is deleted, the array entry
   dangles. For a portfolio demo this is acceptable; for production it
   becomes a join table.

3. **`first_party_points` is denormalized alongside `score_breakdown`
   jsonb.** The HOT eligibility filter is `first_party_points >= 15` —
   a hot-path predicate. Filtering through a jsonb path expression
   (`(score_breakdown->>'first_party_points')::numeric >= 15`) is
   awkward, harder to index, and noisier in the query plan. The
   `score_breakdown` jsonb still carries the full breakdown for the
   explain handler; the dedicated column is the eligibility column.

4. **`rep_action` is `text` + CHECK, not a Postgres enum type.** Adding
   a new action (e.g., `forwarded_to_manager`) means editing one CHECK
   constraint, not running `ALTER TYPE ... ADD VALUE` on a real enum
   that's hard to remove or reorder later. The cost is one CHECK
   constraint per allowed value transition. For a v0 demo where the
   action set is still settling, text+CHECK is the lower-friction
   choice.

### Sample rows

Two rows: one HOT tier2 alert that the rep clicked Explain on, one
muted alert.

```sql
INSERT INTO inbound_alerts (
  account_id, account_name, score, state, tier,
  assigned_rep_id, assigned_rep_slack_id,
  best_contact_email, best_contact_name, best_contact_title,
  score_breakdown, signal_event_ids,
  velocity_window_days, signal_count, contact_count, first_party_points,
  slack_message_ts, slack_channel_id, delivered_at,
  rep_action, rep_action_at, mute_until
) VALUES
  ('acct_orion_001', 'Orion Analytics', 84.0, 'hot', 'tier2',
    1, 'U02ABCD1234',
    'sandy@orion.co', 'Sandy Hallward', 'Analyst',
    '{"first_party_points":47,"third_party_points":10,"velocity_multiplier":1.3,"composition_bonus":10}'::jsonb,
    ARRAY[
      '11111111-1111-1111-1111-111111111111'::uuid,
      '22222222-2222-2222-2222-222222222222'::uuid,
      '33333333-3333-3333-3333-333333333333'::uuid
    ],
    14, 5, 3, 47.0,
    '1714329153.001100', 'D02SANDY01', '2026-04-28T14:32:33Z',
    'clicked_explain', '2026-04-28T14:35:01Z', NULL),
  ('acct_meridian_002', 'Meridian Logistics', 62.0, 'muted', 'tier2',
    2, 'U02EFGH5678',
    'lex@meridian.io', 'Lex Park', 'Director, Ops',
    '{"first_party_points":18,"third_party_points":5,"velocity_multiplier":1.0,"composition_bonus":0}'::jsonb,
    ARRAY['44444444-4444-4444-4444-444444444444'::uuid]::uuid[],
    14, 2, 1, 18.0,
    NULL, NULL, NULL,
    'muted_30d', '2026-04-25T17:02:14Z', '2026-05-25T17:02:14Z');
```

### Migration notes

- Lands as `db/migrations/002_inbound_alerts.sql`.
- Net-new table; no drift.
- FK to `reps(id)` requires that `reps` exists in the project (it does
  — created by beacon-loop's `007_reps_table.sql`).

---

## Table 3: `inbound_tier1_leads_in_flight` v2

### Purpose

Tier 1 ephemeral SLA state. One row per Tier 1 lead under SLA. Rows
resolve within ~2 hours (acknowledged, claimed, or auto-reassigned).
Real lead data stays in Salesforce; this table exists so the SLA
monitor has a fast, indexed surface to query without hammering the
CRM. Not a CRM replacement.

### DDL

```sql
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
```

### Indexes

| Name | Columns | Rationale |
|---|---|---|
| `idx_tier1_ack_status` | `ack_status` | SLA monitor's main filter (`WHERE ack_status = 'pending'`). |
| `idx_tier1_sla_start` | `sla_start_time` | Used jointly with `ack_status` to find breached rows (`sla_start_time < now() - interval '60 min'`). |
| `idx_tier1_assigned_rep` | `assigned_rep_id` | Per-rep queue views and reassignment escalations. |

### RLS

Enabled. No policies — service-role-only.

### Drift reconciliation (live → v2)

The live `inbound_tier1_leads_in_flight` table in project
`qzeehftbbvccqoqdpoey` was created against an earlier draft and
diverged from both the Notion proposal and this v2 spec. The table
currently holds **0 rows**. Reconciliation strategy: drop and rebuild.

| Field | Notion proposal | Live | v2 spec | Resolution |
|---|---|---|---|---|
| Primary key | `id uuid` | `lead_id text` | `id uuid` | Adopt uuid PK. Drop `lead_id`. |
| `sfdc_lead_id text NOT NULL` | yes | absent | yes | Add. |
| `account_id text` / `account_name text` | yes | `company text` only | yes | Drop `company`; adopt `account_id` + `account_name`. |
| `sla_tier text DEFAULT 'tier1_60min'` | yes | absent | yes | Add. |
| `ack_time timestamptz` | yes | absent | yes | Add. |
| `escalation_stage integer DEFAULT 0` | yes | absent | yes | Add. |
| `open_opp_on_account boolean` / `open_opp_id text` | yes | absent | yes | Add. |
| `assigned_rep_id` | `text NOT NULL` | absent (had `assigned_rep_name text`) | `integer REFERENCES reps(id)` | Type changed to integer FK. Drop `assigned_rep_name` — rep name resolves via FK to `reps`. |
| `event_type text` | absent | yes | yes | Keep from live — useful for routing logic and Slack DM rendering. |
| `contact_title text` | absent | yes | yes | Keep from live — surfaced in Slack DM. |
| `breach_1_fired bool` / `breach_2_fired bool` | absent | yes | yes | Keep from live — the SLA monitor tracks per-stage delivery. |
| `slack_message_ts text` | absent | yes | yes | Keep from live — needed to update the original Slack DM on ack. |
| `claimed_by_slack_id text` | absent | yes | yes | Keep from live — distinguishes the originally assigned rep from the rep who actually claimed (Stage 1 escalation case). |
| `ack_status` CHECK constraint | comment-only | none | enforced | Add `CHECK (ack_status IN ('pending','acknowledged','claimed','escalated'))`. |

### Migration notes

The v2 migration is **destructive**. It runs:

```sql
DROP TABLE IF EXISTS inbound_tier1_leads_in_flight CASCADE;
CREATE TABLE inbound_tier1_leads_in_flight (...);
```

This is safe because:

- The live table has 0 rows (verified via `list_tables` against project
  `qzeehftbbvccqoqdpoey`). No data is lost.
- Nothing in the live Beacon project references this table by FK
  (verified — beacon-loop tables don't reference any inbound table).
  The `CASCADE` is defensive; nothing should depend on it.
- The schema diff is too wide to express as `ALTER TABLE` operations
  cleanly — PK type changes from `text` to `uuid`, the rep column
  changes type and gains an FK, and a half-dozen columns are
  added/dropped. Drop-and-rebuild is shorter and easier to review than
  a chain of ALTERs.

The destructive `DROP TABLE` lands in `db/migrations/003_inbound_tier1_leads_in_flight_v2.sql`
(MIN-62) and applies in MIN-63. This is the only migration in the
spec that is **not** idempotent in the safe sense — re-running it
re-drops and re-creates. That is intentional for v2; subsequent
migrations on this table will be additive and idempotent.

### Sample rows

Two rows: one pending lead within SLA, one escalated lead with
Stage 1 breach already fired.

```sql
INSERT INTO inbound_tier1_leads_in_flight (
  sfdc_lead_id, account_id, account_name,
  contact_email, contact_name, contact_title,
  event_type, assigned_rep_id, assigned_rep_slack_id,
  sla_start_time, sla_tier, ack_status, ack_time,
  escalation_stage, open_opp_on_account, open_opp_id,
  breach_1_fired, breach_2_fired,
  slack_message_ts, claimed_by_slack_id
) VALUES
  ('00Q5e000004XyzABC', 'acct_orion_001', 'Orion Analytics',
    'sandy@orion.co', 'Sandy Hallward', 'Analyst',
    'demo_request', 1, 'U02ABCD1234',
    '2026-04-30T14:14:00Z', 'tier1_60min', 'pending', NULL,
    0, false, NULL,
    false, false,
    '1714487640.001200', NULL),
  ('00Q5e000004XyzDEF', 'acct_zenith_003', 'Zenith Robotics',
    'priya@zenith.dev', 'Priya Mehta', 'VP Engineering',
    'pricing_inquiry', 2, 'U02EFGH5678',
    '2026-04-30T12:45:00Z', 'tier1_60min', 'escalated', NULL,
    1, true, '0065e000003OppXYZ',
    true, false,
    '1714481100.000800', NULL);
```

---

## Cross-table relationships

```
                           reps (existing, beacon-loop)
                           id INTEGER PK
                              ▲
                              │ FK
                ┌─────────────┼──────────────────────┐
                │                                    │
   inbound_alerts.assigned_rep_id        inbound_tier1_leads_in_flight.assigned_rep_id
                │                                    │
                │                                    │
   ┌────────────────────────┐         ┌──────────────────────────────────────┐
   │     inbound_alerts     │         │  inbound_tier1_leads_in_flight (v2)  │
   │  id uuid PK            │         │  id uuid PK                          │
   │  account_id text  ─────┼──┐      │  account_id text                     │
   │  signal_event_ids      │  │      │  sfdc_lead_id text                   │
   │     uuid[] ─────────┐  │  │      └──────────────────────────────────────┘
   │  tier (tier1|tier2) │  │  │                  │
   │  state (hot|warm|   │  │  │                  │ NO direct reference between
   │         muted)      │  │  │                  │ inbound_alerts and the tier1
   └─────────────────────┼──┘  │                  │ table. Two parallel paths.
                         │     │                  │
                         │     │ join on account_id
                         │     ▼
                         │   ┌────────────────────────┐
                         └──▶│     signal_events      │
                             │  id uuid PK            │
                             │  account_id text       │
                             │  occurred_at timestamptz│
                             └────────────────────────┘
```

Relationships:

- `signal_events` is the raw account-level ledger. Keyed on
  `account_id` (text). It does not reference any other inbound table.
- `inbound_alerts.account_id` is the same `account_id` text key used
  in `signal_events`. The join is `inbound_alerts.account_id =
  signal_events.account_id`. No FK constraint; account IDs are
  external (synthetic, but treated as external CRM IDs) and may
  appear in `inbound_alerts` before any `signal_events` row exists.
- `inbound_alerts.signal_event_ids uuid[]` references `signal_events.id`
  by value, not by foreign key — Postgres cannot foreign-key into an
  array element. The synthesis pipeline is responsible for ensuring
  every uuid in the array exists in `signal_events`. The explain
  handler reads with `WHERE id = ANY (alert.signal_event_ids)`.
- `inbound_alerts.assigned_rep_id` and
  `inbound_tier1_leads_in_flight.assigned_rep_id` both `REFERENCES
  reps(id)` (integer). Both honor the same rep lookup that beacon-loop
  ships.
- `inbound_alerts` and `inbound_tier1_leads_in_flight` do **not**
  reference each other directly. They are two parallel alert paths:
  Tier 2 synthesis and Tier 1 SLA, coexisting under one project. A
  future cross-tier dashboard view can join on `account_id` if needed,
  but the schemas don't enforce a relationship.

---

## Open questions

1. **HOT thresholds in code vs in a config table.** Score thresholds
   (`score >= 80`, `first_party_points >= 15`, `signal_count >= 5`,
   `contact_count >= 3`, velocity multiplier triggered) currently live
   inside the n8n synthesis Code node. Whether to persist them in a
   `synthesis_config` table mirroring beacon-loop's `attribution_config`
   is deferred — out of scope for MIN-61. Decide before MIN-65.
2. **Referential integrity for `signal_event_ids`.** The
   `inbound_alerts.signal_event_ids uuid[]` design has no enforced FK.
   Whether to introduce a `inbound_alert_signal_events` join table
   (alert_id, signal_event_id) for stronger integrity is a v2.1
   question. Defer to MIN-64+.
3. **`mute_until` enforcement point.** Two valid interpretations:
   write-time (synthesis pipeline checks `inbound_alerts` for an
   active mute on the account and skips writing) or read-time
   (deliver workflow filters at write-to-Slack). Current bias is
   write-time so muted accounts don't accumulate unnecessary alert
   rows. Decision deferred to MIN-65.
4. **Whether `inbound_alerts.tier='tier1'` is ever written.** Tier 1
   has its own dedicated `inbound_tier1_leads_in_flight` table. The
   `tier` column on `inbound_alerts` reserves the option of unifying
   alert delivery later, but the v0 synthesis pipeline may only write
   `tier='tier2'` rows. Confirm during MIN-64.
