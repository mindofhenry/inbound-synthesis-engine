import { workflow, node, trigger, newCredential } from '@n8n/workflow-sdk';

// ============================================================================
// External-buttons add (post-MIN-77)
//
// Adds a SECOND actions block alongside the existing Explain + Show contact
// details row. Four external launchers: Outreach, Account Intel, Sales Nav,
// Salesforce. URLs:
//   - Outreach: static https://app.outreach.io/prospects/search (placeholder,
//     no real account-id mapping for synthetic accounts)
//   - Account Intel: static https://app.pocus.com/accounts (placeholder)
//   - Sales Nav: dynamic, encodeURIComponent(account.id) on companyIncluded
//   - Salesforce: dynamic, encodeURIComponent(account.id) on UnifiedSearch
//
// Everything else preserved byte-identical from MIN-77 deploy:
//   - Set Company Context, Query Signal Events, Transform, Score Account +
//     Pick Contact, Synthesize Alert Blurb, Write inbound_alerts Row.
//   - Block Kit layout: MQL header, account/score/counts, divider, primary
//     contact block, synthesis blurb, secondary line, divider, internal
//     actions row, NEW external launchers actions row, context footer.
//   - Sticky DM updated to note external launchers are reinstated.
//
// Router-side note: clicking a Slack button with `url` set still fires the
// interactivity payload to the registered URL. The Slack Interactivity Router
// will receive these action_ids (open_outreach, open_account_intel,
// open_sales_nav, open_salesforce) and currently routes them to the fallback
// case ("This button isn't wired up yet."). To suppress that ephemeral, add
// a separate Switch case in the router that returns 200 OK with empty body
// for these four action_ids. Out of scope for this WF1 update; flagged for
// the next router edit.
// ============================================================================

// ============================================================================
// MIN-77 — WF1 Slack alert redesign
//
// Changes vs `account-alerts.before-min77.json`:
//   1. NEW Set Company Context node (between webhook and query). Bakes in
//      Blast Radius company context for the synthesis prompt to reference.
//   2. Query Signal Events SELECT: added `id` column so signal_events.id
//      can flow through to inbound_alerts.signal_event_ids (BUG 2 fix).
//   3. Transform to Scoring Payload: threads through `event_id` and `email`
//      fields (BUG 1 + BUG 2 fix prep).
//   4. Score Account + Pick Contact: tier-first contact selection per
//      MIN-77 design (Tier1: VP/Vice President/Chief/C-Suite/Director/
//      Head of; Tier2: Lead/Manager/Principal; Tier3: else); within tier,
//      highest first_party point sum wins; carries email forward; emits
//      signal_event_ids[] and synthesis_user_message for downstream nodes.
//   5. NEW Synthesize Alert Blurb node (Anthropic httpRequest, Haiku 4.5,
//      200 max_tokens, system+user constraints from min77-alert-design.md).
//   6. Write inbound_alerts Row INSERT: now includes signal_event_ids
//      (BUG 2 fix) and writes best_contact.email instead of best_contact.id
//      (BUG 1 fix).
//   7. Send a message: new Block Kit per docs/min77-alert-design.md —
//      MQL ALERT header, primary contact block w/ named signal phrase,
//      synthesis blurb section, secondary contacts named-only line
//      (suppressed when zero secondaries), Explain + Show contact details
//      buttons, account/alert/score footer.
//
// Out of scope:
//   - WF2 (Explain Callback) untouched.
//   - Domain derivation (`accountId.replace(/-/g,'') + '.io'`) untouched.
//   - WF1 active state — leave inactive (MIN-38 handles activation).
// ============================================================================

const COMPANY_CONTEXT_VALUE = `# Blast Radius — Company Context

> Single source of truth for synthesis prompts in WF1 (HOT alert), WF2 (Explain Score callback), and WF3. Update here, not in workflow nodes.

## Company

**Blast Radius** is a pipeline intelligence platform that fuses first-party engagement and third-party intent into a single account-level signal feed for revenue teams.

## Core Product

- An account-level signal layer that ingests Marketo/HubSpot form fills, product analytics, 6sense and Bombora intent, Warmly/RB2B visitor identification, and Salesforce CRM state — and emits a synthesized "what just changed and why it matters" view per account.
- Day-to-day users: SDRs and AEs (consume HOT alerts in Slack), RevOps engineers (configure scoring + routing), VPs of Sales (review pipeline coverage and signal-driven outbound performance).
- Primary surface is Slack — alerts land where reps already work, with an Explain action that opens a Claude-generated rationale threaded inline. Secondary surface is a web app for scoring rules, routing, and reporting.
- Distinct from a CDP: Blast Radius does not aim to be the customer record. It writes back to Salesforce and treats CRM as the system of record.

## Ideal Customer Profile

**Firmographic**
- Series A through Series C B2B SaaS
- 50–500 employees
- $5M–$75M ARR
- Existing capture stack already in place (at minimum: Marketo or HubSpot + Salesforce + one intent provider)
- Outbound-led or hybrid GTM motion (not pure PLG)

**Persona**
- Economic buyer: VP RevOps, VP Sales, or Head of Marketing Ops
- Champion: RevOps Engineer / Marketing Ops Manager — owns the scoring model and the Slack routing
- End user: SDR Manager and SDRs running the daily outbound queue

**Disqualifiers (do not pursue)**
- Pre-Series-A or bootstrapped under 50 people — capture stack rarely exists yet
- Enterprise (1000+ employees) with Demandbase/6sense Revenue AI already deployed at platform tier — Blast Radius slots in below them, not against them
- Pure PLG companies with no SDR org — wrong buying motion
- Non-SaaS verticals (services, ecommerce, hardware) — scoring model is not tuned for those signal types

## Top Pains Solved

1. **Fragmented signal stack.** Reps rotate across Marketo, 6sense, Warmly, Bombora, Salesforce, and Slack to piece together "is this account actually warm right now?" Blast Radius collapses that to one alert.
2. **Alert fatigue from single-source scoring.** Intent-only or form-only scoring fires on accounts that aren't actually engaged. Blast Radius requires composition (multiple contacts, multiple sources, velocity) before flagging HOT, so reps trust the queue.
3. **Lost context between signal and outreach.** A rep gets a "high intent" notification and has nothing to say in the first message. Blast Radius attaches a synthesized rationale — what fired, who engaged, in what order — so the rep opens with specifics, not "saw you visiting our site."

## Differentiators

- **Not 6sense / Demandbase.** Those are intent-data platforms with bolt-on scoring. Blast Radius is signal-fusion-first and assumes you already pay one of them — it consumes 6sense as an input rather than replacing it.
- **Not Common Room / Pocus.** Those are PLG-focused community and product-signal tools. Blast Radius is built for outbound-led SaaS where the buying committee never touched the product.
- **Not a Salesforce-native scoring app.** Native scoring runs on CRM-resident fields and lags real-time intent by hours or days. Blast Radius operates outside the CRM, scores on streaming events, and writes summaries back.
- **Synthesis, not just scoring.** Competitors stop at a number. Blast Radius produces a Claude-generated narrative per HOT alert that names the contacts, the events, and the implied buying stage.

## Pricing Model

- Hybrid seat + usage. Seat fee for the RevOps/Ops admin surface; usage metered on accounts-monitored and synthesized-alerts-delivered.
- Three tiers:
  - **Signal** — entry tier. Up to 1,000 monitored accounts, single-source scoring, Slack alerts, no synthesis. Roughly $2K–$4K/month.
  - **Synthesis** — primary tier and the default land. Up to 5,000 monitored accounts, multi-source scoring with composition gating, Claude-generated rationale, Salesforce write-back. Roughly $5K–$12K/month.
  - **Platform** — for teams running 5,000+ accounts or needing custom scoring models, dedicated routing logic, and SSO/SCIM. Custom pricing, typically $15K–$40K/month.
- Annual contracts standard. No free tier; 14-day pilot on synthetic data is the standard pre-sale motion.
- Implementation is self-serve for Signal, guided for Synthesis (typically 2 weeks with a Blast Radius solutions engineer), and bespoke for Platform.
`;

const SYNTHESIS_SYSTEM_PROMPT = `You are the synthesis layer for a B2B GTM alert. A rep just received a Slack notification that an account has crossed the HOT or WARM threshold. Your job is to write one or two sentences explaining why the primary contact's signals matter, grounded in the company_context provided.

Hard rules:
- Reference only the contacts, signals, and timestamps present in the input payload. Do not invent dates, names, titles, signal types, or facts not in the payload.
- Output exactly one or two sentences. No preamble, no markdown, no list formatting, no headers, no quotes.
- Connect the rep's strongest signal (the highest-points event the primary contact touched) to the company_context pain or differentiator that maps to it.
- Do not use em-dashes. Use periods or commas.
- Do not write outbound copy. Do not propose messaging, openers, or what to say to the prospect.
- Do not restate the score, the state (HOT/WARM), the contact's name, or the contact's title — those already appear elsewhere in the alert.
- If the company_context names the buying stage implied by the signals (e.g., evaluation, comparison, late-stage), say so. Otherwise stay descriptive.`;

const TRANSFORM_CODE = `// MIN-77: Aggregate signal_events rows into the {account, signals, contacts} shape.
// Threads through event_id (signal_events.id, uuid) and email (person_email)
// so downstream nodes can populate inbound_alerts.signal_event_ids[] and
// inbound_alerts.best_contact_email correctly.
const rows = $input.all().map(item => item.json);

if (rows.length === 0) {
  return [{ body: { account: { id: null, name: null }, signals: [], contacts: [] } }];
}

const accountId = rows[0].account_id;
const accountName = rows[0].account_name;

function inferRoleTier(title) {
  if (!title) return 'end_user';
  const t = title.toLowerCase();
  if (/\\b(ceo|cfo|cto|cmo|cro|coo|chief|vp|vice president|founder|president)\\b/.test(t)) return 'decision_maker';
  if (/\\b(director|head of|lead|principal|staff|senior)\\b/.test(t)) return 'influencer';
  return 'end_user';
}

const contactsMap = {};
for (const r of rows) {
  if (!r.person_id) continue;
  if (!contactsMap[r.person_id]) {
    contactsMap[r.person_id] = {
      id: r.person_id,
      email: r.person_email || null,
      name: (r.person_email || '').split('@')[0].split('.').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' '),
      title: r.person_title || 'Unknown',
      role_tier: inferRoleTier(r.person_title)
    };
  }
}
const contacts = Object.values(contactsMap);

const now = Date.now();
const typeContactCount = {};
const signals = rows.map((r, idx) => {
  const occurredMs = new Date(r.occurred_at).getTime();
  const daysAgo = Math.max(0, Math.round((now - occurredMs) / 86400000));
  const key = r.event_type + '|' + (r.person_id || 'anon');
  typeContactCount[key] = (typeContactCount[key] || 0) + 1;
  return {
    id: 's' + (idx + 1),
    event_id: r.id,
    type: r.event_type,
    contact_id: r.person_id || null,
    days_ago: daysAgo,
    repeat_count: typeContactCount[key]
  };
});

return [{
  body: {
    account: { id: accountId, name: accountName, domain: (accountId || '').replace(/-/g, '') + '.io' },
    signals: signals,
    contacts: contacts
  }
}];`;

const SCORE_CODE = `// MIN-77: Canonical scoring (unchanged constants) + tier-first primary
// contact selection + signal_event_ids[] + synthesis_user_message build.
const BASE_WEIGHTS = { pricing_page: 25, competitor_compare: 20, ceo_followup_content: 15, whitepaper_form_fill: 12, webinar_attend: 12, docs_page: 8, longform_blog_read: 6 };
const REPEAT_MULTIPLIERS = { pricing_page: 1.5, competitor_compare: 1.5, docs_page: 1.8, longform_blog_read: 1.5 };
const THIRD_PARTY_WEIGHTS = { bombora_surge: 5, g2_compare_view: 5 };
const THIRD_PARTY_CAP = 10;
const VELOCITY_SIGNAL_THRESHOLD = 5;
const VELOCITY_WINDOW_DAYS = 7;
const VELOCITY_MULTIPLIER = 1.3;
const COMPOSITION_BONUS = { three_contacts: 10, four_plus_contacts: 15 };
const HOT_SCORE_THRESHOLD = 80;
const HOT_CONTACT_THRESHOLD = 3;
const MIN_FIRST_PARTY_FOR_HOT = 15;

const payload = $input.first().json.body;
const account = payload.account;
const signals = payload.signals;
const contacts = payload.contacts;

let firstPartyScore = 0;
let thirdPartyRaw = 0;
const scoredSignals = [];

for (const sig of signals) {
  const isThirdParty = Object.prototype.hasOwnProperty.call(THIRD_PARTY_WEIGHTS, sig.type);
  if (isThirdParty) {
    const pts = THIRD_PARTY_WEIGHTS[sig.type] || 0;
    thirdPartyRaw += pts;
    scoredSignals.push({ id: sig.id, event_id: sig.event_id, type: sig.type, contact_id: sig.contact_id, days_ago: sig.days_ago, repeat_count: sig.repeat_count, points: pts, category: "third_party", multiplier_applied: 1.0 });
  } else {
    const base = BASE_WEIGHTS[sig.type] || 0;
    const mult = sig.repeat_count > 1 ? (REPEAT_MULTIPLIERS[sig.type] || 1.0) : 1.0;
    const pts = Math.round(base * mult);
    firstPartyScore += pts;
    scoredSignals.push({ id: sig.id, event_id: sig.event_id, type: sig.type, contact_id: sig.contact_id, days_ago: sig.days_ago, repeat_count: sig.repeat_count, points: pts, category: "first_party", multiplier_applied: mult });
  }
}

const thirdPartyScore = Math.min(thirdPartyRaw, THIRD_PARTY_CAP);
const recentSignals = signals.filter(s => s.days_ago <= VELOCITY_WINDOW_DAYS).length;
const velocityTriggered = recentSignals >= VELOCITY_SIGNAL_THRESHOLD;
const distinctContacts = new Set(signals.filter(s => s.contact_id).map(s => s.contact_id)).size;

let compositionBonus = 0;
if (distinctContacts >= 4) compositionBonus = COMPOSITION_BONUS.four_plus_contacts;
else if (distinctContacts >= 3) compositionBonus = COMPOSITION_BONUS.three_contacts;

const rawScore = firstPartyScore + thirdPartyScore;
const afterVelocity = velocityTriggered ? Math.round(rawScore * VELOCITY_MULTIPLIER) : rawScore;
const finalScore = Math.min(afterVelocity + compositionBonus, 100);
const firstPartyInsufficient = firstPartyScore < MIN_FIRST_PARTY_FOR_HOT;
const isHot = finalScore >= HOT_SCORE_THRESHOLD && distinctContacts >= HOT_CONTACT_THRESHOLD && velocityTriggered && !firstPartyInsufficient;
const state = isHot ? "HOT" : "WARM";

const reasons = [];
if (finalScore >= HOT_SCORE_THRESHOLD) { reasons.push("score " + finalScore + " crossed " + HOT_SCORE_THRESHOLD + " threshold"); } else { reasons.push("score " + finalScore + " below " + HOT_SCORE_THRESHOLD + " threshold"); }
if (distinctContacts >= HOT_CONTACT_THRESHOLD) { reasons.push(distinctContacts + " contacts active"); } else { reasons.push("only " + distinctContacts + " contact(s) active"); }
if (velocityTriggered) { reasons.push("velocity triggered (" + recentSignals + " signals in " + VELOCITY_WINDOW_DAYS + " days)"); } else { reasons.push("velocity not triggered (" + recentSignals + " signals in " + VELOCITY_WINDOW_DAYS + " days)"); }
if (firstPartyInsufficient) { reasons.push("blocked: first-party insufficient"); }
const stateReason = state + ": " + reasons.join(", ");

const contactActivity = {};
for (const sig of signals) {
  if (!sig.contact_id) continue;
  if (!contactActivity[sig.contact_id] || sig.days_ago < contactActivity[sig.contact_id].days_ago) {
    contactActivity[sig.contact_id] = { days_ago: sig.days_ago, last_signal_type: sig.type };
  }
}

// MIN-77: Tier-first selection. Word-boundary regex on title.
function classifyTier(title) {
  if (!title) return 3;
  const t = title;
  if (/\\bVP\\b/i.test(t)) return 1;
  if (/\\b(Vice President|Chief|C-Suite|Director|Head of)\\b/i.test(t)) return 1;
  if (/\\b(Lead|Manager|Principal)\\b/i.test(t)) return 2;
  return 3;
}

// Per-contact first_party point sum (only first_party signals contribute).
const fpSumByContact = {};
for (const s of scoredSignals) {
  if (!s.contact_id || s.category !== "first_party") continue;
  fpSumByContact[s.contact_id] = (fpSumByContact[s.contact_id] || 0) + s.points;
}

const rankedContacts = contacts
  .filter(c => contactActivity[c.id])
  .map(c => ({
    id: c.id,
    email: c.email || null,
    name: c.name,
    title: c.title,
    role_tier: c.role_tier,
    tier: classifyTier(c.title),
    fp_sum: fpSumByContact[c.id] || 0,
    recency: contactActivity[c.id].days_ago,
    last_signal: contactActivity[c.id].last_signal_type
  }))
  .sort((a, b) => (a.tier - b.tier) || (b.fp_sum - a.fp_sum) || (a.recency - b.recency));

const bestContact = rankedContacts[0] || null;

// signal_event_ids[] for inbound_alerts.signal_event_ids (uuid[]). BUG 2 fix.
const signalEventIds = scoredSignals.map(s => s.event_id).filter(Boolean);

// Build the synthesis user message in JS so the httpRequest body stays simple.
let companyContext = '';
try {
  companyContext = $('Set Company Context').first().json.company_context || '';
} catch (e) {
  companyContext = '';
}

const primarySignals = bestContact
  ? scoredSignals.filter(s => s.contact_id === bestContact.id).sort((a, b) => b.points - a.points)
  : [];

const sigCountByContact = {};
for (const s of scoredSignals) {
  if (!s.contact_id) continue;
  sigCountByContact[s.contact_id] = (sigCountByContact[s.contact_id] || 0) + 1;
}

const userLines = [];
userLines.push("Company context (Blast Radius vendor profile):");
userLines.push(companyContext);
userLines.push("");
userLines.push("Account: " + account.name);
userLines.push("Account state: " + state + " (score " + finalScore + "/100)");
userLines.push("Velocity: " + recentSignals + " signals in 7 days, " + distinctContacts + " distinct contacts.");
userLines.push("");
if (bestContact) {
  userLines.push("PRIMARY CONTACT:");
  userLines.push("- Name: " + bestContact.name);
  userLines.push("- Title: " + bestContact.title);
  userLines.push("- Signals (in order of point weight, all within last 30 days):");
  for (const s of primarySignals) {
    const repeat = s.repeat_count > 1 ? " (x" + s.repeat_count + ")" : "";
    userLines.push("  * " + s.type + repeat + " - " + s.days_ago + " days ago, " + s.points + " pts, " + s.category);
  }
  userLines.push("");
}
const secondaryContacts = bestContact ? contacts.filter(c => c.id !== bestContact.id) : contacts;
if (secondaryContacts.length > 0) {
  userLines.push("SECONDARY CONTACTS (named only, signal counts):");
  for (const c of secondaryContacts) {
    userLines.push("- " + c.name + " (" + c.title + "), " + (sigCountByContact[c.id] || 0) + " signals");
  }
  userLines.push("");
}
userLines.push("Write the 1 to 2 sentence synthesis now. Follow every rule in the system prompt.");

const synthesisUserMessage = userLines.join("\\n");

return [{
  account: account,
  scoring: { first_party_score: firstPartyScore, third_party_score: thirdPartyScore, raw_score: rawScore, velocity_triggered: velocityTriggered, velocity_recent_signals: recentSignals, composition_bonus: compositionBonus, distinct_contacts: distinctContacts, final_score: finalScore },
  state: state,
  state_reason: stateReason,
  best_contact: bestContact,
  ranked_contacts: rankedContacts,
  scored_signals: scoredSignals,
  all_contacts: contacts,
  signal_event_ids: signalEventIds,
  synthesis_user_message: synthesisUserMessage
}];`;

// ============================================================================
// Trigger
// ============================================================================
const signalIngest = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Signal Ingest',
    parameters: {
      httpMethod: 'POST',
      path: 'synthesis-ingest',
      responseMode: 'lastNode',
      options: {}
    },
    position: [-800, -16]
  }
});

// ============================================================================
// Set Company Context (NEW for MIN-77)
// ============================================================================
const setCompanyContext = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Set Company Context',
    parameters: {
      mode: 'manual',
      assignments: {
        assignments: [
          {
            id: '4c5ca69d-328e-4d82-b4a5-3c76a3c1a940',
            name: 'company_context',
            value: COMPANY_CONTEXT_VALUE,
            type: 'string'
          }
        ]
      },
      includeOtherFields: true,
      options: {}
    },
    position: [-608, -16]
  }
});

// ============================================================================
// Query Signal Events (modified — adds id column to SELECT for BUG 2 fix)
// ============================================================================
const queryEvents = node({
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
WHERE account_id = '{{ $('Signal Ingest').item.json.body.account_id }}'
  AND occurred_at >= now() - interval '30 days'
ORDER BY occurred_at ASC`,
      options: {}
    },
    credentials: { postgres: newCredential('Beacon Supabase Postgres') },
    position: [-416, -16]
  }
});

// ============================================================================
// Transform to Scoring Payload (modified — threads event_id + email)
// ============================================================================
const transform = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Transform to Scoring Payload',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: TRANSFORM_CODE
    },
    position: [-224, -16]
  }
});

// ============================================================================
// Score Account + Pick Contact (modified — tier-first selection,
// email carry-through, signal_event_ids[], synthesis_user_message build)
// ============================================================================
const score = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Score Account + Pick Contact',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: SCORE_CODE
    },
    position: [-32, -16]
  }
});

// ============================================================================
// Synthesize Alert Blurb (NEW for MIN-77 — Anthropic Haiku 4.5 call)
// ============================================================================
const synthesisBodyExpr = `={{ JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 200, system: ${JSON.stringify(SYNTHESIS_SYSTEM_PROMPT)}, messages: [{ role: "user", content: $json.synthesis_user_message }] }) }}`;

const synthesize = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Synthesize Alert Blurb',
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
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: synthesisBodyExpr,
      options: {}
    },
    credentials: { anthropicApi: newCredential('Anthropic') },
    position: [160, -16]
  }
});

// ============================================================================
// Write inbound_alerts Row (modified — fixes BUG 1 + BUG 2)
//   BUG 1: writes best_contact.email (was best_contact.id)
//   BUG 2: now includes signal_event_ids in INSERT, populated as ARRAY[...]::uuid[]
// ============================================================================
const writeAlert = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Write inbound_alerts Row',
    parameters: {
      operation: 'executeQuery',
      query: `INSERT INTO inbound_alerts (
  account_id, account_name, score, state, tier,
  assigned_rep_id, assigned_rep_slack_id,
  best_contact_email, best_contact_name, best_contact_title,
  score_breakdown, signal_event_ids,
  velocity_window_days, signal_count, contact_count, first_party_points,
  delivered_at
) VALUES (
  '{{ $('Score Account + Pick Contact').item.json.account.id }}',
  '{{ $('Score Account + Pick Contact').item.json.account.name }}',
  {{ $('Score Account + Pick Contact').item.json.scoring.final_score }},
  '{{ $('Score Account + Pick Contact').item.json.state.toLowerCase() }}',
  'tier2',
  1,
  'U0ANRG80F2Q',
  {{ $('Score Account + Pick Contact').item.json.best_contact && $('Score Account + Pick Contact').item.json.best_contact.email ? "'" + $('Score Account + Pick Contact').item.json.best_contact.email + "'" : 'NULL' }},
  {{ $('Score Account + Pick Contact').item.json.best_contact ? "'" + $('Score Account + Pick Contact').item.json.best_contact.name + "'" : 'NULL' }},
  {{ $('Score Account + Pick Contact').item.json.best_contact ? "'" + $('Score Account + Pick Contact').item.json.best_contact.title + "'" : 'NULL' }},
  '{{ JSON.stringify($('Score Account + Pick Contact').item.json.scoring) }}'::jsonb,
  ARRAY[{{ $('Score Account + Pick Contact').item.json.signal_event_ids.map(id => "'" + id + "'").join(',') }}]::uuid[],
  7,
  {{ $('Score Account + Pick Contact').item.json.scored_signals.length }},
  {{ $('Score Account + Pick Contact').item.json.scoring.distinct_contacts }},
  {{ $('Score Account + Pick Contact').item.json.scoring.first_party_score }},
  now()
) RETURNING id`,
      options: {}
    },
    credentials: { postgres: newCredential('Beacon Supabase Postgres') },
    position: [352, -16]
  }
});

// ============================================================================
// Send a message (modified — new MQL Block Kit per MIN-77 design)
//
// Block layout (suppresses block 6 when no secondaries):
//   1. header — "MQL ALERT - Inbound | {STATE}"
//   2. section — account · score · counts
//   3. divider
//   4. section — Primary contact: name, title, comma-joined signal phrase
//   5. section — italic synthesis blurb
//   6. section — secondary contacts (only when secondaries.length > 0)
//   7. divider
//   8. actions — Explain this score + Show contact details
//   9. context — account/alert/score/timestamp footer
// ============================================================================
const slackBlocksExpr = `={{ JSON.stringify((function(){
  var s = $('Score Account + Pick Contact').item.json;
  var blurbResp = $('Synthesize Alert Blurb').item.json;
  var alertResp = $('Write inbound_alerts Row').item.json;
  var blurb = (blurbResp && blurbResp.content && blurbResp.content[0] && blurbResp.content[0].text) ? String(blurbResp.content[0].text).trim() : 'Synthesis unavailable.';
  var alertId = (alertResp && alertResp.id) ? alertResp.id : 'unknown';
  var primary = s.best_contact;
  var primarySigsForContact = primary ? s.scored_signals.filter(function(x){ return x.contact_id === primary.id; }) : [];
  var labels = { pricing_page: 'Pricing page', competitor_compare: 'Competitor compare', ceo_followup_content: 'CEO follow-up content', whitepaper_form_fill: 'Whitepaper download', webinar_attend: 'Webinar attended', docs_page: 'Docs page', longform_blog_read: 'Long-form blog read', bombora_surge: 'Bombora surge', g2_compare_view: 'G2 compare' };
  function phrase(sig){ var label = labels[sig.type] || sig.type; return sig.repeat_count > 1 ? (label + ' x' + sig.repeat_count) : label; }
  var seen = {}; var primaryPhrase = primarySigsForContact.filter(function(x){ if(seen[x.type]) return false; seen[x.type] = true; return true; }).map(phrase).join(', ');
  if (!primaryPhrase) primaryPhrase = 'No tracked signals';
  var secondaries = primary ? s.all_contacts.filter(function(c){ return c.id !== primary.id; }) : s.all_contacts;
  var secondaryLine = secondaries.length > 0 ? ('*' + secondaries.length + (secondaries.length === 1 ? ' other active:* ' : ' others active:* ') + secondaries.map(function(c){ return c.name + ' (' + c.title + ')'; }).join(', ')) : '';
  var blocks = [];
  blocks.push({ type: 'header', text: { type: 'plain_text', text: 'MQL ALERT - Inbound | ' + s.state, emoji: false } });
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '*' + s.account.name + '*  ·  Score *' + s.scoring.final_score + '/100*  ·  ' + s.scored_signals.length + ' signals · ' + s.scoring.distinct_contacts + ' contacts · velocity ' + s.scoring.velocity_recent_signals + ' in 7d' } });
  blocks.push({ type: 'divider' });
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '*Primary contact*\\n*' + (primary ? primary.name : 'No primary contact') + '*' + (primary ? (' · ' + primary.title) : '') + '\\nSignals: ' + primaryPhrase } });
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '_' + blurb + '_' } });
  if (secondaries.length > 0) { blocks.push({ type: 'section', text: { type: 'mrkdwn', text: secondaryLine } }); }
  blocks.push({ type: 'divider' });
  blocks.push({ type: 'actions', elements: [
    { type: 'button', text: { type: 'plain_text', text: 'Explain this score', emoji: false }, value: s.account.id, action_id: 'explain_score', style: 'primary' },
    { type: 'button', text: { type: 'plain_text', text: 'Show contact details', emoji: false }, value: s.account.id, action_id: 'show_contact_details' }
  ] });
  blocks.push({ type: 'actions', elements: [
    { type: 'button', text: { type: 'plain_text', text: 'Outreach', emoji: false }, url: 'https://app.outreach.io/prospects/search', action_id: 'open_outreach' },
    { type: 'button', text: { type: 'plain_text', text: 'Account Intel', emoji: false }, url: 'https://app.pocus.com/accounts', action_id: 'open_account_intel' },
    { type: 'button', text: { type: 'plain_text', text: 'Sales Nav', emoji: false }, url: 'https://linkedin.com/sales/search/people?companyIncluded=' + encodeURIComponent(s.account.id), action_id: 'open_sales_nav' },
    { type: 'button', text: { type: 'plain_text', text: 'Salesforce', emoji: false }, url: 'https://na1.salesforce.com/_ui/search/ui/UnifiedSearchResults?str=' + encodeURIComponent(s.account.id), action_id: 'open_salesforce' }
  ] });
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: 'account \`' + s.account.id + '\` · alert \`' + alertId + '\` · score ' + s.scoring.final_score + ' · ' + new Date().toISOString() }] });
  return { blocks: blocks };
})()) }}`;

const sendMessage = node({
  type: 'n8n-nodes-base.slack',
  version: 2.4,
  config: {
    name: 'Send a message',
    parameters: {
      resource: 'message',
      operation: 'post',
      select: 'user',
      user: { __rl: true, value: 'U0ANRG80F2Q', mode: 'id' },
      messageType: 'block',
      blocksUi: slackBlocksExpr,
      otherOptions: { includeLinkToWorkflow: false }
    },
    credentials: { slackApi: newCredential('Slack account') },
    position: [544, -16]
  }
});

// ============================================================================
// Sticky notes (5 preserved + 1 new for synthesis)
// ============================================================================
const stickyIngest = node({
  type: 'n8n-nodes-base.stickyNote',
  version: 1,
  config: {
    name: 'Sticky Ingest',
    parameters: {
      content: '## Signal Ingest Webhook\n\nDemo trigger. POST { account_id: "..." } to fire a synthesis run.\n\nProduction: same webhook receives signal events from Marketo/6sense/Bombora/Warmly/G2/SFDC, persisted to signal_events first.',
      height: 280
    },
    position: [-1040, -352]
  }
});

const stickyContext = node({
  type: 'n8n-nodes-base.stickyNote',
  version: 1,
  config: {
    name: 'Sticky Context',
    parameters: {
      content: '## Bake in Company Context\n\nSet node holds the Blast Radius vendor profile (config/company_context.md). Synthesis prompt downstream references it via $node["Set Company Context"].json.company_context — single source of truth (MIN-78).',
      height: 200,
      width: 280,
      color: 6
    },
    position: [-672, 176]
  }
});

const stickyQuery = node({
  type: 'n8n-nodes-base.stickyNote',
  version: 1,
  config: {
    name: 'Sticky Query',
    parameters: {
      content: '## Read from Supabase\n\nPulls last 30d signal_events for the account. Single source of truth — no hardcoded fixtures.\n\nMIN-77 update: SELECT now includes id so signal_events.id can populate inbound_alerts.signal_event_ids[].',
      height: 240,
      color: 5
    },
    position: [-432, 176]
  }
});

const stickyScoring = node({
  type: 'n8n-nodes-base.stickyNote',
  version: 1,
  config: {
    name: 'Sticky Scoring',
    parameters: {
      content: '## Scoring Formula v0\n\nFirst-party: pricing=25, competitor=20, CEO follow=15, whitepaper/webinar=12, docs=8, blog=6\nRepeat: pricing/competitor/blog 1.5x, docs 1.8x\nThird-party: 5pts each, capped at 10\nVelocity: 5+ in 7d → 1.3x\nComposition: +10 (3 contacts), +15 (4+)\n\nHOT requires ALL: 80+, 3+ contacts, velocity, first-party 15+\n\nMIN-77: tier-first primary contact (Tier1: VP/Chief/Director/Head of, Tier2: Lead/Manager/Principal); fp-sum tiebreaker.',
      height: 360,
      width: 320,
      color: 4
    },
    position: [-208, 176]
  }
});

const stickySynthesis = node({
  type: 'n8n-nodes-base.stickyNote',
  version: 1,
  config: {
    name: 'Sticky Synthesis',
    parameters: {
      content: '## Synthesize Alert Blurb (MIN-77)\n\nClaude Haiku 4.5 generates a 1–2 sentence rationale grounded in company_context + the primary contact\'s strongest signals. Constraints in the system prompt: cite only payload facts, no preamble, no em-dashes, no outbound copy. MIN-72 validator is a future task.',
      height: 240,
      width: 280,
      color: 4
    },
    position: [128, 176]
  }
});

const stickyAlert = node({
  type: 'n8n-nodes-base.stickyNote',
  version: 1,
  config: {
    name: 'Sticky Alert',
    parameters: {
      content: '## Persist Alert\n\nWrites inbound_alerts row before Slack send. MIN-77 fixes: best_contact_email now stores the actual email (not person_id), and signal_event_ids[] is populated with the contributing event uuids.',
      height: 220,
      color: 3
    },
    position: [336, 176]
  }
});

const stickyDM = node({
  type: 'n8n-nodes-base.stickyNote',
  version: 1,
  config: {
    name: 'Sticky DM',
    parameters: {
      content: '## DM, not channel\n\nBlock Kit layout: MQL ALERT header, primary contact w/ signal phrase, italic synthesis blurb, secondary contacts named-only, two actions rows (1: Explain + Show contact details internal callbacks, 2: Outreach / Account Intel / Sales Nav / Salesforce external launchers), footer with account/alert/score.',
      height: 240,
      color: 6
    },
    position: [544, 176]
  }
});

// ============================================================================
// Workflow assembly
// ============================================================================
export default workflow('3378kEby9ZyhzIOk', 'Inbound Synthesis - Account Alerts v0')
  .add(signalIngest)
  .to(setCompanyContext)
  .to(queryEvents)
  .to(transform)
  .to(score)
  .to(synthesize)
  .to(writeAlert)
  .to(sendMessage)
  .add(stickyIngest)
  .add(stickyContext)
  .add(stickyQuery)
  .add(stickyScoring)
  .add(stickySynthesis)
  .add(stickyAlert)
  .add(stickyDM);
