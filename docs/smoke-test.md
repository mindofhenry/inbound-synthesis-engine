# Smoke Test — Inbound Synthesis Engine

End-to-end verification that the WF1 (Account Alerts) → WF2 (Explain Callback) flow produces a HOT alert and a grounded score explanation against real Supabase data. Uses the `orion-analytics` synthetic fixture.

## Pre-flight

| Check | How |
|---|---|
| Supabase reachable | `psql $DATABASE_URL -c "select 1"` returns `1` |
| `signal_events` populated for orion-analytics | `select count(*) from signal_events where account_id = 'orion-analytics'` returns 7 |
| n8n WF1 active | `https://n8n.mindofhenry.xyz/workflow/3378kEby9ZyhzIOk` shows toggle ON |
| n8n WF2 active | `https://n8n.mindofhenry.xyz/workflow/yU1s6WS1N7vvgEGO` shows toggle ON |
| Slack creds bound | `Slack account` cred attached to Send-a-message in both WF1 and WF2 |
| Anthropic cred bound | `anthropicApi` cred attached to Claude Synthesis in WF2 |
| Velocity window in range | `select max(occurred_at) from signal_events where account_id = 'orion-analytics'` is within 24h of now |

If the velocity check fails, see [Reset](#reset) before firing.

## Fire sequence

### 1. POST to WF1 webhook
```bash
curl -X POST https://n8n.mindofhenry.xyz/webhook/synthesis-ingest \
  -H 'Content-Type: application/json' \
  -d '{"account_id":"orion-analytics"}'
```
Returns 200 with the synthesis payload as JSON. Latency ~2-4s.

### 2. Expected Slack DM (to Henry, U0ANRG80F2Q)
- Header: `Orion Analytics  ·  score 100/100`
- State line: `HOT · buying committee forming`
- Committee: `VP Engineering · Analytics Lead · Ops Lead`
- Best contact: `Rachel Kim (VP Engineering)`
- Signals: `5 first-party · 2 third-party`
- Velocity: `6 signals in 7d`
- Buttons: Outreach, Account Intel, Sales Nav, Salesforce, **Explain this score**

### 3. Expected `inbound_alerts` row
```sql
select id, score, state, signal_count, contact_count, first_party_points, score_breakdown
from inbound_alerts
where account_id = 'orion-analytics'
order by delivered_at desc
limit 1;
```
Returns: `score=100`, `state='hot'`, `signal_count=7`, `contact_count=3`, `first_party_points=89`. `score_breakdown` jsonb contains `raw_score=99`, `composition_bonus=10`, `velocity_triggered=true`, `velocity_recent_signals=6`, `first_party_score=89`, `third_party_score=10`.

### 4. Click "Explain this score" in Slack
WF2 fires. Latency ~3-6s (Claude Haiku call).

### 5. Expected threaded reply
- Header: `Scoring breakdown: Orion Analytics`
- 4-paragraph Claude explanation citing each signal with timestamp, the velocity trigger, the committee composition, and why Rachel Kim is the entry point.
- Signal ledger: 7 rows, each `• <event_type> — <N>d ago — <points> pts (— <repeat>x repeat) — <contact_id>`.

## Expected scoring values (orion-analytics fixture)

| field | value |
|---|---|
| `final_score` | 100 |
| `raw_score` | 99 |
| `first_party_score` | 89 |
| `third_party_score` | 10 (capped) |
| `velocity_triggered` | true |
| `velocity_recent_signals` | 6 |
| `composition_bonus` | 10 |
| `distinct_contacts` | 3 |
| `state` | hot / HOT |
| best contact | Rachel Kim, VP Engineering, decision_maker |

## Failure modes

| Symptom | Likely cause | First place to look |
|---|---|---|
| `curl` returns 404 | WF1 inactive | Toggle on at `/workflow/3378kEby9ZyhzIOk` |
| `curl` returns 200 but no Slack DM | Slack cred missing on Send-a-message | WF1 canvas → Send-a-message → credentials |
| Slack DM lands but state=WARM, score < 80 | Velocity window rolled past | [Reset](#reset) |
| Score=100 but committee size=2 | One contact's signals fell outside 30d window | check `select count(distinct person_id) from signal_events where account_id='orion-analytics' and occurred_at >= now() - interval '30 days'` |
| `inbound_alerts` row not written | Postgres cred missing on Write-inbound_alerts | WF1 canvas → Write inbound_alerts Row → credentials |
| Explain button does nothing | WF2 inactive, or Slack app interactivity URL not pointed at `/webhook/explain-score` | n8n WF2 toggle, then Slack app config → Interactivity & Shortcuts |
| Threaded reply errors `channel_not_found` | Channel ID in payload isn't a real DM the bot is in | Open the bot DM first; or fire from a real Slack click |
| Threaded reply errors `invalid_auth` | Anthropic cred missing | WF2 canvas → Claude Synthesis → credentials |
| Reply lands but text references contacts that don't exist | Code cache not refreshed | Re-save the Build Scoring Payload + Score node |

## Reset

If `select max(occurred_at) from signal_events where account_id = 'orion-analytics'` is more than ~24h old, the velocity window has rolled past and the run will produce WARM. Re-shift timestamps:

```sql
UPDATE signal_events SET occurred_at = CASE event_id
  WHEN '66c22809-...' THEN now() - interval '2 hours'   -- pricing_page (orion-001) → days_ago 0
  WHEN 'd47e15e0-...' THEN now() - interval '1 day'     -- docs_page (orion-002)
  WHEN 'b8571314-...' THEN now() - interval '3 days'    -- bombora_surge
  WHEN '3da5b7dc-...' THEN now() - interval '6 days'    -- pricing_page baseline (orion-001)
  -- e3a69b4d…, a5812b24…, 220a16ce… already in window; leave alone
END
WHERE account_id = 'orion-analytics'
  AND event_id IN ('66c22809-...','d47e15e0-...','b8571314-...','3da5b7dc-...');
```

Replace the truncated UUIDs with the live `event_id` values from the table. After the update, re-query `select count(*) from signal_events where account_id='orion-analytics' and occurred_at >= now() - interval '7 days'` — must be ≥ 5 for velocity to trigger.

Then optionally clear prior alert rows:
```sql
DELETE FROM inbound_alerts WHERE account_id = 'orion-analytics';
```

Re-run the fire sequence.
