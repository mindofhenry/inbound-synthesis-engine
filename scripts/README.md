# scripts/

Demo trigger scripts for the Inbound Synthesis Engine.

## fire-tier1-demo.ps1

Fires a Chili Piper `booking_created` payload at the Tier 1 Demo Path webhook
(`/webhook/tier1-demo`). Each invocation generates a unique synthetic Salesforce
Lead ID and fresh timestamps — no manual payload editing required.

### Usage

```powershell
# Basic (VP Sales title default)
.\scripts\fire-tier1-demo.ps1 `
  -AccountName "Orion Analytics" `
  -ContactEmail "rachel.kim@orionanalytics.io" `
  -ContactName "Rachel Kim" `
  -ContactTitle "VP Engineering"

# Custom title
.\scripts\fire-tier1-demo.ps1 `
  -AccountName "Doom Inc" `
  -ContactEmail "cfo@doom.com" `
  -ContactName "Alex Doom" `
  -ContactTitle "CFO"

# Against the webhook-test URL (workflow inactive / canvas test mode)
.\scripts\fire-tier1-demo.ps1 `
  -AccountName "Orion Analytics" `
  -ContactEmail "rachel.kim@orionanalytics.io" `
  -ContactName "Rachel Kim" `
  -WebhookUrl "https://n8n.mindofhenry.xyz/webhook-test/tier1-demo"
```

### Parameters

| Parameter | Required | Default | Description |
|---|---|---|---|
| `-AccountName` | yes | — | Company name. Used for Salesforce Account SOQL lookup inside the workflow. |
| `-ContactEmail` | yes | — | Contact email. Written to `inbound_tier1_leads_in_flight.contact_email`. |
| `-ContactName` | yes | — | Full name of the contact (first + last). |
| `-ContactTitle` | no | `VP Sales` | Job title. Written to `contact_title`. |
| `-WebhookUrl` | no | `https://n8n.mindofhenry.xyz/webhook/tier1-demo` | Target URL. Switch to `/webhook-test/tier1-demo` when workflow is inactive. |

### What it does

1. Generates a synthetic 18-char Salesforce Lead ID (`00Q5e` + 13 alphanumeric chars).
2. Sets `meeting.start_time` to 3 days from now at 14:00 ET / 19:00 UTC.
3. POSTs the full Chili Piper `booking_created` JSON to the webhook.
4. On success, prints the inserted row UUID and Slack message timestamp.
5. Prints a ready-to-run SQL snippet to verify the row in Supabase.

### Expected output

```
==> Firing Tier 1 Demo Path webhook
    URL:          https://n8n.mindofhenry.xyz/webhook/tier1-demo
    AccountName:  Orion Analytics
    ContactName:  Rachel Kim (VP Engineering)
    ContactEmail: rachel.kim@orionanalytics.io
    SfdcLeadId:   00Q5eXxYzAbCdEfGh
    MeetingStart: 2026-05-04T19:00:00.000Z

==> SUCCESS
    row_id:      xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
    slack_ts:    1746100000.000001

Verify in Supabase:
  SELECT id, account_name, contact_email, open_opp_on_account, slack_message_ts
  FROM inbound_tier1_leads_in_flight
  WHERE id = 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx';
```

### Notes

- The workflow must be **active** for the production URL to respond. Use `-WebhookUrl .../webhook-test/tier1-demo` to test against an inactive workflow from the canvas.
- The Slack DM lands in Marcus Webb's DM (`U0ANRG80F2Q`) — controlled by `DEMO_REP_ID=1` and `DEMO_REP_SLACK_ID=U0ANRG80F2Q` in n8n environment settings.
- If the account name doesn't exist in the DOOM Inc SFDC sandbox, `open_opp_on_account` will be `false` in the inserted row. This is expected — the workflow continues regardless.
- Account names with single quotes (e.g. `O'Brien Tech`) will cause the SFDC SOQL to fail. Use account names without apostrophes for the demo.
