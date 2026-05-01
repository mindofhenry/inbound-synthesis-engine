# Blast Radius — Company Context

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
