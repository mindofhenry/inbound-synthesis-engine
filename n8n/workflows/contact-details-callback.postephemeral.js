import { workflow, node, trigger, newCredential } from '@n8n/workflow-sdk';

// WF3 update — Fix 1: response_url ephemerals do not nest under the parent
// alert message in Slack DMs. Switch to chat.postEphemeral Web API
// (POST https://slack.com/api/chat.postEphemeral) with slackApi credential.
// thread_ts in the body actually threads. classifyTier regex, signal-phrase
// formatter, Block Kit content all preserved byte-identical.

const PARSE_CODE = `// MIN-79 WF3: Slack interactivity payload parser.
const body = $input.first().json.body;
const payloadStr = body.payload || "{}";
const payload = JSON.parse(payloadStr);

const action = payload.actions && payload.actions[0];
const accountId = action ? action.value : null;
const userId = payload.user ? payload.user.id : null;
const channelId = payload.channel ? payload.channel.id : null;
const messageTs = payload.message ? payload.message.ts : null;

return [{
  account_id: accountId,
  user_id: userId,
  channel_id: channelId,
  thread_ts: messageTs,
  response_url: payload.response_url || null,
  action_id: action ? action.action_id : null
}];`;

const FORMAT_CODE = `// MIN-79 WF3: Identify primary contact + format Block Kit blocks for secondaries.

const BASE_WEIGHTS = { pricing_page: 25, competitor_compare: 20, ceo_followup_content: 15, whitepaper_form_fill: 12, webinar_attend: 12, docs_page: 8, longform_blog_read: 6 };
const REPEAT_MULTIPLIERS = { pricing_page: 1.5, competitor_compare: 1.5, docs_page: 1.8, longform_blog_read: 1.5 };
const THIRD_PARTY_WEIGHTS = { bombora_surge: 5, g2_compare_view: 5 };

const LABELS = {
  pricing_page: 'Pricing page',
  competitor_compare: 'Competitor compare',
  ceo_followup_content: 'CEO follow-up content',
  whitepaper_form_fill: 'Whitepaper download',
  webinar_attend: 'Webinar attended',
  docs_page: 'Docs page',
  longform_blog_read: 'Long-form blog read',
  bombora_surge: 'Bombora surge',
  g2_compare_view: 'G2 compare'
};

function classifyTier(title) {
  if (!title) return 3;
  const t = title;
  if (/\\bVP\\b/i.test(t)) return 1;
  if (/\\b(Vice President|Chief|C-Suite|Director|Head of)\\b/i.test(t)) return 1;
  if (/\\b(Lead|Manager|Principal)\\b/i.test(t)) return 2;
  return 3;
}

const slackCtx = $('Parse Slack Payload').item.json;
const sigRows = $('Query Signal Events').all().map(i => i.json);

if (sigRows.length === 0) {
  return [{
    slack_context: slackCtx,
    account_id: slackCtx.account_id,
    primary: null,
    secondaries: [],
    anonymous_signals: [],
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: '*Other contacts active on this account*' } },
      { type: 'section', text: { type: 'mrkdwn', text: 'No other contacts on this account in the last 30 days.' } }
    ]
  }];
}

const accountId = sigRows[0].account_id;
const accountName = sigRows[0].account_name;

const now = Date.now();
const typeContactCount = {};
const contactsMap = {};
const anonymousSignals = [];

for (const r of sigRows) {
  const occurredMs = new Date(r.occurred_at).getTime();
  const daysAgo = Math.max(0, Math.round((now - occurredMs) / 86400000));
  const key = r.event_type + '|' + (r.person_id || 'anon');
  typeContactCount[key] = (typeContactCount[key] || 0) + 1;
  const repeatCount = typeContactCount[key];

  const isThirdParty = Object.prototype.hasOwnProperty.call(THIRD_PARTY_WEIGHTS, r.event_type);
  let points = 0;
  let category = 'first_party';
  if (isThirdParty) {
    points = THIRD_PARTY_WEIGHTS[r.event_type] || 0;
    category = 'third_party';
  } else {
    const base = BASE_WEIGHTS[r.event_type] || 0;
    const mult = repeatCount > 1 ? (REPEAT_MULTIPLIERS[r.event_type] || 1.0) : 1.0;
    points = Math.round(base * mult);
  }

  const sig = {
    type: r.event_type,
    days_ago: daysAgo,
    repeat_count: repeatCount,
    points: points,
    category: category
  };

  if (!r.person_id) {
    anonymousSignals.push(sig);
    continue;
  }

  if (!contactsMap[r.person_id]) {
    contactsMap[r.person_id] = {
      id: r.person_id,
      email: r.person_email || null,
      name: (r.person_email || '').split('@')[0].split('.').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' '),
      title: r.person_title || 'Unknown',
      tier: classifyTier(r.person_title),
      signals: [],
      fp_sum: 0,
      most_recent: Number.MAX_SAFE_INTEGER
    };
  }
  const c = contactsMap[r.person_id];
  c.signals.push(sig);
  if (sig.category === 'first_party') c.fp_sum += sig.points;
  if (daysAgo < c.most_recent) c.most_recent = daysAgo;
}

const contacts = Object.values(contactsMap);

contacts.sort((a, b) => (a.tier - b.tier) || (b.fp_sum - a.fp_sum) || (a.most_recent - b.most_recent));

const primary = contacts[0] || null;
const secondaries = primary ? contacts.slice(1) : contacts;

function phrase(sig) {
  const label = LABELS[sig.type] || sig.type;
  return sig.repeat_count > 1 ? (label + ' x' + sig.repeat_count) : label;
}
function buildPhrase(signals) {
  const sorted = signals.slice().sort((a, b) => b.points - a.points);
  const seen = {};
  return sorted
    .filter(x => { if (seen[x.type]) return false; seen[x.type] = true; return true; })
    .map(phrase)
    .join(', ');
}

const blocks = [];
blocks.push({
  type: 'section',
  text: { type: 'mrkdwn', text: '*Other contacts active on this account*' }
});

if (secondaries.length === 0 && anonymousSignals.length === 0) {
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: 'No other contacts on this account in the last 30 days.' }
  });
} else {
  for (const c of secondaries) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '*' + c.name + '* · *' + c.title + '*\\n' + (buildPhrase(c.signals) || 'No tracked signals') }
    });
  }
  if (anonymousSignals.length > 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '*Anonymous third-party intent*\\n' + buildPhrase(anonymousSignals) }
    });
  }
}

blocks.push({
  type: 'context',
  elements: [{ type: 'mrkdwn', text: 'account \`' + accountId + '\` · ' + (accountName || '') + ' · alert reference \`' + (slackCtx.thread_ts || 'unknown') + '\`' }]
});

return [{
  slack_context: slackCtx,
  account_id: accountId,
  account_name: accountName,
  primary: primary ? { id: primary.id, name: primary.name, title: primary.title, tier: primary.tier, fp_sum: primary.fp_sum } : null,
  secondaries: secondaries.map(c => ({ id: c.id, name: c.name, title: c.title, tier: c.tier, fp_sum: c.fp_sum, signal_count: c.signals.length })),
  anonymous_signal_count: anonymousSignals.length,
  blocks: blocks
}];`;

// Fix 1: chat.postEphemeral body. channel + user from parsed Slack ctx,
// thread_ts threads under parent alert, blocks carry the formatted secondaries.
const POST_BODY_EXPR = `={{ JSON.stringify({ channel: $('Parse Slack Payload').item.json.channel_id, user: $('Parse Slack Payload').item.json.user_id, thread_ts: $('Parse Slack Payload').item.json.thread_ts, text: 'Other contacts active on this account', blocks: $json.blocks }) }}`;

const slackInteraction = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Slack Interaction',
    parameters: {
      httpMethod: 'POST',
      path: 'internal/contact-details',
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
  id,
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
WHERE account_id = '{{ $('Parse Slack Payload').item.json.account_id }}'
  AND occurred_at >= now() - interval '30 days'
ORDER BY occurred_at ASC`,
      options: {}
    },
    credentials: { postgres: newCredential('Beacon Supabase Postgres') },
    position: [416, 0]
  }
});

const identifyAndFormat = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Identify Primary + Format Secondaries',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: FORMAT_CODE
    },
    position: [624, 0]
  }
});

// Fix 1: switch from response_url POST to chat.postEphemeral Web API.
const postEphemeral = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Post Threaded Ephemeral',
    parameters: {
      method: 'POST',
      url: 'https://slack.com/api/chat.postEphemeral',
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'slackApi',
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
    credentials: { slackApi: newCredential('Slack account') },
    position: [832, 0]
  }
});

const stickyWebhook = node({
  type: 'n8n-nodes-base.stickyNote',
  version: 1,
  config: {
    name: 'Sticky Webhook',
    parameters: {
      content: '## Internal webhook (router-fronted)\n\nLives at /webhook/internal/contact-details. Receives forwarded payloads from the Slack Interactivity Router; the router strips the form-encoded envelope and posts { payload: <raw-json-string> } as JSON.',
      height: 220,
      width: 360,
      color: 6
    },
    position: [-32, -260]
  }
});

const stickyParse = node({
  type: 'n8n-nodes-base.stickyNote',
  version: 1,
  config: {
    name: 'Sticky Parse',
    parameters: {
      content: '## Parse interactivity payload\n\nExtracts account_id (from button value), channel_id, user_id, thread_ts (parent alert message ts).',
      height: 200,
      width: 280,
      color: 6
    },
    position: [176, -260]
  }
});

const stickyQuery = node({
  type: 'n8n-nodes-base.stickyNote',
  version: 1,
  config: {
    name: 'Sticky Query',
    parameters: {
      content: '## Read 30d signal_events\n\nSame SELECT shape as WF1: pulls all signal_events for the clicked account in the last 30 days. Single source of truth, no fixtures.',
      height: 200,
      width: 280,
      color: 5
    },
    position: [384, -260]
  }
});

const stickyFormat = node({
  type: 'n8n-nodes-base.stickyNote',
  version: 1,
  config: {
    name: 'Sticky Format',
    parameters: {
      content: '## Identify primary, format secondaries\n\nclassifyTier regex byte-identical to WF1 post-MIN-77 (Tier1: VP / Vice President / Chief / C-Suite / Director / Head of; Tier2: Lead / Manager / Principal; Tier3: else). Primary = top tier + highest first-party point sum + recency tiebreak. Builds Block Kit blocks for everyone else. Anonymous person_id rows aggregate into a single "Anonymous third-party intent" block.',
      height: 280,
      width: 320,
      color: 4
    },
    position: [592, -300]
  }
});

const stickyPost = node({
  type: 'n8n-nodes-base.stickyNote',
  version: 1,
  config: {
    name: 'Sticky Post',
    parameters: {
      content: '## Threaded ephemeral via chat.postEphemeral\n\nresponse_url ephemerals do not nest under parent messages. Switched to chat.postEphemeral Web API with slackApi credential. thread_ts in the body actually threads.',
      height: 240,
      width: 320,
      color: 3
    },
    position: [800, -260]
  }
});

export default workflow('P0bOfQyk525cjnQK', 'Contact Details Callback')
  .add(slackInteraction)
  .to(parseSlackPayload)
  .to(querySignalEvents)
  .to(identifyAndFormat)
  .to(postEphemeral)
  .add(stickyWebhook)
  .add(stickyParse)
  .add(stickyQuery)
  .add(stickyFormat)
  .add(stickyPost);
