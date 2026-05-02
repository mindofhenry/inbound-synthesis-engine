# Architecture

End-to-end map of the Inbound Synthesis Engine. Seven n8n workflows fan out
from a single Slack interactivity URL and a small set of Postgres tables in
the shared Beacon Supabase project.

## System diagram

```mermaid
flowchart TB
    %% ============ External signal sources ============
    subgraph SOURCES["Signal sources (synthetic)"]
        direction LR
        MARKETO[Marketo<br/>form fills]
        SIXSENSE[6sense<br/>intent surge]
        BOMBORA[Bombora<br/>topic spike]
        WARMLY[Warmly<br/>visitor ID]
        SFDC[Salesforce<br/>account &amp; opp]
        CHILI[Chili Piper<br/>Tier 1 booking]
    end

    %% ============ Storage ============
    subgraph DB["Supabase Postgres (Beacon project)"]
        direction LR
        T_SIG[(signal_events)]
        T_ALERT[(inbound_alerts)]
        T_T1[(inbound_tier1_leads_in_flight)]
        T_REPS[(reps)]
    end

    %% ============ WF1: Account Alerts ============
    subgraph WF1["WF1 — Account Alerts (3378kEby9ZyhzIOk)"]
        direction TB
        WF1_IN[Webhook in]
        WF1_CTX[Set Company Context]
        WF1_Q[Query Signal Events]
        WF1_TX[Transform]
        WF1_SCORE[Score + Pick Contact]
        WF1_SYN[Synthesize Alert Blurb<br/>Claude Haiku]
        WF1_WR[Write inbound_alerts]
        WF1_DM[Send DM to Rep]
        WF1_IN --> WF1_CTX --> WF1_Q --> WF1_TX --> WF1_SCORE --> WF1_SYN --> WF1_WR --> WF1_DM
    end

    %% ============ WF3: Tier 1 Demo Path ============
    subgraph WF3["WF3 — Tier 1 Demo Path (UElhQ0juFRKMVP1W)"]
        direction TB
        WF3_IN[Webhook<br/>/tier1-demo]
        WF3_PARSE[Parse Chili Piper]
        WF3_SFDC[SFDC Account Lookup]
        WF3_BUILD[Build Blocks]
        WF3_INS[Insert tier1_leads_in_flight]
        WF3_LOOK[Lookup Rep Slack ID]
        WF3_DM[Send DM to Rep]
        WF3_TS[Write Back Slack TS]
        WF3_IN --> WF3_PARSE --> WF3_SFDC --> WF3_BUILD --> WF3_INS --> WF3_LOOK --> WF3_DM --> WF3_TS
    end

    %% ============ WF4: SLA Monitor ============
    subgraph WF4["WF4 — SLA Monitor (JjpSFDnMo3FXYX96)"]
        direction TB
        WF4_CRON[Cron every 5 min]
        WF4_CONST[Define Constants]
        WF4_B1Q[Query 60-min breaches]
        WF4_B1MSG[Build B1 Blocks]
        WF4_B1POST[Post #inbound-sla-breach<br/>Claim button]
        WF4_B1UPD[Update breach_1_fired]
        WF4_B2Q[Query 120-min breaches]
        WF4_LOOK[Lookup Rep Slack IDs]
        WF4_B2MSG[Build B2 Manager DM]
        WF4_DM[DM Manager]
        WF4_B2UPD[Update reassign +<br/>escalation_stage=2]
        WF4_CRON --> WF4_CONST
        WF4_CONST --> WF4_B1Q --> WF4_B1MSG --> WF4_B1POST --> WF4_B1UPD
        WF4_CONST --> WF4_B2Q --> WF4_LOOK --> WF4_B2MSG --> WF4_DM --> WF4_B2UPD
    end

    %% ============ WF6: Router ============
    subgraph WF6["WF6 — Slack Interactivity Router (jYU3no70wwQrnMXW)"]
        direction TB
        WF6_IN[Webhook<br/>/slack-interactivity]
        WF6_PARSE[Parse Slack Payload]
        WF6_SW{Switch by action_id}
        WF6_FB[Fallback Ephemeral]
        WF6_IN --> WF6_PARSE --> WF6_SW
        WF6_SW -- explain_score --> WF2_IN
        WF6_SW -- show_contact_details --> WF5_IN
        WF6_SW -- sla_claim --> WF7_IN
        WF6_SW -- other --> WF6_FB
    end

    %% ============ WF2: Explain Callback ============
    subgraph WF2["WF2 — Explain Callback (yU1s6WS1N7vvgEGO)"]
        direction TB
        WF2_IN[Webhook<br/>/internal/explain-score]
        WF2_PARSE[Parse Payload]
        WF2_QA[Query Alert + Events]
        WF2_SYN[Claude Synthesis<br/>buying-stage blurb]
        WF2_POST[chat.postEphemeral<br/>threaded]
        WF2_IN --> WF2_PARSE --> WF2_QA --> WF2_SYN --> WF2_POST
    end

    %% ============ WF5: Contact Details ============
    subgraph WF5["WF5 — Contact Details Callback (P0bOfQyk525cjnQK)"]
        direction TB
        WF5_IN[Webhook<br/>/internal/contact-details]
        WF5_PARSE[Parse Payload]
        WF5_Q[Query Signal Events 30d]
        WF5_FMT[Identify Primary +<br/>Format Secondaries]
        WF5_POST[chat.postEphemeral<br/>threaded]
        WF5_IN --> WF5_PARSE --> WF5_Q --> WF5_FMT --> WF5_POST
    end

    %% ============ WF7: SLA Claim Handler ============
    subgraph WF7["WF7 — SLA Claim Handler (0M7Y3m7hBuGVPvLL)"]
        direction TB
        WF7_IN[Webhook<br/>/internal/sla-claim]
        WF7_PARSE[Parse Payload]
        WF7_LOOK[Lookup Lead State<br/>LEFT JOIN reps]
        WF7_DEC[Decide Outcome]
        WF7_SW{Switch}
        WF7_UPD[Update ack_status=acknowledged]
        WF7_EDIT[chat.update<br/>replace actions block]
        WF7_THR[Post Threaded Ack]
        WF7_EPH1[Already Claimed<br/>Ephemeral]
        WF7_EPH2[Unauthorized<br/>Ephemeral]
        WF7_IN --> WF7_PARSE --> WF7_LOOK --> WF7_DEC --> WF7_SW
        WF7_SW -- claim_ok --> WF7_UPD --> WF7_EDIT --> WF7_THR
        WF7_SW -- already_claimed --> WF7_EPH1
        WF7_SW -- unauthorized --> WF7_EPH2
    end

    %% ============ Signal flow ============
    SOURCES -. capture .-> T_SIG
    T_SIG --> WF1_Q
    WF1_WR --> T_ALERT

    %% ============ Tier 1 path ============
    CHILI -- HOT booking --> WF3_IN
    SFDC -. lookup .-> WF3_SFDC
    WF3_INS --> T_T1
    WF3_LOOK --> T_REPS
    WF3_TS --> T_T1

    %% ============ SLA monitor reads/writes ============
    T_T1 --> WF4_B1Q
    T_T1 --> WF4_B2Q
    WF4_LOOK --> T_REPS
    WF4_B1UPD --> T_T1
    WF4_B2UPD --> T_T1

    %% ============ Slack interactivity ============
    SLACK([Slack workspace<br/>buttons + DMs]) -- button click --> WF6_IN
    WF1_DM --> SLACK
    WF3_DM --> SLACK
    WF4_B1POST --> SLACK
    WF4_DM --> SLACK
    WF2_POST --> SLACK
    WF5_POST --> SLACK
    WF7_EDIT --> SLACK
    WF7_THR --> SLACK
    WF7_EPH1 --> SLACK
    WF7_EPH2 --> SLACK

    %% ============ WF7 reads/writes ============
    WF7_LOOK --> T_T1
    WF7_LOOK --> T_REPS
    WF7_UPD --> T_T1

    %% ============ WF2/WF5 reads ============
    WF2_QA --> T_ALERT
    WF2_QA --> T_SIG
    WF5_Q --> T_SIG
```

## Conventions

- **One Slack interactivity URL.** All buttons post to `/webhook/slack-interactivity` (WF6). The router dispatches to the correct internal handler by `action_id`. Adding a fourth callback is a new Switch case, not a new Slack app config.
- **Internal webhooks are unauthenticated by design** — only the router calls them, and they live behind the same hostname.
- **All DB writes go through the service-role key.** No per-user RLS; this is a single-tenant demo.
- **Block Kit `blocksUi` must be `JSON.stringify({ blocks: [...] })`**, not a bare stringified array. Slack node v2.4 silently drops the field otherwise.

## Workflow IDs at a glance

| WF | Name | ID |
|---|---|---|
| WF1 | Account Alerts | `3378kEby9ZyhzIOk` |
| WF2 | Explain Callback | `yU1s6WS1N7vvgEGO` |
| WF3 | Tier 1 Demo Path | `UElhQ0juFRKMVP1W` |
| WF4 | SLA Monitor | `JjpSFDnMo3FXYX96` |
| WF5 | Contact Details Callback | `P0bOfQyk525cjnQK` |
| WF6 | Slack Interactivity Router | `jYU3no70wwQrnMXW` |
| WF7 | SLA Claim Handler | `0M7Y3m7hBuGVPvLL` |
