# Demo Runbook — M2 Tier 1 + SLA Monitor

End-to-end smoke test that proves the M2 milestone: a Chili Piper booking fires
the Tier 1 Demo Path, lands a row under SLA, and — when the SLA window expires
— the SLA Monitor escalates the row in Slack. A stranger should be able to
follow this top-to-bottom and reproduce it.

## Purpose

What this runbook proves:

1. **Tier 1 Demo Path** ([`UElhQ0juFRKMVP1W`](https://n8n.mindofhenry.xyz/workflow/UElhQ0juFRKMVP1W), MIN-39) accepts a Chili Piper `booking_created` payload, looks up the SFDC account, writes an `inbound_tier1_leads_in_flight` row, and DMs the assigned rep with a Block Kit alert.
2. **SLA Monitor** ([`JjpSFDnMo3FXYX96`](https://n8n.mindofhenry.xyz/workflow/JjpSFDnMo3FXYX96), MIN-40) detects breaches on a 5-minute cron and escalates in two stages — Stage 1 (60–120 min) posts to `#inbound-sla-breach`; Stage 2 (>120 min) DMs the manager and reassigns the lead to the backup rep.
3. **Slack Interactivity Router** ([`jYU3no70wwQrnMXW`](https://n8n.mindofhenry.xyz/workflow/jYU3no70wwQrnMXW), MIN-81) dispatches the Claim button click to the **SLA Claim Handler** ([`0M7Y3m7hBuGVPvLL`](https://n8n.mindofhenry.xyz/workflow/0M7Y3m7hBuGVPvLL), MIN-82), which authenticates the clicker, idempotency-checks the row, acknowledges the lead, edits the original alert in place (Claim button → CLAIMED status pill), and threads an audit reply.
4. The four workflows operate on the same row across its lifecycle without manual data fixup.

## Architecture

```
┌─────────────────────────┐                ┌─────────────────────────────┐
│ Chili Piper booking     │                │  SLA Monitor (MIN-40)       │
│ POST /webhook/tier1-demo│                │  Schedule: every 5 minutes  │
└──────────┬──────────────┘                └──────────────┬──────────────┘
           │                                              │
           ▼                                              ▼
┌─────────────────────────┐                ┌─────────────────────────────┐
│ Tier 1 Demo Path        │                │  Stage 1 (60–120 min):      │
│ (MIN-39, webhook)       │  ┌──────────►  │  → post to #inbound-sla-    │
│                         │  │             │    breach (C0B153QTCFQ)     │
│ - Lookup rep slack_id   │  │             │  → set breach_1_fired=true  │
│ - SFDC Account search   │  │             │                             │
│ - INSERT row            │  │             │  Stage 2 (>120 min):        │
│ - DM rep                │  │             │  → DM manager (rep 8)       │
│ - Write back slack_ts   │  │             │  → reassign to rep 2        │
└──────────┬──────────────┘  │             │  → set breach_2_fired=true  │
           │                 │             └─────────────────────────────┘
           ▼                 │
┌─────────────────────────┐  │
│ inbound_tier1_leads_    │──┘
│ in_flight (one row)     │
└─────────────────────────┘
```

The row in `inbound_tier1_leads_in_flight` is the shared state. Each workflow
reads/writes a different subset of its columns.

The Stage 1 alert posts a **Claim** button. Clicking it routes through the
single Slack interactivity URL → Router (MIN-81, dispatches by `action_id`)
→ SLA Claim Handler (MIN-82, internal-only webhook). The handler authenticates
the clicker against `reps.slack_id`, idempotency-checks `ack_status`, UPDATEs
the row to `acknowledged`, edits the original alert in place
(Claim button → `CLAIMED by <rep>` status pill), and posts a threaded ack.
A second click on the same row hits the `already_claimed` branch — ephemeral
toast only, no DB or message side effects.

## Pre-conditions

| Check | How |
|---|---|
| Tier 1 Demo Path active | `https://n8n.mindofhenry.xyz/workflow/UElhQ0juFRKMVP1W` toggle ON |
| SLA Monitor active | `https://n8n.mindofhenry.xyz/workflow/JjpSFDnMo3FXYX96` toggle ON |
| Slack Interactivity Router active | `https://n8n.mindofhenry.xyz/workflow/jYU3no70wwQrnMXW` toggle ON |
| SLA Claim Handler active | `https://n8n.mindofhenry.xyz/workflow/0M7Y3m7hBuGVPvLL` toggle ON |
| Supabase reachable | `psql $DATABASE_URL -c "select 1"` returns `1` |
| `inbound_tier1_leads_in_flight` exists | `\d inbound_tier1_leads_in_flight` returns the v2 schema (see [db/migrations/003_inbound_tier1_leads_v2.sql](../db/migrations/003_inbound_tier1_leads_v2.sql)) |
| `reps` table seeded with `slack_id` | `select id, name, slack_id from reps where id in (1,2,8)` returns 3 rows, all with non-null `slack_id` (see [db/migrations/004_reps_slack_id.sql](../db/migrations/004_reps_slack_id.sql)) |
| Channel `#inbound-sla-breach` exists | Channel ID `C0B153QTCFQ` |
| n8n Slack bot is a member of `#inbound-sla-breach` | **See gotcha below** |
| Slack creds bound | `Slack account` cred attached to the Slack nodes in both workflows |

### Gotcha: invite the bot to `#inbound-sla-breach`

The first MIN-40 manual execution fails with `not_in_channel` from the
`Post to SLA Breach Channel` Slack node. The bot must be invited manually:

1. Open `#inbound-sla-breach` in Slack.
2. Type `/invite @<your n8n bot user>` and submit.
3. Re-run the SLA Monitor workflow.

This only needs to happen once per channel. The bot doesn't need to be in
the rep DMs or the manager DM (those are user DMs, not channels — Slack
auto-opens them).

## Smoke test steps

The full sequence walks one row through three states: **fresh → Stage 1
breach → Stage 2 breach**. Each stage is achieved by time-traveling
`sla_start_time` backwards in SQL, then manually executing the SLA Monitor
from the n8n canvas.

### Step 1 — Fire the Tier 1 webhook

```powershell
.\scripts\fire-tier1-demo.ps1 `
  -AccountName "Orion Analytics" `
  -ContactEmail "rachel.kim@orionanalytics.io" `
  -ContactName "Rachel Kim" `
  -ContactTitle "VP Engineering"
```

**Expected output:** the script prints `==> SUCCESS` with `row_id` (UUID) and
`slack_ts`. Save the `row_id` — every step below references it.

**Expected DB state** (immediately after):

```sql
SELECT id, account_name, contact_email, ack_status,
       sla_start_time, breach_1_fired, breach_2_fired,
       escalation_stage, assigned_rep_id, slack_message_ts
FROM inbound_tier1_leads_in_flight
WHERE id = '<row_id>';
```

| column | value |
|---|---|
| `account_name` | `Orion Analytics` |
| `ack_status` | `pending` |
| `sla_start_time` | within last few seconds of `now()` |
| `breach_1_fired` | `false` |
| `breach_2_fired` | `false` |
| `escalation_stage` | `0` |
| `assigned_rep_id` | `1` (Marcus Webb) |
| `slack_message_ts` | non-null (Block Kit DM landed) |

**Expected Slack output:** Block Kit DM to Marcus Webb (Slack ID `U0ANRG80F2Q`)
with the booking summary and the four external launcher buttons.

### Step 2 — Time-travel to 65 minutes (Stage 1 breach)

```sql
UPDATE inbound_tier1_leads_in_flight
SET sla_start_time = now() - interval '65 minutes'
WHERE id = '<row_id>';
```

Then in the n8n canvas, open the SLA Monitor workflow and click
**Execute Workflow**. Don't wait for the cron — the manual click is faster
and deterministic.

**Expected DB state:**

| column | value |
|---|---|
| `breach_1_fired` | `true` |
| `breach_2_fired` | `false` (still — 65 min is in the 60–120 window) |
| `escalation_stage` | `0` (unchanged — Stage 1 only flips the flag) |
| `assigned_rep_id` | `1` (unchanged) |

**Expected Slack output:** Block Kit message in `#inbound-sla-breach`
(`C0B153QTCFQ`) with header `SLA BREACH - Stage 1 (60 min)`, account name,
contact name, assigned rep ID, elapsed minutes (~65), and a **Claim** button
(`action_id: sla_claim`).

### Step 3 — Click the Claim button (SLA Claim Handler)

In `#inbound-sla-breach`, click **Claim** on the Stage 1 alert.

**What fires:** Slack POSTs the interactivity payload to the router
(`/webhook/slack-interactivity`). The router dispatches `sla_claim` to the
SLA Claim Handler at `/webhook/internal/sla-claim`. The handler:

1. Looks up the clicker by `slack_id` in `reps`. Empty → `unauthorized` ephemeral, stop.
2. Looks up the lead. If `ack_status='acknowledged'` already → `already_claimed` ephemeral with the prior claimer's name + time, stop. (No DB or message side effects.)
3. Otherwise UPDATEs the lead, replaces the Claim-button row with a CLAIMED status block in the original message via `chat.update`, and posts a threaded acknowledgement.

**Expected DB state:**

| column | value |
|---|---|
| `ack_status` | `acknowledged` |
| `ack_time` | within last few seconds of `now()` (single timestamp — clicking again does not re-write) |
| `assigned_rep_id` | `1` if the clicker maps to rep 1; otherwise the clicker's rep ID |
| `breach_1_fired` | `true` (unchanged) |

**Expected Slack output:**

- Original alert is edited in place. Header, sections (Account/Contact/Rep/Elapsed), and footer context are all preserved. The `actions` row holding the Claim button is **replaced** by a context block: `:white_check_mark: *CLAIMED* by <Rep Name> at <local time>`.
- Threaded reply on the original alert: `<Rep Name> claimed this lead. Acknowledged.`

#### Idempotency check (optional)

Click the same (now-claimed) message a second time, or re-fire the same
Slack interactivity payload via curl. The handler hits its
`already_claimed` branch:

- Visible-only-to-the-clicker ephemeral: `Already claimed by <Rep Name> at <time>.`
- DB row unchanged (single `ack_time`).
- No new threaded reply.
- Original alert is not re-edited.

To replay this without a real button click — useful when scripting demos:

```powershell
# build the same Slack interactivity payload your alert would emit and POST
# form-encoded to /webhook/slack-interactivity. The handler looks up the
# clicker by user.id (their Slack ID) and the lead by actions[0].value.
```

### Step 4 — Time-travel to 125 minutes (Stage 2 breach)

> **Note:** to drive Step 4, the row must be back in `ack_status='pending'`.
> Step 3 leaves it `acknowledged`, so reset it first:
> ```sql
> UPDATE inbound_tier1_leads_in_flight
> SET ack_status = 'pending', ack_time = NULL
> WHERE id = '<row_id>';
> ```

```sql
UPDATE inbound_tier1_leads_in_flight
SET sla_start_time = now() - interval '125 minutes'
WHERE id = '<row_id>';
```

Open the SLA Monitor workflow in n8n and click **Execute Workflow** again.

**Expected DB state:**

| column | value |
|---|---|
| `breach_1_fired` | `true` (unchanged from Step 2) |
| `breach_2_fired` | `true` |
| `escalation_stage` | `2` (integer, meaning "stage-2 reassigned") |
| `assigned_rep_id` | `2` (Priya Nair — reassigned from Marcus Webb) |

**Expected Slack output:** DM to Ryan Torres (manager, rep 8) with
`*SLA BREACH - Stage 2 (120+ min)*`, account name, contact name, original
rep ID (1), reassigned rep ID (2), elapsed minutes (~125), and the lead UUID.

## Expected outputs (full summary)

| Stage | Channel/Recipient | Content |
|---|---|---|
| Step 1 (booking) | DM to rep 1 (Marcus Webb, `U0ANRG80F2Q`) | Block Kit booking alert with launcher buttons |
| Step 2 (Stage 1) | `#inbound-sla-breach` (`C0B153QTCFQ`) | Block Kit `SLA BREACH - Stage 1 (60 min)` with Claim button |
| Step 3 (claim) | `#inbound-sla-breach` — original alert edited + threaded reply | Claim row → `:white_check_mark: *CLAIMED* by <rep> at <time>` context; thread: `<rep> claimed this lead. Acknowledged.` |
| Step 4 (Stage 2) | DM to rep 8 (Ryan Torres, manager) | Plain-text manager DM with reassignment summary |

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Post to SLA Breach Channel` errors `not_in_channel` | n8n Slack bot is not a member of `#inbound-sla-breach` | Invite the bot via `/invite @<bot>` in the channel; re-execute |
| Step 1 DM doesn't land but row inserts cleanly | rep 1 has NULL `slack_id` in `reps` | `select id, slack_id from reps where id = 1` — re-seed via [db/migrations/004_reps_slack_id.sql](../db/migrations/004_reps_slack_id.sql) |
| Step 3 manager DM doesn't land but `breach_2_fired` flips and `assigned_rep_id` updates | rep 8 has NULL `slack_id` — DM skipped intentionally; `continueOnFail: true` lets the UPDATE run anyway | Not a bug. This is the post-MIN-86 migration behavior — DM is best-effort, DB write is authoritative. To restore the DM, `update reps set slack_id = '<U…>' where id = 8` |
| Step 2 fires but Step 3 reassigns nothing | Step 3 SQL not run, or `breach_2_fired` already `true` from a prior run | Re-run the time-travel UPDATE; confirm `breach_2_fired = false` before clicking Execute |
| Manual execute on SLA Monitor returns 0 rows on Query A or Query B | The row's `ack_status` was changed (e.g. claimed) or `sla_start_time` is outside the window | `select ack_status, sla_start_time, breach_1_fired, breach_2_fired from inbound_tier1_leads_in_flight where id = '<row_id>'`; reset per [Cleanup](#cleanup) |
| Tier 1 webhook returns 404 | Workflow inactive | Toggle on at `/workflow/UElhQ0juFRKMVP1W` |
| Tier 1 webhook returns 200 but no row | Postgres cred missing on the INSERT node | n8n canvas → INSERT node → credentials |
| Stage 1 alert lands but renders as plain text (no header/sections/Claim button) | `blocksUi` got a bare JSON-stringified array instead of `JSON.stringify({ blocks: [...] })`. Slack node v2.4 reads `.blocks` off the parsed object; a bare array yields `.blocks === undefined` and Slack drops the field silently. | Fix the Code node feeding the Slack node to wrap in `{ blocks: [...] }` before stringifying. |
| Click Claim → ephemeral "This button isn't wired up yet." | Router missing the `sla_claim` case, or it is pointing at a stale internal path | Verify `jYU3no70wwQrnMXW` Switch by action_id has a `sla_claim` case forwarding to `https://n8n.mindofhenry.xyz/webhook/internal/sla-claim`, and the router is published. |
| Click Claim → DB updates but original message becomes plain text (blocks wiped) | Same bug as above on `Update Original Message` (chat.update). The Build Updated Blocks Code node must return `JSON.stringify({ blocks: rebuilt })`, not `JSON.stringify(rebuilt)`. | See [n8n/workflows/sla-claim-handler.min82-create.js](../n8n/workflows/sla-claim-handler.min82-create.js) `BUILD_BLOCKS_CODE`. |
| Click Claim → ephemeral "Only registered reps can claim" | The clicker's Slack user ID is not in `reps.slack_id` | `INSERT INTO reps (id, name, slack_id) VALUES (...)` or update an existing row to map the clicker. |

## Cleanup

To re-run the full sequence on the same row:

```sql
UPDATE inbound_tier1_leads_in_flight
SET sla_start_time   = now(),
    breach_1_fired   = false,
    breach_2_fired   = false,
    escalation_stage = 0,
    assigned_rep_id  = 1,
    ack_status       = 'pending',
    ack_time         = NULL
WHERE id = '<row_id>';
```

To delete the test row entirely:

```sql
DELETE FROM inbound_tier1_leads_in_flight WHERE id = '<row_id>';
```

Or, to wipe all Tier 1 SLA state (synthetic data only — see CLAUDE.md
hard rules):

```sql
DELETE FROM inbound_tier1_leads_in_flight;
```

The Slack messages from prior runs persist in their channels/DMs. They are
synthetic by design and safe to leave. Manually delete them if desired.
