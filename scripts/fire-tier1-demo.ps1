<#
.SYNOPSIS
    Fires a high-fidelity Chili Piper booking_created payload at the Tier 1 Demo Path webhook.

.DESCRIPTION
    Generates a unique Chili Piper-shape payload with synthetic timestamps and a
    Salesforce-format Lead ID (00Q5e..., 18 chars) on every invocation.
    Sends POST to the webhook URL and prints the response body (row UUID + slack_ts).

.PARAMETER AccountName
    Company name for the booking. Used for the SFDC Account lookup inside the workflow.
    Example: "Orion Analytics"

.PARAMETER ContactEmail
    Email address of the contact who booked. Required.

.PARAMETER ContactName
    Full name of the contact. Required.

.PARAMETER ContactTitle
    Job title of the contact. Optional. Defaults to "VP Sales".

.PARAMETER WebhookUrl
    Full webhook URL. Defaults to the production Tier 1 Demo Path webhook.
    Use the webhook-test URL when the workflow is inactive (canvas test mode).

.EXAMPLE
    .\fire-tier1-demo.ps1 -AccountName "Orion Analytics" -ContactEmail "rachel.kim@orionanalytics.io" -ContactName "Rachel Kim" -ContactTitle "VP Engineering"

.EXAMPLE
    .\fire-tier1-demo.ps1 -AccountName "Doom Inc" -ContactEmail "cfo@doom.com" -ContactName "Alex Doom" -WebhookUrl "https://n8n.mindofhenry.xyz/webhook-test/tier1-demo"
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$AccountName,

    [Parameter(Mandatory = $true)]
    [string]$ContactEmail,

    [Parameter(Mandatory = $true)]
    [string]$ContactName,

    [Parameter(Mandatory = $false)]
    [string]$ContactTitle = "VP Sales",

    [Parameter(Mandatory = $false)]
    [string]$WebhookUrl = "https://n8n.mindofhenry.xyz/webhook/tier1-demo"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# Generate synthetic Salesforce Lead ID (18 chars: 00Q5e + 13 alphanumeric)
# ---------------------------------------------------------------------------
$chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
$suffix = -join (1..13 | ForEach-Object { $chars[(Get-Random -Maximum $chars.Length)] })
$sfdcLeadId = "00Q5e$suffix"

# ---------------------------------------------------------------------------
# Generate meeting timestamps (booked now, meeting in 3 business days at 2pm ET)
# ---------------------------------------------------------------------------
$now = [System.DateTimeOffset]::UtcNow
$createdAt = $now.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")

# Meeting: 3 days from now, 14:00 ET (19:00 UTC)
$meetingDate = $now.AddDays(3)
$meetingStart = [System.DateTimeOffset]::new(
    $meetingDate.Year, $meetingDate.Month, $meetingDate.Day,
    19, 0, 0, [System.TimeSpan]::Zero
)
$meetingEnd = $meetingStart.AddMinutes(30)

$meetingStartStr = $meetingStart.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
$meetingEndStr   = $meetingEnd.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")

# Guest sub-fields from ContactName
$nameParts   = $ContactName.Trim() -split '\s+', 2
$firstName   = $nameParts[0]
$lastName    = if ($nameParts.Count -gt 1) { $nameParts[1] } else { '' }

# Guest UUID + meeting type UUID
$guestId       = [System.Guid]::NewGuid().ToString()
$meetingTypeId = [System.Guid]::NewGuid().ToString()
$eventId       = [System.Guid]::NewGuid().ToString()

# ---------------------------------------------------------------------------
# Build Chili Piper booking_created payload
# ---------------------------------------------------------------------------
$payload = [ordered]@{
    id         = $eventId
    event_type = "booking_created"
    created_at = $createdAt
    data       = [ordered]@{
        meeting = [ordered]@{
            id               = $sfdcLeadId
            start_time       = $meetingStartStr
            end_time         = $meetingEndStr
            timezone         = "America/New_York"
            location         = "Zoom"
            meeting_type_id  = $meetingTypeId
            meeting_type_name = "Demo"
        }
        guest = [ordered]@{
            id         = $guestId
            email      = $ContactEmail
            name       = $ContactName
            first_name = $firstName
            last_name  = $lastName
            company    = $AccountName
            title      = $ContactTitle
            phone      = "+1-555-0100"
        }
        host = [ordered]@{
            id    = "host-001"
            email = "marcus.webb@doom.com"
            name  = "Marcus Webb"
        }
        route_name = "Inbound Demo Request"
    }
}

$body = $payload | ConvertTo-Json -Depth 10 -Compress

# ---------------------------------------------------------------------------
# Fire the webhook
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "==> Firing Tier 1 Demo Path webhook"
Write-Host "    URL:          $WebhookUrl"
Write-Host "    AccountName:  $AccountName"
Write-Host "    ContactName:  $ContactName ($ContactTitle)"
Write-Host "    ContactEmail: $ContactEmail"
Write-Host "    SfdcLeadId:   $sfdcLeadId"
Write-Host "    MeetingStart: $meetingStartStr"
Write-Host ""

try {
    $response = Invoke-RestMethod `
        -Uri $WebhookUrl `
        -Method POST `
        -ContentType "application/json" `
        -Body $body `
        -TimeoutSec 30

    Write-Host "==> SUCCESS"
    Write-Host "    row_id:      $($response.id)"
    Write-Host "    slack_ts:    $($response.slack_message_ts)"
    Write-Host ""
    Write-Host "Verify in Supabase:"
    Write-Host "  SELECT id, account_name, contact_email, open_opp_on_account, slack_message_ts"
    Write-Host "  FROM inbound_tier1_leads_in_flight"
    Write-Host "  WHERE id = '$($response.id)';"
    Write-Host ""
}
catch {
    Write-Host "==> ERROR: $($_.Exception.Message)" -ForegroundColor Red
    if ($_.Exception.Response) {
        $reader = [System.IO.StreamReader]::new($_.Exception.Response.GetResponseStream())
        $errBody = $reader.ReadToEnd()
        Write-Host "    Response body: $errBody" -ForegroundColor Red
    }
    exit 1
}
