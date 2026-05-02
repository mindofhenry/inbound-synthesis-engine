import { workflow, node, trigger, newCredential, expr } from '@n8n/workflow-sdk';

// ============================================================================
// MIN-40 — Inbound Synthesis - SLA Monitor
//
// Trigger: Schedule, every 5 minutes.
//
// Architecture: fan-out from "Define Constants" into two parallel chains.
//
// Chain 1 — Stage 1 (60-120 min breach):
//   Schedule Trigger → Define Constants → Query A Breach 1
//   → Build B1 Message → Post to SLA Breach Channel → Update Breach 1 Fired
//
// Chain 2 — Stage 2 (>120 min breach), parallel from Define Constants:
//   Define Constants → Lookup Rep Slack IDs → Query B Breach 2
//   → Build B2 Manager DM → DM Manager → Update B2 Reassign
//
// Notes:
//   - BACKUP_REP_ID = 2 (Priya Nair, sdr); MANAGER_REP_ID = 8 (Ryan Torres, manager)
//   - manager_slack_id and backup_slack_id resolved via DB lookup from reps table
//   - escalation_stage = 2 (integer). Prompt said 'reassigned'; column is integer
//     (default 0). Using 2 = stage-2 escalated. No migration needed.
//   - Claim button (action_id: 'sla_claim') is a v1 placeholder — no handler yet.
//   - DM runs before UPDATE in breach-2 chain so DM can reference $json directly.
//
// Credentials:
//   "Beacon Supabase Postgres"  (postgres)
//   "Slack account"             (slackApi)
// ============================================================================

// ---------------------------------------------------------------------------
// Code node 2: Define Constants — single source of truth for rep IDs + channel
// ---------------------------------------------------------------------------
const DEFINE_CONSTANTS_CODE = `
// BACKUP_REP_ID = 2 (Priya Nair, sdr); MANAGER_REP_ID = 8 (Ryan Torres, manager).
// Slack IDs are resolved via DB lookup in "Lookup Rep Slack IDs" node (breach-2 chain).
const BACKUP_REP_ID = 2;
const MANAGER_REP_ID = 8;
const SLA_BREACH_CHANNEL_ID = 'C0B153QTCFQ';

return [{
  backupRepId: BACKUP_REP_ID,
  managerRepId: MANAGER_REP_ID,
  slaBreachChannelId: SLA_BREACH_CHANNEL_ID
}];
`;

// ---------------------------------------------------------------------------
// Code node 4: Build B1 Message — per breach-1 row (runOnceForEachItem)
// Builds Slack Block Kit per pending lead in the 60-120 min window.
// Passes sla_breach_channel_id through so Post node uses $json, not a cross-ref.
// ---------------------------------------------------------------------------
const BUILD_B1_CODE = `
const row = $input.item.json;
const consts = $('Define Constants').first().json;

const minutesElapsed = Math.round(parseFloat(String(row.minutes_elapsed)) || 0);
const accountName = String(row.account_name || 'Unknown Account');
const contactName = String(row.contact_name || 'Unknown Contact');
const repId = row.assigned_rep_id != null ? String(row.assigned_rep_id) : 'unassigned';

const blocks = [
  {
    type: 'header',
    text: { type: 'plain_text', text: 'SLA BREACH - Stage 1 (60 min)', emoji: false }
  },
  {
    type: 'section',
    fields: [
      { type: 'mrkdwn', text: '*Account:*\\n' + accountName },
      { type: 'mrkdwn', text: '*Contact:*\\n' + contactName }
    ]
  },
  {
    type: 'section',
    fields: [
      { type: 'mrkdwn', text: '*Assigned Rep:*\\nID ' + repId },
      { type: 'mrkdwn', text: '*Elapsed:*\\n' + minutesElapsed + ' min' }
    ]
  },
  {
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Claim', emoji: false },
        style: 'primary',
        action_id: 'sla_claim',
        value: String(row.id)
      }
    ]
  },
  {
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: 'Lead ID: ' + row.id + ' | Stage 1 breach | sla_claim handler not yet wired (v1 placeholder)'
      }
    ]
  }
];

return {
  json: {
    lead_id: String(row.id),
    account_name: accountName,
    contact_name: contactName,
    assigned_rep_id: repId,
    minutes_elapsed: minutesElapsed,
    sla_breach_channel_id: String(consts.slaBreachChannelId),
    blocks: blocks
  }
};
`;

// ---------------------------------------------------------------------------
// Code node 9: Build B2 Manager DM — per breach-2 row (runOnceForEachItem)
// Resolves manager_slack_id from the Lookup Rep Slack IDs result (upstream in chain).
// Passes backup_rep_id and manager_slack_id through so DM Manager uses $json directly.
// ---------------------------------------------------------------------------
const BUILD_B2_CODE = `
const row = $input.item.json;
const consts = $('Define Constants').first().json;

// Resolve manager_slack_id from DB lookup; console.log if null so DM failure is visible in logs
const repRows = $('Lookup Rep Slack IDs').all();
const managerRep = repRows.find(function(r) { return Number(r.json.id) === Number(consts.managerRepId); });
const managerSlackId = managerRep ? (managerRep.json.slack_id || null) : null;
if (!managerSlackId) {
  console.log('Lookup Rep Slack IDs: no slack_id for manager rep ' + consts.managerRepId + ' — DM will fail gracefully (continueOnFail=true)');
}

const minutesElapsed = Math.round(parseFloat(String(row.minutes_elapsed)) || 0);
const accountName = String(row.account_name || 'Unknown Account');
const contactName = String(row.contact_name || 'Unknown Contact');
const originalRepId = row.assigned_rep_id != null ? String(row.assigned_rep_id) : 'unassigned';

const dmText = [
  '*SLA BREACH - Stage 2 (120+ min)*',
  '*Account:* ' + accountName,
  '*Contact:* ' + contactName,
  '*Original Rep ID:* ' + originalRepId + '  →  Reassigned to Rep ID: ' + consts.backupRepId,
  '*Elapsed:* ' + minutesElapsed + ' min',
  '*Lead ID:* ' + row.id
].join('\\n');

return {
  json: {
    lead_id: String(row.id),
    account_name: accountName,
    contact_name: contactName,
    original_rep_id: originalRepId,
    minutes_elapsed: minutesElapsed,
    dm_text: dmText,
    backup_rep_id: consts.backupRepId,
    manager_slack_id: managerSlackId ? String(managerSlackId) : ''
  }
};
`;

// ---------------------------------------------------------------------------
// Sticky notes
// ---------------------------------------------------------------------------
const stickySchedule = node({
  type: 'n8n-nodes-base.stickyNote',
  version: 1,
  config: {
    name: 'Sticky Schedule',
    parameters: {
      content: "**Schedule Trigger**\nFires every 5 minutes.\nChecks both breach windows on each tick.\nWorkflow is INACTIVE by design — MIN-67 covers activation + smoke test.",
      height: 100,
      width: 300,
      color: 4
    },
    position: [240, 60]
  }
});

const stickyConstants = node({
  type: 'n8n-nodes-base.stickyNote',
  version: 1,
  config: {
    name: 'Sticky Constants',
    parameters: {
      content: "**Constants — rep IDs + channel**\nBACKUP_REP_ID = 2 (Priya Nair, sdr).\nMANAGER_REP_ID = 8 (Ryan Torres, manager).\nSlack IDs resolved via DB lookup in breach-2 chain (Lookup Rep Slack IDs node).",
      height: 120,
      width: 420,
      color: 4
    },
    position: [480, 60]
  }
});

const stickyBreach1 = node({
  type: 'n8n-nodes-base.stickyNote',
  version: 1,
  config: {
    name: 'Sticky Breach 1',
    parameters: {
      content: "**Stage 1 — Social Enforcement (60-120 min)**\nSELECT pending leads in 60-120 min window, breach_1_fired = false.\nFor each: post Block Kit to #inbound-sla-breach with Claim button (action_id: sla_claim — v1 placeholder, handler wired in follow-up).\nThen UPDATE breach_1_fired = true.",
      height: 120,
      width: 520,
      color: 4
    },
    position: [960, 60]
  }
});

const stickyBreach2 = node({
  type: 'n8n-nodes-base.stickyNote',
  version: 1,
  config: {
    name: 'Sticky Breach 2',
    parameters: {
      content: "**Stage 2 — Technical Enforcement (120+ min)**\nLookup Rep Slack IDs: SELECT id, slack_id FROM reps WHERE id IN (backupRepId, managerRepId).\nSELECT pending leads >120 min, breach_2_fired = false.\nFor each: DM manager (slack_id from DB lookup), then UPDATE assigned_rep_id = 2, escalation_stage = 2, breach_2_fired = true.\nescalation_stage column is integer: 0=none, 2=stage-2 reassigned.",
      height: 160,
      width: 760,
      color: 4
    },
    position: [720, 580]
  }
});

// ---------------------------------------------------------------------------
// Node 1: Schedule Trigger — every 5 minutes
// ---------------------------------------------------------------------------
const scheduleTrigger = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.3,
  config: {
    name: 'Every 5 Minutes',
    parameters: {
      rule: {
        interval: [{
          field: 'minutes',
          minutesInterval: 5
        }]
      }
    },
    position: [240, 320]
  },
  output: [{}]
});

// ---------------------------------------------------------------------------
// Node 2: Define Constants
// ---------------------------------------------------------------------------
const defineConstants = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Define Constants',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: DEFINE_CONSTANTS_CODE
    },
    position: [480, 320]
  },
  output: [{
    backupRepId: 2,
    managerRepId: 8,
    slaBreachChannelId: 'C0B153QTCFQ'
  }]
});

// ---------------------------------------------------------------------------
// Node 3: Query A — Breach 1 (60-120 min, breach_1_fired = false)
// No alwaysOutputData: 0 rows terminates chain gracefully (correct — no action needed).
// ---------------------------------------------------------------------------
const queryABreach1 = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Query A Breach 1',
    parameters: {
      operation: 'executeQuery',
      query: `SELECT id, account_name, contact_name, contact_email, contact_title, assigned_rep_id,
  ROUND(EXTRACT(EPOCH FROM (now() - sla_start_time)) / 60) AS minutes_elapsed
FROM inbound_tier1_leads_in_flight
WHERE ack_status = 'pending'
  AND sla_start_time < now() - interval '60 minutes'
  AND sla_start_time >= now() - interval '120 minutes'
  AND breach_1_fired = false`
    },
    credentials: {
      postgres: newCredential('Beacon Supabase Postgres')
    },
    position: [720, 180]
  },
  output: [{
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    account_name: 'Acme Corp',
    contact_name: 'Jane Smith',
    contact_email: 'jane@acme.com',
    contact_title: 'VP Sales',
    assigned_rep_id: 1,
    minutes_elapsed: '75'
  }]
});

// ---------------------------------------------------------------------------
// Node 4: Build B1 Message (per breach-1 row)
// ---------------------------------------------------------------------------
const buildB1Message = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build B1 Message',
    parameters: {
      mode: 'runOnceForEachItem',
      jsCode: BUILD_B1_CODE
    },
    position: [960, 180]
  },
  output: [{
    lead_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    account_name: 'Acme Corp',
    contact_name: 'Jane Smith',
    assigned_rep_id: '1',
    minutes_elapsed: 75,
    sla_breach_channel_id: 'C0B153QTCFQ',
    blocks: []
  }]
});

// ---------------------------------------------------------------------------
// Node 5: Post to SLA Breach Channel
// ---------------------------------------------------------------------------
const postChannelB1 = node({
  type: 'n8n-nodes-base.slack',
  version: 2.4,
  config: {
    name: 'Post to SLA Breach Channel',
    parameters: {
      resource: 'message',
      operation: 'post',
      authentication: 'accessToken',
      select: 'channel',
      channelId: {
        __rl: true,
        mode: 'id',
        value: expr("{{ $json.sla_breach_channel_id }}")
      },
      messageType: 'block',
      text: expr("SLA Breach Stage 1: {{ $json.account_name }}"),
      blocksUi: expr("{{ JSON.stringify({ blocks: $json.blocks }) }}"),
      otherOptions: {
        includeLinkToWorkflow: false
      }
    },
    credentials: {
      slackApi: newCredential('Slack account')
    },
    position: [1200, 180]
  },
  output: [{
    ok: true,
    channel: 'C0B153QTCFQ',
    message: { ts: '1746100000.000001', type: 'message' },
    message_timestamp: '1746100000.000001'
  }]
});

// ---------------------------------------------------------------------------
// Node 6: Update Breach 1 Fired
// References Build B1 Message by name for lead_id (current item is Slack output).
// ---------------------------------------------------------------------------
const updateB1Fired = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Update Breach 1 Fired',
    parameters: {
      operation: 'executeQuery',
      query: `UPDATE inbound_tier1_leads_in_flight
SET breach_1_fired = true
WHERE id = '{{ $("Build B1 Message").item.json.lead_id }}'::uuid
RETURNING id, breach_1_fired`
    },
    credentials: {
      postgres: newCredential('Beacon Supabase Postgres')
    },
    position: [1440, 180]
  },
  output: [{
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    breach_1_fired: true
  }]
});

// ---------------------------------------------------------------------------
// Node 7: Lookup Rep Slack IDs — fetches slack_id for backup rep + manager
// Inserted between Define Constants and Query B Breach 2 in the breach-2 chain.
// ---------------------------------------------------------------------------
const lookupRepSlackIds = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Lookup Rep Slack IDs',
    parameters: {
      operation: 'executeQuery',
      query: `SELECT id, slack_id FROM reps WHERE id IN ({{ $('Define Constants').first().json.backupRepId }}, {{ $('Define Constants').first().json.managerRepId }})`
    },
    credentials: {
      postgres: newCredential('Beacon Supabase Postgres')
    },
    position: [720, 460]
  },
  output: [
    { id: 2, slack_id: 'U0ANRG80F2Q' },
    { id: 8, slack_id: 'U0ANRG80F2Q' }
  ]
});

// ---------------------------------------------------------------------------
// Node 8: Query B — Breach 2 (>120 min, breach_2_fired = false)
// No alwaysOutputData: 0 rows terminates chain gracefully (correct — no action needed).
// ---------------------------------------------------------------------------
const queryBBreach2 = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Query B Breach 2',
    parameters: {
      operation: 'executeQuery',
      query: `SELECT id, account_name, contact_name, contact_email, contact_title, assigned_rep_id,
  ROUND(EXTRACT(EPOCH FROM (now() - sla_start_time)) / 60) AS minutes_elapsed
FROM inbound_tier1_leads_in_flight
WHERE ack_status = 'pending'
  AND sla_start_time < now() - interval '120 minutes'
  AND breach_2_fired = false`
    },
    credentials: {
      postgres: newCredential('Beacon Supabase Postgres')
    },
    position: [960, 460]
  },
  output: [{
    id: 'ffffffff-gggg-hhhh-iiii-jjjjjjjjjjjj',
    account_name: 'Beta Industries',
    contact_name: 'John Doe',
    contact_email: 'john@beta.com',
    contact_title: 'CTO',
    assigned_rep_id: 1,
    minutes_elapsed: '145'
  }]
});

// ---------------------------------------------------------------------------
// Node 9: Build B2 Manager DM (per breach-2 row)
// ---------------------------------------------------------------------------
const buildB2Dm = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build B2 Manager DM',
    parameters: {
      mode: 'runOnceForEachItem',
      jsCode: BUILD_B2_CODE
    },
    position: [1200, 460]
  },
  output: [{
    lead_id: 'ffffffff-gggg-hhhh-iiii-jjjjjjjjjjjj',
    account_name: 'Beta Industries',
    contact_name: 'John Doe',
    original_rep_id: '1',
    minutes_elapsed: 145,
    dm_text: '*SLA BREACH - Stage 2 (120+ min)*\n*Account:* Beta Industries\n...',
    backup_rep_id: 2,
    manager_slack_id: 'U0ANRG80F2Q'
  }]
});

// ---------------------------------------------------------------------------
// Node 10: DM Manager (Slack DM to manager)
// continueOnFail: true — NULL slack_id causes Slack API error but chain continues.
// Chain order: Build B2 Manager DM → DM Manager → Update B2 Reassign.
// DM runs before UPDATE so $json refs Build B2 output directly (no cross-node needed).
// ---------------------------------------------------------------------------
const dmManager = node({
  type: 'n8n-nodes-base.slack',
  version: 2.4,
  config: {
    name: 'DM Manager',
    parameters: {
      resource: 'message',
      operation: 'post',
      authentication: 'accessToken',
      select: 'user',
      user: {
        __rl: true,
        mode: 'id',
        value: expr("{{ $json.manager_slack_id }}")
      },
      messageType: 'text',
      text: expr("{{ $json.dm_text }}"),
      otherOptions: {
        includeLinkToWorkflow: false
      }
    },
    credentials: {
      slackApi: newCredential('Slack account')
    },
    continueOnFail: true,
    position: [1440, 460]
  },
  output: [{
    ok: true,
    channel: 'D0ANRG80F2Q',
    message: { ts: '1746100001.000001', type: 'message' },
    message_timestamp: '1746100001.000001'
  }]
});

// ---------------------------------------------------------------------------
// Node 11: Update B2 Reassign
// Runs after DM Manager. References Build B2 Manager DM by name for lead_id
// and backup_rep_id (current item is DM Manager Slack output).
// escalation_stage = 2 (integer): 0 = none, 2 = stage-2 reassigned.
// ---------------------------------------------------------------------------
const updateB2Reassign = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Update B2 Reassign',
    parameters: {
      operation: 'executeQuery',
      query: `UPDATE inbound_tier1_leads_in_flight
SET assigned_rep_id = {{ $("Build B2 Manager DM").item.json.backup_rep_id }},
    escalation_stage = 2,
    breach_2_fired = true
WHERE id = '{{ $("Build B2 Manager DM").item.json.lead_id }}'::uuid
RETURNING id, assigned_rep_id, escalation_stage, breach_2_fired`
    },
    credentials: {
      postgres: newCredential('Beacon Supabase Postgres')
    },
    position: [1680, 460]
  },
  output: [{
    id: 'ffffffff-gggg-hhhh-iiii-jjjjjjjjjjjj',
    assigned_rep_id: 2,
    escalation_stage: 2,
    breach_2_fired: true
  }]
});

// ---------------------------------------------------------------------------
// Workflow composition
// Fan-out from defineConstants:
//   Branch 1 (breach-1): defineConstants → queryABreach1 → buildB1Message → postChannelB1 → updateB1Fired
//   Branch 2 (breach-2): defineConstants → lookupRepSlackIds → queryBBreach2 → buildB2Dm → dmManager → updateB2Reassign
// ---------------------------------------------------------------------------
export default workflow('', 'Inbound Synthesis - SLA Monitor')
  .add(stickySchedule)
  .add(stickyConstants)
  .add(stickyBreach1)
  .add(stickyBreach2)
  .add(scheduleTrigger)
  .to(defineConstants)
  .to(queryABreach1)
  .to(buildB1Message)
  .to(postChannelB1)
  .to(updateB1Fired)
  .add(defineConstants)
  .to(lookupRepSlackIds)
  .to(queryBBreach2)
  .to(buildB2Dm)
  .to(dmManager)
  .to(updateB2Reassign);
