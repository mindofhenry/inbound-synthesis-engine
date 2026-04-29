# Inbound Synthesis Engine — Claude Code Instructions

## What This Is

Inbound Synthesis Engine reads account-level signals across an existing
capture stack — Marketo, 6sense, Bombora, Warmly, Salesforce — and surfaces
synthesized HOT alerts to reps in Slack. Each alert ties together what
otherwise sits in separate panes of glass: form fills, intent surges,
visitor identification, and CRM context.

**One-line problem statement:** GTM teams already pay for the signals.
Inbound Synthesis Engine fuses them into one alert reps will actually act on.

This is a portfolio GTM Engineering build by Henry Marble. All data is
synthetic. The system is demo-only and Loom-recordable end-to-end.
Targeting GTM Engineering / Revenue Ops Engineer roles. Do not reference
Pave anywhere.

## Tech Stack

- **Data generation / loaders:** Python
- **Schema / queries:** SQL
- **Workflows:** n8n SDK (self-hosted at `n8n.mindofhenry.xyz`)
- **Scripting:** PowerShell (Windows host)
- **Database:** Supabase (Postgres) — shared Beacon Supabase project, ID `qzeehftbbvccqoqdpoey`
- **Alert delivery:** Slack incoming webhook
- **Linear:** system of record. Project `inbound-synthesis-engine-66dbe690d9d7`, team `mindofhenry`.
- **Notion:** proposal pages under parent page `3450592291a88128a6b7c12ef2325338`.

## Repo Structure

```
db/
  migrations/      # SQL migration files — numbered 001, 002, etc.
docs/              # Specs, demo scripts, longer-form artifacts
n8n/
  workflows/       # Validated, exportable n8n workflow JSON
generators/        # Python synthetic-data generators per source system
pipeline/          # Loaders, transforms, synthesis logic
.claude/skills/    # Read the relevant skill before touching that domain
```

## Before You Write Any Code

1. **Read the relevant skill file(s)** from `.claude/skills/`
2. **Read the files you are about to edit** — do not assume you know what is there
3. **Check the migration files** in `db/migrations/` before writing any SQL
4. **Validate n8n workflows** with `n8n:validate_workflow` before `create_workflow_from_code` or `update_workflow`

## planning-with-files — Required Protocol

Maintain three files in the repo root at all times during multi-step work:

- `findings.md` — what you discovered when reading existing code, files, schemas, or data. Write before touching anything.
- `progress.md` — step-by-step status: Not Started / In Progress / Done / Blocked. Update after every step.
- `task_plan.md` — full task list with step numbers and current status. Update after every step.

### Rules
1. Initialize all three files before writing any code. No exceptions.
2. Update all three after each step — not at the end of the session.
3. If blocked, record the blocker in progress.md immediately and stop.
4. Final update to all three files at session end.

These files are gitignored. They are your working memory. Skipping them is not allowed.

## Skills Reference — When to Read Each

| Skill | Read when... |
|---|---|
| `planning-with-files` | Any task requiring 5+ tool calls — invoke at session start |
| `supabase-query-safety` | Writing any database query or migration |
| `supabase-postgres-best-practices` | Designing schema or writing non-trivial SQL |
| `triage-issue` | Investigating a bug — run before attempting a fix |
| `write-a-skill` | Creating a new `.claude/skills/` file |

(Only `planning-with-files` ships in this scaffold. Other skill files get copied in as needed; the protocol applies whether the file is local or not.)

## Branch Strategy

One branch per Linear issue, named per the `gitBranchName` field Linear
generates (e.g., `hhmarble/min-60-scaffold-...`). Merge to `main` after
acceptance. No long-lived feature branches.

## Hard Rules — Things CC Gets Wrong

### Data

- **All data is synthetic.** No real customer data ever lands here. Do not connect to real Marketo, 6sense, Bombora, Warmly, or Salesforce orgs.
- **Synthetic data lives under `data/synthetic/` or `data/seeds/*.local.json`** — gitignored. Never commit it.
- **Be honest about what's wired vs mocked.** Never demo something as live when it's manually fired or hardcoded. The Loom narration must match the wiring.

### Database

- **Beacon Supabase project (`qzeehftbbvccqoqdpoey`) is shared** with beacon-loop and other GTM Engineering portfolio modules. Free tier cap is 2 projects. **Do not create a new Supabase project** without checking with Henry first.
- **No per-user RLS on inbound tables.** This is a single-tenant demo. All queries use the service role key.
- **Migrations are numbered `001_*.sql`, `002_*.sql`, …** in `db/migrations/`. Idempotent where possible. **Never destructive without explicit confirmation** — no `DROP TABLE`, `TRUNCATE`, `ALTER ... DROP COLUMN` without Henry signing off.
- **Always destructure and check errors** on every Supabase or psycopg2 call. Never assume success.

### n8n

- **`n8n:validate_workflow` runs before any `create_workflow_from_code` or `update_workflow`.** Never push an unvalidated workflow.
- **n8n is self-hosted at `n8n.mindofhenry.xyz`.** Don't assume n8n.cloud endpoints or behavior.
- **Workflow JSON exports may carry credentials** — only commit sanitized exports under `n8n/workflows/`. The `.local.json` suffix is reserved for unsafe local exports and is gitignored.

### Cost

- **Cost-bearing decisions get validated before spending.** New paid services, plan upgrades, or anything that touches Henry's wallet — confirm first.

### Branding

- **No Pave references.** Anywhere. Not in code, comments, READMEs, alert copy, demo scripts, or commit messages.

## Database — Key Tables

<!-- TODO: populate after MIN-61/62 lands the inbound schema -->

## Environment Variables

<!-- TODO: populate as wiring lands. At minimum will include: SUPABASE_URL, SUPABASE_KEY (service role), DATABASE_URL, SLACK_WEBHOOK_URL, n8n credentials. Never read or output the .env file. -->

## Common Commands

<!-- TODO: populate as generators (MIN-64) and loaders (MIN-65) land. -->

## Keeping Skills Up to Date

After completing any task, check whether new patterns were introduced that
the relevant skill doesn't cover. If so, update the skill before ending the
session.

**Update `CLAUDE.md` (this file) when:**
- The tech stack changes (new dependency, removed library)
- A new hard rule is identified — something CC got wrong that wasn't covered
- The database tables section changes (new table added, column affects queries)
- Common commands change
- The branch strategy changes

The rule: **if a future CC session would get it wrong without knowing what you just built, update the relevant skill now.**

## Response Format

- Show only the file(s) being changed and the specific diff or replacement
- One concept at a time — do not bundle unrelated changes
- If a change touches more than 3 files, flag it and confirm before proceeding
