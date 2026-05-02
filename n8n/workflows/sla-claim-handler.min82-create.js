import { workflow, node, trigger, switchCase, newCredential, expr } from '@n8n/workflow-sdk';

// ============================================================================
// MIN-82 — Inbound Synthesis - SLA Claim Handler
//
// Trigger: webhook POST /webhook/internal/sla-claim
//   Called by the Slack Interactivity Router (MIN-81) when a user clicks the
//   "Claim" button on an SLA breach Stage 1 alert posted by MIN-40 to
//   #inbound-sla-breach. Router forwards { payload: <raw-slack-json-string> }
//   as application/json. We re-parse body.payload to get the original Slack
//   interactivity object byte-for-byte.
//
// Architecture (linear with one 3-way Switch dispatch):
//   Webhook
//     -> Parse Payload (Code, runOnceForAllItems)
//     -> Lookup Clicker Rep (Postgres, alwaysOutputData=true)
//     -> Lookup Lead State (Postgres, alwaysOutputData=true)  [LEFT JOIN reps for claimer name]
//     -> Decide Outcome (Code, runOnceForAllItems)
//        Sets outcome IN ('unauthorized', 'already_claimed', 'claim_ok')
//     -> Switch by Outcome (3 cases + fallback)
//        unauthorized    -> Post Unauthorized Ephemeral (httpRequest -> response_url)
//        already_claimed -> Post Already Claimed Ephemeral (httpRequest -> response_url)
//        claim_ok        -> Update Lead Acknowledged (Postgres)
//                            -> Build Updated Blocks (Code)
//                            -> Update Original Message (Slack chat.update)
//                            -> Post Threaded Ack (Slack chat.postMessage threaded)
//        fallback        -> Post Fallback Ephemeral (httpRequest -> response_url)
//
// Notes:
//   - All ephemeral responses go to response_url (router-style; no extra creds).
//   - chat.update + threaded postMessage use the Slack node with the existing
//     "Slack account" credential (same one MIN-39/MIN-40 use).
//   - continueOnFail=true on the two Slack write nodes so a Slack hiccup after
//     the DB UPDATE commits doesn't leave the workflow erroring with the row
//     already in 'acknowledged' state.
//   - Block rebuild filters by type==='actions' rather than index — robust to
//     future MIN-40 block reordering.
//   - Workflow created INACTIVE. Activation + smoke test deferred to MIN-82
//     Part 2 along with the router edit (sla_claim case).
//
// Credentials:
//   "Beacon Supabase Postgres"  (postgres) — Lookup Clicker Rep, Lookup Lead State, Update Lead
//   "Slack account"             (slackApi) — Update Original Message, Post Threaded Ack
// ============================================================================

// ---------------------------------------------------------------------------
// Code 1: Parse Payload — extract fields from the router-forwarded Slack JSON
// ---------------------------------------------------------------------------
const PARSE_CODE = `
const body = $input.first().json.body || {};
const rawPayload = body.payload || "{}";
let parsed = {};
try { parsed = JSON.parse(rawPayload); } catch (e) { parsed = {}; }

const action = (parsed.actions && parsed.actions[0]) || {};
const message = parsed.message || {};
const container = parsed.container || {};
const user = parsed.user || {};
const channel = parsed.channel || {};

return [{
  lead_id: action.value || null,
  clicker_user_id: user.id || null,
  clicker_user_name: user.username || user.name || null,
  message_ts: message.ts || container.message_ts || null,
  channel_id: channel.id || container.channel_id || null,
  response_url: parsed.response_url || null,
  original_blocks: Array.isArray(message.blocks) ? message.blocks : []
}];
`;

// ---------------------------------------------------------------------------
// Code 2: Decide Outcome — combines auth check + idempotency check into one
//   outcome field that drives the downstream Switch.
//
//   - Lookup Clicker Rep returns 0 or 1 row. 0 rows → unauthorized.
//   - Lookup Lead State returns 0 or 1 row. ack_status='acknowledged' →
//     already_claimed (claimer_name is the LEFT-JOINed reps.name, may be null
//     if assigned_rep_id was null at claim time).
//   - Otherwise → claim_ok.
//
//   Carries through every field downstream nodes need so the Switch outputs
//   are self-contained.
// ---------------------------------------------------------------------------
const DECIDE_CODE = `
const parsed = $('Parse Payload').first().json;

const clickerRows = $('Lookup Clicker Rep').all();
const clickerRep = clickerRows.length > 0 ? clickerRows[0].json : null;

const leadRows = $('Lookup Lead State').all();
const leadRow = leadRows.length > 0 ? leadRows[0].json : null;

let outcome;
let ephemeral_text = '';
let claimer_name = '';
let claimer_ack_time_str = '';

if (!clickerRep || !clickerRep.id) {
  outcome = 'unauthorized';
  ephemeral_text = 'Only registered reps can claim. Contact ops.';
} else if (leadRow && String(leadRow.ack_status) === 'acknowledged') {
  outcome = 'already_claimed';
  claimer_name = leadRow.claimer_name || 'another rep';
  if (leadRow.ack_time) {
    try {
      const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit',
        timeZoneName: 'short'
      });
      claimer_ack_time_str = fmt.format(new Date(leadRow.ack_time));
    } catch (e) {
      claimer_ack_time_str = String(leadRow.ack_time);
    }
  }
  ephemeral_text = 'Already claimed by ' + claimer_name +
    (claimer_ack_time_str ? (' at ' + claimer_ack_time_str) : '') + '.';
} else {
  outcome = 'claim_ok';
}

// Format "now" for the chat.update context block + threaded ack message.
let now_str = '';
try {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
    timeZoneName: 'short'
  });
  now_str = fmt.format(new Date());
} catch (e) {
  now_str = new Date().toISOString();
}

return [{
  outcome: outcome,
  // pass-through from Parse Payload
  lead_id: parsed.lead_id,
  clicker_user_id: parsed.clicker_user_id,
  message_ts: parsed.message_ts,
  channel_id: parsed.channel_id,
  response_url: parsed.response_url,
  original_blocks: parsed.original_blocks,
  // resolved
  clicker_rep_id: clickerRep ? clickerRep.id : null,
  clicker_rep_name: clickerRep ? clickerRep.name : null,
  // for ephemeral payloads
  ephemeral_text: ephemeral_text,
  // for chat.update + threaded ack
  now_str: now_str,
  // for already_claimed branch
  existing_claimer_name: claimer_name,
  existing_claimer_ack_str: claimer_ack_time_str
}];
`;

// ---------------------------------------------------------------------------
// Code 3: Build Updated Blocks — replace the Claim actions block in-place with
//   a CLAIMED status context. Keep all other blocks (header, sections, footer
//   context) intact so the alert stays scannable as a historical record.
//   blocks_json is JSON.stringify({ blocks: rebuilt }) — Slack node v2.4
//   internally JSON.parse()s blocksUi and reads the .blocks property, so a
//   bare array would be silently dropped.
// ---------------------------------------------------------------------------
const BUILD_BLOCKS_CODE = `
const decided = $('Decide Outcome').first().json;
const original = Array.isArray(decided.original_blocks) ? decided.original_blocks : [];

const claimedBy = decided.clicker_rep_name || 'a rep';
const at = decided.now_str || '';
const statusBlock = {
  type: 'context',
  elements: [
    {
      type: 'mrkdwn',
      text: ':white_check_mark: *CLAIMED* by ' + claimedBy + (at ? (' at ' + at) : '')
    }
  ]
};

// Replace any actions block (the Claim button row) with the status pill;
// pass every other block through untouched.
const rebuilt = original.map(function(b) {
  if (b && b.type === 'actions') {
    return statusBlock;
  }
  return b;
});

return [{
  blocks_json: JSON.stringify({ blocks: rebuilt }),
  fallback_text: 'SLA Breach claimed by ' + claimedBy
}];
`;

// ---------------------------------------------------------------------------
// Body expressions for the three response_url ephemeral httpRequest nodes
// ---------------------------------------------------------------------------
const EPHEMERAL_BODY_EXPR =
  '={{ JSON.stringify({ response_type: "ephemeral", replace_original: false, text: $json.ephemeral_text }) }}';

const FALLBACK_BODY_EXPR =
  '={{ JSON.stringify({ response_type: "ephemeral", replace_original: false, text: "Claim handler could not classify this click. Contact ops." }) }}';

const RESPONSE_URL_EXPR = "{{ $json.response_url }}";

// ---------------------------------------------------------------------------
// Node 1: Slack Interaction (webhook) — internal-only path
// ---------------------------------------------------------------------------
const slackInteraction = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Slack Interaction',
    parameters: {
      httpMethod: 'POST',
      path: 'internal/sla-claim',
      options: {}
    },
    position: [0, 0]
  }
});

// ---------------------------------------------------------------------------
// Node 2: Parse Payload
// ---------------------------------------------------------------------------
const parsePayload = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Parse Payload',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: PARSE_CODE
    },
    position: [220, 0]
  },
  output: [{
    lead_id: '11111111-2222-3333-4444-555555555555',
    clicker_user_id: 'U0ANRG80F2Q',
    clicker_user_name: 'marcus',
    message_ts: '1746100000.000001',
    channel_id: 'C0B153QTCFQ',
    response_url: 'https://hooks.slack.com/actions/...',
    original_blocks: []
  }]
});

// ---------------------------------------------------------------------------
// Node 3: Lookup Clicker Rep
//   alwaysOutputData=true so an empty result still flows downstream and the
//   Decide Outcome node can route it to 'unauthorized'.
// ---------------------------------------------------------------------------
const lookupClickerRep = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Lookup Clicker Rep',
    parameters: {
      operation: 'executeQuery',
      query: `SELECT id, name FROM reps WHERE slack_id = '{{ $('Parse Payload').first().json.clicker_user_id }}' LIMIT 1`
    },
    credentials: {
      postgres: newCredential('Beacon Supabase Postgres')
    },
    alwaysOutputData: true,
    position: [440, 0]
  },
  output: [{ id: 1, name: 'Marcus Webb' }]
});

// ---------------------------------------------------------------------------
// Node 4: Lookup Lead State
//   LEFT JOIN reps so we get the existing claimer's name in one round-trip
//   for the already_claimed ephemeral. assigned_rep_id may be null pre-claim,
//   so LEFT JOIN keeps the row even when the join is empty.
// ---------------------------------------------------------------------------
const lookupLeadState = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Lookup Lead State',
    parameters: {
      operation: 'executeQuery',
      query: `SELECT l.id, l.ack_status, l.ack_time, l.assigned_rep_id, r.name AS claimer_name
FROM inbound_tier1_leads_in_flight l
LEFT JOIN reps r ON r.id = l.assigned_rep_id
WHERE l.id = '{{ $('Parse Payload').first().json.lead_id }}'::uuid
LIMIT 1`
    },
    credentials: {
      postgres: newCredential('Beacon Supabase Postgres')
    },
    alwaysOutputData: true,
    position: [660, 0]
  },
  output: [{
    id: '11111111-2222-3333-4444-555555555555',
    ack_status: 'pending',
    ack_time: null,
    assigned_rep_id: null,
    claimer_name: null
  }]
});

// ---------------------------------------------------------------------------
// Node 5: Decide Outcome
// ---------------------------------------------------------------------------
const decideOutcome = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Decide Outcome',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: DECIDE_CODE
    },
    position: [880, 0]
  },
  output: [{
    outcome: 'claim_ok',
    lead_id: '11111111-2222-3333-4444-555555555555',
    clicker_user_id: 'U0ANRG80F2Q',
    message_ts: '1746100000.000001',
    channel_id: 'C0B153QTCFQ',
    response_url: 'https://hooks.slack.com/actions/...',
    original_blocks: [],
    clicker_rep_id: 1,
    clicker_rep_name: 'Marcus Webb',
    ephemeral_text: '',
    now_str: 'May 1, 3:45 PM EDT',
    existing_claimer_name: '',
    existing_claimer_ack_str: ''
  }]
});

// ---------------------------------------------------------------------------
// Node 6: Switch by Outcome
//   case 0: unauthorized
//   case 1: already_claimed
//   case 2: claim_ok
//   fallback: anything else (defensive)
// ---------------------------------------------------------------------------
const switchByOutcome = switchCase({
  type: 'n8n-nodes-base.switch',
  version: 3.4,
  config: {
    name: 'Switch by Outcome',
    parameters: {
      mode: 'rules',
      rules: {
        values: [
          {
            conditions: {
              options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
              conditions: [{
                leftValue: '={{ $json.outcome }}',
                rightValue: 'unauthorized',
                operator: { type: 'string', operation: 'equals' }
              }],
              combinator: 'and'
            },
            renameOutput: true,
            outputKey: 'unauthorized'
          },
          {
            conditions: {
              options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
              conditions: [{
                leftValue: '={{ $json.outcome }}',
                rightValue: 'already_claimed',
                operator: { type: 'string', operation: 'equals' }
              }],
              combinator: 'and'
            },
            renameOutput: true,
            outputKey: 'already_claimed'
          },
          {
            conditions: {
              options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
              conditions: [{
                leftValue: '={{ $json.outcome }}',
                rightValue: 'claim_ok',
                operator: { type: 'string', operation: 'equals' }
              }],
              combinator: 'and'
            },
            renameOutput: true,
            outputKey: 'claim_ok'
          }
        ]
      },
      options: {
        fallbackOutput: 'extra',
        renameFallbackOutput: 'fallback'
      }
    },
    position: [1100, 0]
  }
});

// ---------------------------------------------------------------------------
// Node 7: Post Unauthorized Ephemeral
// ---------------------------------------------------------------------------
const postUnauthorizedEphemeral = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Post Unauthorized Ephemeral',
    parameters: {
      method: 'POST',
      url: expr(RESPONSE_URL_EXPR),
      sendHeaders: true,
      headerParameters: {
        parameters: [{ name: 'content-type', value: 'application/json' }]
      },
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: EPHEMERAL_BODY_EXPR,
      options: {}
    },
    position: [1340, -300]
  }
});

// ---------------------------------------------------------------------------
// Node 8: Post Already Claimed Ephemeral
// ---------------------------------------------------------------------------
const postAlreadyClaimedEphemeral = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Post Already Claimed Ephemeral',
    parameters: {
      method: 'POST',
      url: expr(RESPONSE_URL_EXPR),
      sendHeaders: true,
      headerParameters: {
        parameters: [{ name: 'content-type', value: 'application/json' }]
      },
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: EPHEMERAL_BODY_EXPR,
      options: {}
    },
    position: [1340, -100]
  }
});

// ---------------------------------------------------------------------------
// Node 9: Update Lead Acknowledged
//   Authoritative DB write. Only runs on the claim_ok branch.
//   No alwaysOutputData — if 0 rows match (race), we want chain to error,
//   because that means we lost a write race or lead_id was bad.
// ---------------------------------------------------------------------------
const updateLeadAcknowledged = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Update Lead Acknowledged',
    parameters: {
      operation: 'executeQuery',
      query: `UPDATE inbound_tier1_leads_in_flight
SET ack_status = 'acknowledged',
    ack_time = now(),
    assigned_rep_id = {{ $('Decide Outcome').first().json.clicker_rep_id }}
WHERE id = '{{ $('Decide Outcome').first().json.lead_id }}'::uuid
RETURNING id, ack_status, ack_time, assigned_rep_id`
    },
    credentials: {
      postgres: newCredential('Beacon Supabase Postgres')
    },
    position: [1340, 100]
  },
  output: [{
    id: '11111111-2222-3333-4444-555555555555',
    ack_status: 'acknowledged',
    ack_time: '2026-05-01T19:45:00Z',
    assigned_rep_id: 1
  }]
});

// ---------------------------------------------------------------------------
// Node 10: Build Updated Blocks
// ---------------------------------------------------------------------------
const buildUpdatedBlocks = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Updated Blocks',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: BUILD_BLOCKS_CODE
    },
    position: [1560, 100]
  },
  output: [{
    blocks_json: '[]',
    fallback_text: 'SLA Breach claimed by Marcus Webb'
  }]
});

// ---------------------------------------------------------------------------
// Node 11: Update Original Message (Slack chat.update)
//   Pulls channel + ts from Decide Outcome (parse-time fields), pulls blocks
//   from Build Updated Blocks (rebuilt blocks). continueOnFail=true so a
//   Slack flake doesn't error the workflow with the row already updated.
// ---------------------------------------------------------------------------
const updateOriginalMessage = node({
  type: 'n8n-nodes-base.slack',
  version: 2.4,
  config: {
    name: 'Update Original Message',
    parameters: {
      resource: 'message',
      operation: 'update',
      authentication: 'accessToken',
      channelId: {
        __rl: true,
        mode: 'id',
        value: expr("{{ $('Decide Outcome').first().json.channel_id }}")
      },
      ts: expr("{{ $('Decide Outcome').first().json.message_ts }}"),
      messageType: 'block',
      text: expr("{{ $json.fallback_text }}"),
      blocksUi: expr("{{ $json.blocks_json }}"),
      otherOptions: {
        includeLinkToWorkflow: false
      }
    },
    credentials: {
      slackApi: newCredential('Slack account')
    },
    continueOnFail: true,
    position: [1780, 100]
  },
  output: [{
    ok: true,
    channel: 'C0B153QTCFQ',
    message: { ts: '1746100000.000001', type: 'message' }
  }]
});

// ---------------------------------------------------------------------------
// Node 12: Post Threaded Ack (chat.postMessage with thread_ts)
//   Public threaded reply ("Marcus claimed this lead. Acknowledged."), so
//   the channel sees the audit trail without flooding. continueOnFail=true.
// ---------------------------------------------------------------------------
const postThreadedAck = node({
  type: 'n8n-nodes-base.slack',
  version: 2.4,
  config: {
    name: 'Post Threaded Ack',
    parameters: {
      resource: 'message',
      operation: 'post',
      authentication: 'accessToken',
      select: 'channel',
      channelId: {
        __rl: true,
        mode: 'id',
        value: expr("{{ $('Decide Outcome').first().json.channel_id }}")
      },
      messageType: 'text',
      text: expr("{{ $('Decide Outcome').first().json.clicker_rep_name }} claimed this lead. Acknowledged."),
      otherOptions: {
        includeLinkToWorkflow: false,
        thread_ts: {
          replyValues: {
            thread_ts: expr("{{ $('Decide Outcome').first().json.message_ts }}"),
            reply_broadcast: false
          }
        }
      }
    },
    credentials: {
      slackApi: newCredential('Slack account')
    },
    continueOnFail: true,
    position: [2000, 100]
  },
  output: [{
    ok: true,
    channel: 'C0B153QTCFQ',
    message: { ts: '1746100002.000001', type: 'message' }
  }]
});

// ---------------------------------------------------------------------------
// Node 13: Post Fallback Ephemeral (defensive — outcome wasn't one of three)
// ---------------------------------------------------------------------------
const postFallbackEphemeral = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Post Fallback Ephemeral',
    parameters: {
      method: 'POST',
      url: expr(RESPONSE_URL_EXPR),
      sendHeaders: true,
      headerParameters: {
        parameters: [{ name: 'content-type', value: 'application/json' }]
      },
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: FALLBACK_BODY_EXPR,
      options: {}
    },
    position: [1340, 300]
  }
});

// ---------------------------------------------------------------------------
// Sticky notes
// ---------------------------------------------------------------------------
const stickyIngress = node({
  type: 'n8n-nodes-base.stickyNote',
  version: 1,
  config: {
    name: 'Sticky Ingress',
    parameters: {
      content: "## Internal webhook — called by router\n\nPath: POST /webhook/internal/sla-claim\n\nThe Slack Interactivity Router (MIN-81) forwards { payload: <raw-slack-json-string> } here when action_id === 'sla_claim'. We re-parse body.payload to recover the original Slack interactivity object (user, channel, message, actions, response_url).\n\nWorkflow is INACTIVE by design — MIN-82 Part 2 covers router edit + activation + smoke test.",
      height: 280,
      width: 380,
      color: 6
    },
    position: [-40, -320]
  }
});

const stickyLookups = node({
  type: 'n8n-nodes-base.stickyNote',
  version: 1,
  config: {
    name: 'Sticky Lookups',
    parameters: {
      content: "## Two reads, alwaysOutputData\n\nLookup Clicker Rep: SELECT id, name FROM reps WHERE slack_id = clicker_user_id. Empty result → 'unauthorized' downstream.\n\nLookup Lead State: SELECT lead + LEFT JOIN reps for existing claimer name in one round-trip. Drives the 'already_claimed' ephemeral copy without a second query.\n\nalwaysOutputData=true on both — empty results must still flow so Decide Outcome can route them.",
      height: 260,
      width: 420,
      color: 4
    },
    position: [400, -320]
  }
});

const stickyDecide = node({
  type: 'n8n-nodes-base.stickyNote',
  version: 1,
  config: {
    name: 'Sticky Decide',
    parameters: {
      content: "## Single Decide → Switch dispatch\n\nDecide Outcome combines auth + idempotency into one outcome ∈ {unauthorized, already_claimed, claim_ok} and carries through everything downstream nodes need (channel_id, message_ts, response_url, ephemeral_text, now_str, original_blocks, clicker_rep_id/name).\n\nSwitch is pure dispatch — no logic in branches.",
      height: 260,
      width: 380,
      color: 4
    },
    position: [840, -320]
  }
});

const stickyClaimPath = node({
  type: 'n8n-nodes-base.stickyNote',
  version: 1,
  config: {
    name: 'Sticky Claim Path',
    parameters: {
      content: "## claim_ok branch — write then decorate\n\n1. UPDATE inbound_tier1_leads_in_flight SET ack_status='acknowledged', ack_time=now(), assigned_rep_id=clicker (authoritative — no continueOnFail).\n2. Build Updated Blocks: filter original_blocks where type !== 'actions', append context line ':white_check_mark: Claimed by <name> at <time>'. Filter-by-type so MIN-40 block reorders don't break this.\n3. chat.update replaces message with new blocks.\n4. chat.postMessage threaded reply for audit trail.\n\ncontinueOnFail=true on both Slack calls — DB is committed; Slack ops are best-effort decoration.",
      height: 320,
      width: 480,
      color: 5
    },
    position: [1300, 380]
  }
});

const stickyEphemerals = node({
  type: 'n8n-nodes-base.stickyNote',
  version: 1,
  config: {
    name: 'Sticky Ephemerals',
    parameters: {
      content: "## response_url ephemerals\n\nThree paths post to response_url with response_type='ephemeral': unauthorized, already_claimed, fallback. Same pattern as the router's fallback ephemeral — no Slack creds needed; response_url is the click's signed return address.",
      height: 200,
      width: 360,
      color: 3
    },
    position: [1320, -380]
  }
});

// ---------------------------------------------------------------------------
// Workflow composition
// ---------------------------------------------------------------------------
export default workflow('', 'Inbound Synthesis - SLA Claim Handler')
  .add(stickyIngress)
  .add(stickyLookups)
  .add(stickyDecide)
  .add(stickyEphemerals)
  .add(stickyClaimPath)
  .add(slackInteraction)
  .to(parsePayload)
  .to(lookupClickerRep)
  .to(lookupLeadState)
  .to(decideOutcome)
  .to(switchByOutcome
    .onCase(0, postUnauthorizedEphemeral)
    .onCase(1, postAlreadyClaimedEphemeral)
    .onCase(2, updateLeadAcknowledged
      .to(buildUpdatedBlocks)
      .to(updateOriginalMessage)
      .to(postThreadedAck))
    .onCase(3, postFallbackEphemeral));
