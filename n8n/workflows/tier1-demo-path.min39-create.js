import { workflow, node, trigger, newCredential, expr } from '@n8n/workflow-sdk';

// ============================================================================
// MIN-39 — Tier 1 Demo Path
//
// Trigger: POST /webhook/tier1-demo (Chili Piper-shape payload)
// Chain:
//   1. Tier1 Demo Webhook         — POST, responseMode lastNode
//   2. Parse Chili Piper Payload  — validates fields, generates sfdc_lead_id; demo_rep_id=1 hardcoded
//   3. Lookup Rep Slack ID        — SELECT slack_id FROM reps WHERE id = demo_rep_id
//   4. SFDC Account Opp Lookup    — SOQL: Account + nested Opportunities subquery
//   5. Process SFDC Build Blocks  — processes SFDC results (0 or 1), builds Block Kit JSON
//   6. Insert Tier1 Lead          — INSERT INTO inbound_tier1_leads_in_flight RETURNING id
//   7. Send DM to Rep             — Slack DM to rep.slack_id (continueOnFail=true for null slack_id)
//   8. Write Back Slack TS        — UPDATE slack_message_ts (NULLIF on ts); last node = webhook response
//
// Credentials used:
//   "Salesforce account"        (salesforceOAuth2Api, id cvw45XGDWPZonyXP)
//   "Beacon Supabase Postgres"  (postgres)
//   "Slack account"             (slackApi)
// ============================================================================

// ---------------------------------------------------------------------------
// Code node 2: Parse + Validate Chili Piper Payload
// ---------------------------------------------------------------------------
const PARSE_CODE = `
const body = $input.first().json.body;

// Rep ID: fixed to rep 1 (Marcus Webb) for demo. Slack ID is looked up
// from reps.slack_id in the next node — not hardcoded here.
const demoRepId = 1;

const meeting = (body.data && body.data.meeting) ? body.data.meeting : {};
const guest = (body.data && body.data.guest) ? body.data.guest : {};

const accountName = (guest.company || '').trim();
const contactEmail = (guest.email || '').trim();
const firstName = (guest.first_name || '').trim();
const lastName = (guest.last_name || '').trim();
const contactName = (guest.name || (firstName + (lastName ? ' ' + lastName : ''))).trim() || contactEmail;
const contactTitle = (guest.title || 'VP Sales').trim();
const meetingStartTime = meeting.start_time || '';
const meetingTimezone = meeting.timezone || 'America/New_York';

if (!accountName) {
  throw new Error('Chili Piper payload missing data.guest.company - required for SFDC Account lookup.');
}
if (!contactEmail) {
  throw new Error('Chili Piper payload missing data.guest.email - required for lead record.');
}

// Synthetic Salesforce Lead ID if payload does not supply a valid one
let sfdcLeadId = (meeting.id || '').trim();
if (!sfdcLeadId || sfdcLeadId.length < 15) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let suffix = '';
  for (let i = 0; i < 13; i++) {
    suffix += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  sfdcLeadId = '00Q5e' + suffix;
}

const slaStartTime = new Date().toISOString();

return [{
  sfdc_lead_id: sfdcLeadId,
  account_name: accountName,
  contact_email: contactEmail,
  contact_name: contactName,
  contact_title: contactTitle,
  meeting_start_time: meetingStartTime,
  meeting_timezone: meetingTimezone,
  event_type: body.event_type || 'booking_created',
  sla_start_time: slaStartTime,
  demo_rep_id: demoRepId
}];
`;

// ---------------------------------------------------------------------------
// Code node 5: Process SFDC results + build Slack Block Kit JSON
// ---------------------------------------------------------------------------
const PROCESS_CODE = `
const parsed = $('Parse Chili Piper Payload').first().json;
const sfdcItems = $input.all();

// Resolve rep's Slack ID from DB lookup; console.log if null so DM failure is visible in logs
const repSlackId = $('Lookup Rep Slack ID').first().json.slack_id || null;
if (!repSlackId) {
  console.log('Lookup Rep Slack ID: no slack_id for rep ' + parsed.demo_rep_id + ' — DM will fail gracefully (continueOnFail=true)');
}

// SFDC result: 0 items = no account match; 1 item = account found
const sfdcAccount = (sfdcItems.length > 0 && sfdcItems[0].json && sfdcItems[0].json.Id)
  ? sfdcItems[0].json
  : null;

let openOppOnAccount = false;
let openOppId = null;
let openOppName = null;
let openOppStage = null;

if (
  sfdcAccount &&
  sfdcAccount.Opportunities &&
  sfdcAccount.Opportunities.records &&
  sfdcAccount.Opportunities.records.length > 0
) {
  const opp = sfdcAccount.Opportunities.records[0];
  openOppOnAccount = true;
  openOppId = opp.Id || null;
  openOppName = opp.Name || 'Open Opportunity';
  openOppStage = opp.StageName || 'In Progress';
}

// SQL fragment: single-quoted ID string or NULL keyword -- avoids silent empty inserts
const openOppIdFragment = openOppId ? ("'" + openOppId + "'") : 'NULL';

// Format booking time for Slack display
let bookingDisplay = 'TBD';
if (parsed.meeting_start_time) {
  try {
    const d = new Date(parsed.meeting_start_time);
    bookingDisplay = d.toLocaleString('en-US', {
      timeZone: parsed.meeting_timezone || 'America/New_York',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short'
    });
  } catch (e) {
    bookingDisplay = parsed.meeting_start_time;
  }
}

const oppLine = openOppOnAccount
  ? ('*Open opp:* ' + openOppName + ' (' + openOppStage + ')')
  : '*Open opp:* None found on account';

const sfdcAccountUrl = (sfdcAccount && sfdcAccount.Id)
  ? ('https://login.salesforce.com/' + sfdcAccount.Id)
  : 'https://login.salesforce.com';

const blocks = [
  {
    type: 'header',
    text: { type: 'plain_text', text: 'TIER 1 INBOUND - Chili Piper Booking', emoji: false }
  },
  {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: '*' + parsed.contact_name + '*  |  ' + parsed.contact_title + '\\n*' + parsed.account_name + '*'
    }
  },
  {
    type: 'section',
    fields: [
      { type: 'mrkdwn', text: '*Email:*\\n' + parsed.contact_email },
      { type: 'mrkdwn', text: '*Meeting:*\\n' + bookingDisplay }
    ]
  },
  {
    type: 'section',
    text: { type: 'mrkdwn', text: oppLine }
  },
  {
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Claim', emoji: false },
        style: 'primary',
        action_id: 'tier1_claim',
        value: parsed.sfdc_lead_id
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Acknowledge', emoji: false },
        action_id: 'tier1_ack',
        value: parsed.sfdc_lead_id
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: 'View in Salesforce', emoji: false },
        url: sfdcAccountUrl,
        action_id: 'tier1_sfdc_link'
      }
    ]
  },
  {
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: 'Triggered via demo webhook | SLA start: ' + parsed.sla_start_time
      }
    ]
  }
];

return [{
  sfdc_lead_id: parsed.sfdc_lead_id,
  account_name: parsed.account_name,
  contact_email: parsed.contact_email,
  contact_name: parsed.contact_name,
  contact_title: parsed.contact_title,
  meeting_start_time: parsed.meeting_start_time,
  meeting_timezone: parsed.meeting_timezone,
  event_type: parsed.event_type,
  sla_start_time: parsed.sla_start_time,
  demo_rep_id: parsed.demo_rep_id,
  demo_rep_slack_id: repSlackId,
  open_opp_on_account: openOppOnAccount,
  open_opp_id: openOppId,
  open_opp_id_fragment: openOppIdFragment,
  sfdc_account_id: sfdcAccount ? sfdcAccount.Id : null,
  blocks_json: JSON.stringify(blocks)
}];
`;

// ---------------------------------------------------------------------------
// Stickies
// ---------------------------------------------------------------------------
const stickyIngest = node({
  type: 'n8n-nodes-base.stickyNote',
  version: 1,
  config: {
    name: 'Sticky Ingest',
    parameters: {
      content: '**Tier 1 Demo Webhook**\nPOST /webhook/tier1-demo\nChili Piper booking_created payload.\nresponseMode: lastNode — blocks until chain completes, returns {id, slack_message_ts}.',
      height: 120,
      width: 320,
      color: 4
    },
    position: [240, 120]
  }
});

const stickyParse = node({
  type: 'n8n-nodes-base.stickyNote',
  version: 1,
  config: {
    name: 'Sticky Parse',
    parameters: {
      content: '**Parse + Validate**\ndemo_rep_id=1 (Marcus Webb) hardcoded for demo.\nGenerates synthetic 18-char sfdc_lead_id (00Q5e...) if payload lacks one.\nComputes sla_start_time = now().',
      height: 140,
      width: 320,
      color: 4
    },
    position: [480, 120]
  }
});

const stickyLookup = node({
  type: 'n8n-nodes-base.stickyNote',
  version: 1,
  config: {
    name: 'Sticky Lookup',
    parameters: {
      content: '**Lookup Rep Slack ID**\nSELECT id, slack_id FROM reps WHERE id = demo_rep_id.\nRep 1 (Marcus Webb) → slack_id = U0ANRG80F2Q.\nReps 3-7 have NULL slack_id — DM fails gracefully (continueOnFail=true on Send DM).',
      height: 140,
      width: 320,
      color: 4
    },
    position: [720, 120]
  }
});

const stickySfdc = node({
  type: 'n8n-nodes-base.stickyNote',
  version: 1,
  config: {
    name: 'Sticky SFDC',
    parameters: {
      content: '**SFDC Account + Opp Lookup**\nSOQL: SELECT Id, Name, (SELECT Id, Name, StageName FROM Opportunities WHERE IsClosed = false LIMIT 1) FROM Account WHERE Name = \'{account_name}\' LIMIT 1\nalwaysOutputData: true ensures 0-result SOQL does not block the chain.',
      height: 160,
      width: 320,
      color: 5
    },
    position: [960, 120]
  }
});

const stickyProcess = node({
  type: 'n8n-nodes-base.stickyNote',
  version: 1,
  config: {
    name: 'Sticky Process',
    parameters: {
      content: '**Process SFDC + Build Blocks**\nHandles 0-item (no account) and 1-item (account found) SFDC results.\nSets open_opp_on_account, open_opp_id, open_opp_id_fragment (SQL-safe NULL or quoted ID).\nBuilds full Slack Block Kit JSON — header, contact, opp status, Claim/Ack/SFDC buttons, demo footer.',
      height: 160,
      width: 320,
      color: 4
    },
    position: [1200, 120]
  }
});

const stickyInsert = node({
  type: 'n8n-nodes-base.stickyNote',
  version: 1,
  config: {
    name: 'Sticky Insert',
    parameters: {
      content: '**Insert Tier1 Lead**\nINSERT INTO inbound_tier1_leads_in_flight RETURNING id.\nassigned_rep_id = demo_rep_id (integer FK to reps.id).\nopen_opp_id uses SQL-safe fragment from Process node (NULL or quoted ID).',
      height: 140,
      width: 320,
      color: 4
    },
    position: [1440, 120]
  }
});

const stickySlack = node({
  type: 'n8n-nodes-base.stickyNote',
  version: 1,
  config: {
    name: 'Sticky Slack',
    parameters: {
      content: '**Send DM to Rep**\nSlack DM (not channel post) to rep.slack_id (from DB lookup).\ncontinueOnFail=true: NULL slack_id causes Slack API error but chain continues.\nBlock Kit from blocks_json built by Process node.',
      height: 140,
      width: 320,
      color: 2
    },
    position: [1680, 120]
  }
});

const stickyUpdate = node({
  type: 'n8n-nodes-base.stickyNote',
  version: 1,
  config: {
    name: 'Sticky Update',
    parameters: {
      content: '**Write Back Slack TS**\nUPDATE inbound_tier1_leads_in_flight SET slack_message_ts = Slack message.ts.\nNULLIF handles empty string if DM failed (continueOnFail path).\nRETURNING id, slack_message_ts — LAST NODE; its output is the webhook 200 response body.',
      height: 140,
      width: 320,
      color: 4
    },
    position: [1920, 120]
  }
});

// ---------------------------------------------------------------------------
// Node 1: Webhook trigger
// ---------------------------------------------------------------------------
const webhookTrigger = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Tier1 Demo Webhook',
    parameters: {
      httpMethod: 'POST',
      path: 'tier1-demo',
      responseMode: 'lastNode',
      responseData: 'firstEntryJson'
    },
    position: [240, 320]
  },
  output: [{
    body: {
      event_type: 'booking_created',
      data: {
        meeting: { id: '00Q5e0000001ABCDEF', start_time: '2026-05-05T14:00:00.000Z', timezone: 'America/New_York' },
        guest: { company: 'Acme Corp', email: 'jane@acme.com', name: 'Jane Smith', title: 'VP Sales' }
      }
    }
  }]
});

// ---------------------------------------------------------------------------
// Node 2: Parse + Validate
// ---------------------------------------------------------------------------
const parsePayload = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Parse Chili Piper Payload',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: PARSE_CODE
    },
    position: [480, 320]
  },
  output: [{
    sfdc_lead_id: '00Q5e0000001ABCDEF',
    account_name: 'Acme Corp',
    contact_email: 'jane@acme.com',
    contact_name: 'Jane Smith',
    contact_title: 'VP Sales',
    meeting_start_time: '2026-05-05T14:00:00.000Z',
    meeting_timezone: 'America/New_York',
    event_type: 'booking_created',
    sla_start_time: '2026-05-01T14:30:00.000Z',
    demo_rep_id: 1
  }]
});

// ---------------------------------------------------------------------------
// Node 3: Lookup Rep Slack ID from reps table
// ---------------------------------------------------------------------------
const lookupRep = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Lookup Rep Slack ID',
    parameters: {
      operation: 'executeQuery',
      query: `SELECT id, slack_id FROM reps WHERE id = {{ $('Parse Chili Piper Payload').item.json.demo_rep_id }} LIMIT 1`
    },
    credentials: {
      postgres: newCredential('Beacon Supabase Postgres')
    },
    position: [720, 320]
  },
  output: [{ id: 1, slack_id: 'U0ANRG80F2Q' }]
});

// ---------------------------------------------------------------------------
// Node 4: Salesforce SOQL — Account + nested Opportunities
// alwaysOutputData: true prevents 0-result SOQL from blocking the chain.
// ---------------------------------------------------------------------------
const sfdcLookup = node({
  type: 'n8n-nodes-base.salesforce',
  version: 1,
  config: {
    name: 'SFDC Account Opp Lookup',
    parameters: {
      resource: 'search',
      operation: 'query',
      authentication: 'oAuth2',
      query: expr("SELECT Id, Name, (SELECT Id, Name, StageName FROM Opportunities WHERE IsClosed = false LIMIT 1) FROM Account WHERE Name = '{{ $('Parse Chili Piper Payload').item.json.account_name }}' LIMIT 1")
    },
    credentials: {
      salesforceOAuth2Api: newCredential('Salesforce account')
    },
    alwaysOutputData: true,
    position: [960, 320]
  },
  output: [{
    Id: '001000000001ABCDE',
    Name: 'Acme Corp',
    Opportunities: {
      records: [{ Id: '006000000001ABCDE', Name: 'Acme Corp - Platform', StageName: 'Proposal/Price Quote' }]
    }
  }]
});

// ---------------------------------------------------------------------------
// Node 5: Process SFDC + Build Slack Blocks
// ---------------------------------------------------------------------------
const processBlocks = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Process SFDC Build Blocks',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: PROCESS_CODE
    },
    position: [1200, 320]
  },
  output: [{
    sfdc_lead_id: '00Q5e0000001ABCDEF',
    account_name: 'Acme Corp',
    contact_email: 'jane@acme.com',
    contact_name: 'Jane Smith',
    contact_title: 'VP Sales',
    meeting_start_time: '2026-05-05T14:00:00.000Z',
    meeting_timezone: 'America/New_York',
    event_type: 'booking_created',
    sla_start_time: '2026-05-01T14:30:00.000Z',
    demo_rep_id: 1,
    demo_rep_slack_id: 'U0ANRG80F2Q',
    open_opp_on_account: true,
    open_opp_id: '006000000001ABCDE',
    open_opp_id_fragment: "'006000000001ABCDE'",
    sfdc_account_id: '001000000001ABCDE',
    blocks_json: '[]'
  }]
});

// ---------------------------------------------------------------------------
// Node 6: Postgres INSERT RETURNING id
// ---------------------------------------------------------------------------
const pgInsert = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Insert Tier1 Lead',
    parameters: {
      operation: 'executeQuery',
      query: `INSERT INTO inbound_tier1_leads_in_flight (
  sfdc_lead_id,
  account_name,
  contact_email,
  contact_name,
  contact_title,
  event_type,
  assigned_rep_id,
  assigned_rep_slack_id,
  sla_start_time,
  sla_tier,
  open_opp_on_account,
  open_opp_id
) VALUES (
  '{{ $("Process SFDC Build Blocks").item.json.sfdc_lead_id }}',
  '{{ $("Process SFDC Build Blocks").item.json.account_name }}',
  '{{ $("Process SFDC Build Blocks").item.json.contact_email }}',
  '{{ $("Process SFDC Build Blocks").item.json.contact_name }}',
  '{{ $("Process SFDC Build Blocks").item.json.contact_title }}',
  'chili_piper_booking',
  {{ $("Process SFDC Build Blocks").item.json.demo_rep_id }},
  '{{ $("Process SFDC Build Blocks").item.json.demo_rep_slack_id }}',
  '{{ $("Process SFDC Build Blocks").item.json.sla_start_time }}'::timestamptz,
  'tier1_60min',
  {{ $("Process SFDC Build Blocks").item.json.open_opp_on_account }},
  {{ $("Process SFDC Build Blocks").item.json.open_opp_id_fragment }}
) RETURNING id`
    },
    credentials: {
      postgres: newCredential('Beacon Supabase Postgres')
    },
    position: [1440, 320]
  },
  output: [{ id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }]
});

// ---------------------------------------------------------------------------
// Node 7: Slack DM to rep.slack_id (from DB lookup)
// continueOnFail: true — NULL slack_id causes Slack API error but chain continues.
// ---------------------------------------------------------------------------
const slackDm = node({
  type: 'n8n-nodes-base.slack',
  version: 2.4,
  config: {
    name: 'Send DM to Rep',
    parameters: {
      resource: 'message',
      operation: 'post',
      authentication: 'accessToken',
      select: 'user',
      user: {
        __rl: true,
        mode: 'id',
        value: expr("{{ $('Process SFDC Build Blocks').item.json.demo_rep_slack_id }}")
      },
      messageType: 'block',
      text: expr("{{ $('Process SFDC Build Blocks').item.json.contact_name }} booked a meeting — Tier 1 Inbound"),
      blocksUi: expr("{{ JSON.stringify({ blocks: JSON.parse($('Process SFDC Build Blocks').item.json.blocks_json) }) }}"),
      otherOptions: {
        includeLinkToWorkflow: false
      }
    },
    credentials: {
      slackApi: newCredential('Slack account')
    },
    continueOnFail: true,
    position: [1680, 320]
  },
  output: [{
    ok: true,
    channel: 'D0ANRG80F2Q',
    message: { ts: '1746100000.000001', type: 'message' },
    message_timestamp: '1746100000.000001'
  }]
});

// ---------------------------------------------------------------------------
// Node 8: Postgres UPDATE — write back slack_message_ts; last node = webhook response
// NULLIF handles empty string when DM failed (continueOnFail path produces empty ts).
// ---------------------------------------------------------------------------
const pgUpdate = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Write Back Slack TS',
    parameters: {
      operation: 'executeQuery',
      query: `UPDATE inbound_tier1_leads_in_flight
SET slack_message_ts = NULLIF('{{ $("Send DM to Rep").item.json.message.ts }}', '')
WHERE id = '{{ $("Insert Tier1 Lead").item.json.id }}'::uuid
RETURNING id, slack_message_ts`
    },
    credentials: {
      postgres: newCredential('Beacon Supabase Postgres')
    },
    position: [1920, 320]
  },
  output: [{ id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', slack_message_ts: '1746100000.000001' }]
});

// ---------------------------------------------------------------------------
// Workflow composition
// ---------------------------------------------------------------------------
export default workflow('', 'Tier 1 Demo Path')
  .add(stickyIngest)
  .add(stickyParse)
  .add(stickyLookup)
  .add(stickySfdc)
  .add(stickyProcess)
  .add(stickyInsert)
  .add(stickySlack)
  .add(stickyUpdate)
  .add(webhookTrigger)
  .to(parsePayload)
  .to(lookupRep)
  .to(sfdcLookup)
  .to(processBlocks)
  .to(pgInsert)
  .to(slackDm)
  .to(pgUpdate);
