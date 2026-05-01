import { workflow, node, trigger, newCredential } from '@n8n/workflow-sdk';

// Thread-fix update for WF2 Explain Callback. Mirrors WF3's threaded-ephemeral
// pattern. Replaces the Slack chat.postMessage node ("Send a message") with an
// httpRequest POST to payload.response_url with response_type=ephemeral,
// replace_original=false, thread_ts set to the original alert message ts.
//
// Drops dependency on Slack OAuth credential. Drops Anthropic cred is unchanged.
// Postgres creds unchanged.
//
// Subsequent fixes layered on top:
// - 'anonymous' literal bug (n8n expression engine rejected backslash-escaped
//   double-quotes outside JS string literals)
// - invalid_blocks bug: Claude's 4-paragraph synthesis exceeded Slack's 3000-
//   char per-section limit when packed into one block. POST_BODY_EXPR now
//   splits the synthesis on \\n\\n into separate section blocks and converts
//   **bold** → *bold* (Slack mrkdwn) via split/join. Mirrors WF1's MIN-77
//   IIFE block-building pattern.

const PARSE_CODE = `// Slack sends interactivity data as form-encoded: payload=<json>
// (The router forwards { payload: <raw-json-string> } as JSON; n8n surfaces
// body.payload identically either way.)
// Adds response_url + thread_ts extraction to mirror WF3's threaded-ephemeral pattern.
const body = $input.first().json.body;
const payloadStr = body.payload || "{}";
const payload = JSON.parse(payloadStr);

const action = payload.actions && payload.actions[0];
const accountId = action ? action.value : null;
const userId = payload.user ? payload.user.id : null;
const channelId = payload.channel ? payload.channel.id : null;

// Prefer payload.message.ts; fall back to payload.container.message_ts
// (Slack provides both for block_actions on a posted message; container is
// authoritative when the click happens on a message in a non-trivial surface).
const messageTs = (payload.message && payload.message.ts)
  || (payload.container && payload.container.message_ts)
  || null;

return [{
  account_id: accountId,
  user_id: userId,
  channel_id: channelId,
  message_ts: messageTs,
  thread_ts: messageTs,
  response_url: payload.response_url || null,
  action_id: action ? action.action_id : null
}];`;

const SCORE_CODE = `// Read raw signal_events rows + the most recent inbound_alerts row + the parsed Slack ctx.
// Mirror WF1 transform, then run the canonical scoring formula verbatim. No hardcoded fixtures.

const BASE_WEIGHTS = { pricing_page: 25, competitor_compare: 20, ceo_followup_content: 15, whitepaper_form_fill: 12, webinar_attend: 12, docs_page: 8, longform_blog_read: 6 };
const REPEAT_MULTIPLIERS = { pricing_page: 1.5, competitor_compare: 1.5, docs_page: 1.8, longform_blog_read: 1.5 };
const THIRD_PARTY_WEIGHTS = { bombora_surge: 5, g2_compare_view: 5 };
const THIRD_PARTY_CAP = 10;
const VELOCITY_SIGNAL_THRESHOLD = 5;
const VELOCITY_WINDOW_DAYS = 7;
const VELOCITY_MULTIPLIER = 1.3;
const COMPOSITION_BONUS_THREE = 10;
const COMPOSITION_BONUS_FOUR_PLUS = 15;
const HOT_SCORE_THRESHOLD = 80;
const HOT_CONTACT_THRESHOLD = 3;
const MIN_FIRST_PARTY_FOR_HOT = 15;

const slackCtx = $("Parse Slack Payload").item.json;
const sigRows = $("Query Signal Events").all().map(i => i.json);
const alertRows = $("Query Inbound Alert").all().map(i => i.json);
const persistedAlert = alertRows.length > 0 ? alertRows[0] : null;

if (sigRows.length === 0) {
  return [{
    slack_context: slackCtx,
    error: "No signal_events for account: " + slackCtx.account_id
  }];
}

function inferRoleTier(title) {
  if (!title) return 'end_user';
  const t = title.toLowerCase();
  if (/\\b(ceo|cfo|cto|cmo|cro|coo|chief|vp|vice president|founder|president)\\b/.test(t)) return 'decision_maker';
  if (/\\b(director|head of|lead|principal|staff|senior)\\b/.test(t)) return 'influencer';
  return 'end_user';
}

const accountId = sigRows[0].account_id;
const accountName = sigRows[0].account_name;
const account = { id: accountId, name: accountName, domain: (accountId || '').replace(/-/g, '') + '.io' };

const contactsMap = {};
for (const r of sigRows) {
  if (!r.person_id) continue;
  if (!contactsMap[r.person_id]) {
    contactsMap[r.person_id] = {
      id: r.person_id,
      name: (r.person_email || '').split('@')[0].split('.').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' '),
      title: r.person_title || 'Unknown',
      role_tier: inferRoleTier(r.person_title)
    };
  }
}
const contacts = Object.values(contactsMap);

const now = Date.now();
const typeContactCount = {};
const signals = sigRows.map((r, idx) => {
  const occurredMs = new Date(r.occurred_at).getTime();
  const daysAgo = Math.max(0, Math.round((now - occurredMs) / 86400000));
  const key = r.event_type + '|' + (r.person_id || 'anon');
  typeContactCount[key] = (typeContactCount[key] || 0) + 1;
  return {
    id: 's' + (idx + 1),
    type: r.event_type,
    contact_id: r.person_id || null,
    days_ago: daysAgo,
    repeat_count: typeContactCount[key]
  };
});

let firstPartyScore = 0;
let thirdPartyRaw = 0;
const scoredSignals = [];

for (const sig of signals) {
  const isThirdParty = Object.prototype.hasOwnProperty.call(THIRD_PARTY_WEIGHTS, sig.type);
  if (isThirdParty) {
    const pts = THIRD_PARTY_WEIGHTS[sig.type] || 0;
    thirdPartyRaw += pts;
    scoredSignals.push({ id: sig.id, type: sig.type, contact_id: sig.contact_id, days_ago: sig.days_ago, repeat_count: sig.repeat_count, points: pts, category: "third_party", multiplier_applied: 1.0 });
  } else {
    const base = BASE_WEIGHTS[sig.type] || 0;
    const mult = sig.repeat_count > 1 ? (REPEAT_MULTIPLIERS[sig.type] || 1.0) : 1.0;
    const pts = Math.round(base * mult);
    firstPartyScore += pts;
    scoredSignals.push({ id: sig.id, type: sig.type, contact_id: sig.contact_id, days_ago: sig.days_ago, repeat_count: sig.repeat_count, points: pts, category: "first_party", multiplier_applied: mult });
  }
}

const thirdPartyScore = Math.min(thirdPartyRaw, THIRD_PARTY_CAP);
const recentSignals = signals.filter(s => s.days_ago <= VELOCITY_WINDOW_DAYS).length;
const velocityTriggered = recentSignals >= VELOCITY_SIGNAL_THRESHOLD;
const distinctContacts = new Set(signals.filter(s => s.contact_id).map(s => s.contact_id)).size;

let compositionBonus = 0;
if (distinctContacts >= 4) compositionBonus = COMPOSITION_BONUS_FOUR_PLUS;
else if (distinctContacts >= 3) compositionBonus = COMPOSITION_BONUS_THREE;

const rawScore = firstPartyScore + thirdPartyScore;
const afterVelocity = velocityTriggered ? Math.round(rawScore * VELOCITY_MULTIPLIER) : rawScore;
const finalScore = Math.min(afterVelocity + compositionBonus, 100);
const isHot = finalScore >= HOT_SCORE_THRESHOLD && distinctContacts >= HOT_CONTACT_THRESHOLD && velocityTriggered && firstPartyScore >= MIN_FIRST_PARTY_FOR_HOT;
const state = isHot ? "HOT" : "WARM";

const contactActivity = {};
for (const sig of signals) {
  if (!sig.contact_id) continue;
  if (!contactActivity[sig.contact_id] || sig.days_ago < contactActivity[sig.contact_id].days_ago) {
    contactActivity[sig.contact_id] = { days_ago: sig.days_ago, last_signal_type: sig.type };
  }
}
const tierRank = { decision_maker: 3, influencer: 2, end_user: 1 };
const rankedContacts = contacts.filter(c => contactActivity[c.id]).map(c => ({ id: c.id, name: c.name, title: c.title, role_tier: c.role_tier, rank: tierRank[c.role_tier] || 0, recency: contactActivity[c.id].days_ago, last_signal: contactActivity[c.id].last_signal_type })).sort((a, b) => b.rank - a.rank || a.recency - b.recency);
const bestContact = rankedContacts[0] || null;

return [{
  slack_context: slackCtx,
  account: account,
  scoring: {
    first_party_score: firstPartyScore,
    third_party_score: thirdPartyScore,
    raw_score: rawScore,
    velocity_triggered: velocityTriggered,
    velocity_recent_signals: recentSignals,
    composition_bonus: compositionBonus,
    distinct_contacts: distinctContacts,
    final_score: finalScore
  },
  state: state,
  best_contact: bestContact,
  scored_signals: scoredSignals,
  all_contacts: contacts,
  persisted_alert: persistedAlert
}];`;

const CLAUDE_BODY_EXPR = `={{ JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 800, system: "You are a GTM synthesis layer explaining an account score to a rep. Produce a detailed explanation covering: (1) what specific signals drove this score, (2) why the scoring logic classified it as HOT or WARM, (3) what the buying committee composition tells us, (4) why the recommended contact is the right entry point. Cite every signal with timestamp. Ground every claim in the data. Do NOT write outbound copy. Do NOT suggest specific messaging. Do not use em-dashes. Format as short paragraphs, no more than 4 paragraphs total.", messages: [{ role: "user", content: "Account: " + $json.account.name + " (" + $json.account.domain + ")\\nState: " + $json.state + "\\nScore: " + $json.scoring.final_score + "/100\\nFirst-party score: " + $json.scoring.first_party_score + "\\nThird-party score: " + $json.scoring.third_party_score + " (capped)\\nVelocity: " + $json.scoring.velocity_recent_signals + " signals in last 7 days\\nCommittee size: " + $json.scoring.distinct_contacts + " distinct contacts\\n\\nAll scored signals (last 30 days):\\n" + $json.scored_signals.map(function(s) { return "- " + s.type + " (contact: " + (s.contact_id || 'anonymous') + ", " + s.days_ago + "d ago, " + s.points + "pts" + (s.multiplier_applied > 1 ? ", " + s.multiplier_applied + "x repeat multiplier" : "") + ", " + s.category + ")"; }).join("\\n") + "\\n\\nBuying committee:\\n" + $json.all_contacts.map(function(c) { return "- " + c.name + ", " + c.title + " (" + c.role_tier + ")"; }).join("\\n") + "\\n\\nRecommended contact: " + $json.best_contact.name + ", " + $json.best_contact.title + " (last signal: " + $json.best_contact.last_signal + ", " + $json.best_contact.recency + "d ago)\\n\\nProduce a thorough explanation of this score for the rep." }] }) }}`;

// Threaded ephemeral body — mirrors WF3 pattern exactly. Block Kit content
// preserved verbatim from prior WF2 Send a message node.
// Build blocks via IIFE so we can split the Claude synthesis on paragraph
// boundaries (Slack's section text limit is 3000 chars, the 4-paragraph
// synthesis can exceed that as one block) and convert **bold** -> *bold*
// for Slack mrkdwn rendering.
const POST_BODY_EXPR = `={{ JSON.stringify((function(){
  var s = $('Build Scoring Payload + Score').item.json;
  var synthesisText = ($json && $json.content && $json.content[0] && $json.content[0].text) ? String($json.content[0].text) : 'Synthesis unavailable.';
  var synthesisChunks = synthesisText.split('\\n\\n').map(function(c){ return c.split('**').join('*').trim(); }).filter(function(c){ return c.length > 0; });
  var synthesisBlocks = synthesisChunks.map(function(c){ return { type: 'section', text: { type: 'mrkdwn', text: c } }; });
  var ledger = s.scored_signals.map(function(x){ return '• *' + x.type + '* — ' + x.days_ago + 'd ago — ' + x.points + ' pts' + (x.multiplier_applied > 1 ? ' (' + x.multiplier_applied + 'x repeat)' : '') + ' — ' + (x.contact_id || 'anonymous'); }).join('\\n');
  var blocks = [{ type: 'header', text: { type: 'plain_text', text: 'Scoring breakdown: ' + s.account.name } }]
    .concat(synthesisBlocks)
    .concat([
      { type: 'divider' },
      { type: 'section', text: { type: 'mrkdwn', text: '*Signal ledger (' + s.scored_signals.length + ' total)*' } },
      { type: 'section', text: { type: 'mrkdwn', text: ledger } }
    ]);
  return { response_type: 'ephemeral', replace_original: false, thread_ts: $('Parse Slack Payload').item.json.thread_ts, blocks: blocks };
})()) }}`;

const slackInteraction = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Slack Interaction',
    parameters: {
      httpMethod: 'POST',
      path: 'internal/explain-score',
      options: {}
    },
    position: [0, 0]
  }
});

const parseSlackPayload = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Parse Slack Payload',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: PARSE_CODE
    },
    position: [208, 0]
  }
});

const querySignalEvents = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Query Signal Events',
    parameters: {
      operation: 'executeQuery',
      query: `SELECT
  account_id,
  account_name,
  person_id,
  person_email,
  person_title,
  source,
  event_type,
  signal_weight,
  first_party,
  occurred_at
FROM signal_events
WHERE account_id = '{{ $("Parse Slack Payload").item.json.account_id }}'
  AND occurred_at >= now() - interval '30 days'
ORDER BY occurred_at ASC`,
      options: {}
    },
    credentials: { postgres: newCredential('Beacon Supabase Postgres') },
    position: [416, 0]
  }
});

const queryInboundAlert = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Query Inbound Alert',
    parameters: {
      operation: 'executeQuery',
      query: `SELECT
  id,
  account_id,
  score,
  state,
  score_breakdown,
  signal_count,
  contact_count,
  first_party_points,
  delivered_at
FROM inbound_alerts
WHERE account_id = '{{ $("Parse Slack Payload").item.json.account_id }}'
ORDER BY delivered_at DESC
LIMIT 1`,
      options: {}
    },
    credentials: { postgres: newCredential('Beacon Supabase Postgres') },
    executeOnce: true,
    position: [608, 0]
  }
});

const buildAndScore = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Scoring Payload + Score',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: SCORE_CODE
    },
    executeOnce: true,
    position: [800, 0]
  }
});

const claudeSynthesis = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Claude Synthesis',
    parameters: {
      method: 'POST',
      url: 'https://api.anthropic.com/v1/messages',
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'anthropicApi',
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: 'anthropic-version', value: '2023-06-01' },
          { name: 'content-type', value: 'application/json' }
        ]
      },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: CLAUDE_BODY_EXPR,
      options: {}
    },
    credentials: { anthropicApi: newCredential('Anthropic') },
    position: [1008, 0]
  }
});

// Replaces the prior "Send a message" Slack node. Posts threaded ephemeral
// via signed response_url — no Slack OAuth credential needed. Mirrors WF3.
const postEphemeral = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Post Threaded Ephemeral',
    parameters: {
      method: 'POST',
      url: '={{ $(\'Parse Slack Payload\').item.json.response_url }}',
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: 'content-type', value: 'application/json' }
        ]
      },
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: POST_BODY_EXPR,
      options: {}
    },
    position: [1216, 0]
  }
});

const stickyIngress = node({
  type: 'n8n-nodes-base.stickyNote',
  version: 1,
  config: {
    name: 'Sticky Ingress',
    parameters: {
      content: '## Internal webhook (router-fronted)\n\nLives at /webhook/internal/explain-score. Receives forwarded payloads from the Slack Interactivity Router; the router strips the Slack form-encoded envelope and posts { payload: <raw-json-string> } as JSON. Parser below sees body.payload identically to before, plus extracts response_url + thread_ts for the threaded-ephemeral reply.',
      height: 220,
      width: 380,
      color: 6
    },
    position: [-32, -208]
  }
});

const stickyRead = node({
  type: 'n8n-nodes-base.stickyNote',
  version: 1,
  config: {
    name: 'Sticky Read',
    parameters: {
      content: '## Read real signals + last persisted alert from Supabase\n\nQuery Signal Events: 30d signal_events for the account (mirrors WF1).\nQuery Inbound Alert: most recent inbound_alerts row, executeOnce so it does not multiply across signal rows.',
      height: 180,
      width: 380,
      color: 5
    },
    position: [400, -208]
  }
});

const stickyScore = node({
  type: 'n8n-nodes-base.stickyNote',
  version: 1,
  config: {
    name: 'Sticky Score',
    parameters: {
      content: '## Recompute score (canonical formula, parity with WF1)\n\nTransform rows → account/signals/contacts, then run the canonical scoring math. Surfaces raw_score and composition_bonus. No hardcoded fixtures.',
      height: 180,
      width: 280,
      color: 4
    },
    position: [800, -208]
  }
});

const stickyExplain = node({
  type: 'n8n-nodes-base.stickyNote',
  version: 1,
  config: {
    name: 'Sticky Explain',
    parameters: {
      content: '## Claude explains the score, threaded reply\n\nClaude Haiku 4.5 produces a 4-paragraph explanation grounded in the signal ledger.',
      height: 200,
      width: 236,
      color: 4
    },
    position: [1008, -240]
  }
});

const stickyPost = node({
  type: 'n8n-nodes-base.stickyNote',
  version: 1,
  config: {
    name: 'Sticky Post',
    parameters: {
      content: '## Post threaded ephemeral (mirrors WF3)\n\nPOST to response_url with response_type=ephemeral, replace_original=false, thread_ts=parent alert ts. response_url is a signed Slack URL valid for 30 minutes; no Slack OAuth credential needed. Reply lands in the alert DM thread, visible only to the rep who clicked.',
      height: 240,
      width: 320,
      color: 3
    },
    position: [1184, -260]
  }
});

export default workflow('yU1s6WS1N7vvgEGO', 'Inbound Synthesis - Explain Callback v0')
  .add(slackInteraction)
  .to(parseSlackPayload)
  .to(querySignalEvents)
  .to(queryInboundAlert)
  .to(buildAndScore)
  .to(claudeSynthesis)
  .to(postEphemeral)
  .add(stickyIngress)
  .add(stickyRead)
  .add(stickyScore)
  .add(stickyExplain)
  .add(stickyPost);
