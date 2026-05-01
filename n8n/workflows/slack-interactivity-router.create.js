import { workflow, node, trigger, switchCase } from '@n8n/workflow-sdk';

const PARSE_CODE = `// Slack Interactivity Router — parse the form-encoded Slack payload once.
// Slack delivers application/x-www-form-urlencoded with one field: payload=<json>.
// We capture both the parsed action_id (for Switch routing) and the raw
// payload string (so we can forward it untransformed to internal workflows
// whose parsers already do JSON.parse(body.payload)).
const body = $input.first().json.body || {};
const rawPayload = body.payload || "{}";
let parsed = {};
try { parsed = JSON.parse(rawPayload); } catch (e) { parsed = {}; }

const action = parsed.actions && parsed.actions[0];
return [{
  action_id: action ? action.action_id : null,
  response_url: parsed.response_url || null,
  raw_payload: rawPayload
}];`;

const FORWARD_BODY_EXPR = `={{ JSON.stringify({ payload: $('Parse Slack Payload').item.json.raw_payload }) }}`;

const FALLBACK_BODY_EXPR = `={{ JSON.stringify({ response_type: "ephemeral", text: "This button isn't wired up yet." }) }}`;

const slackInteraction = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Slack Interaction',
    parameters: {
      httpMethod: 'POST',
      path: 'slack-interactivity',
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

const switchByActionId = switchCase({
  type: 'n8n-nodes-base.switch',
  version: 3.4,
  config: {
    name: 'Switch by action_id',
    parameters: {
      mode: 'rules',
      rules: {
        values: [
          {
            conditions: {
              options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
              conditions: [
                {
                  leftValue: '={{ $json.action_id }}',
                  rightValue: 'explain_score',
                  operator: { type: 'string', operation: 'equals' }
                }
              ],
              combinator: 'and'
            },
            renameOutput: true,
            outputKey: 'explain_score'
          },
          {
            conditions: {
              options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
              conditions: [
                {
                  leftValue: '={{ $json.action_id }}',
                  rightValue: 'show_contact_details',
                  operator: { type: 'string', operation: 'equals' }
                }
              ],
              combinator: 'and'
            },
            renameOutput: true,
            outputKey: 'show_contact_details'
          }
        ]
      },
      options: {
        fallbackOutput: 'extra',
        renameFallbackOutput: 'fallback'
      }
    },
    position: [416, 0]
  }
});

const forwardExplain = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Forward to Explain (WF2)',
    parameters: {
      method: 'POST',
      url: 'https://n8n.mindofhenry.xyz/webhook/internal/explain-score',
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: 'content-type', value: 'application/json' }
        ]
      },
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: FORWARD_BODY_EXPR,
      options: {}
    },
    position: [640, -160]
  }
});

const forwardContactDetails = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Forward to Contact Details (WF3)',
    parameters: {
      method: 'POST',
      url: 'https://n8n.mindofhenry.xyz/webhook/internal/contact-details',
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: 'content-type', value: 'application/json' }
        ]
      },
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: FORWARD_BODY_EXPR,
      options: {}
    },
    position: [640, 0]
  }
});

const fallbackEphemeral = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Fallback Ephemeral',
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
      jsonBody: FALLBACK_BODY_EXPR,
      options: {}
    },
    position: [640, 160]
  }
});

const stickyIngress = node({
  type: 'n8n-nodes-base.stickyNote',
  version: 1,
  config: {
    name: 'Sticky Ingress',
    parameters: {
      content: '## Single Slack Interactivity URL\n\nProduction: POST https://n8n.mindofhenry.xyz/webhook/slack-interactivity\n\nThis is the ONE URL registered in the Slack app config. All button clicks land here. responseMode default returns 200 immediately so we stay under Slack\'s 3s budget; the actual reply is fired async by the downstream workflow via its own response_url POST.',
      height: 260,
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
      content: '## Parse once, forward raw\n\nReads body.payload (Slack form-encoded), pulls action_id for Switch routing AND keeps the raw JSON string. Internal workflows (WF2, WF3) re-parse body.payload themselves — forwarding the raw string lets their parsers stay byte-unchanged.',
      height: 220,
      width: 280,
      color: 6
    },
    position: [176, -260]
  }
});

const stickySwitch = node({
  type: 'n8n-nodes-base.stickyNote',
  version: 1,
  config: {
    name: 'Sticky Switch',
    parameters: {
      content: '## Dispatch by action_id\n\nexplain_score → WF2 (Explain Callback)\nshow_contact_details → WF3 (Contact Details Callback)\nfallback → ephemeral "This button isn\'t wired up yet."\n\nAdd new MIN-70 feedback buttons (👍/👎) by appending a third + fourth case here, then building their internal workflows. No Slack-side change required.',
      height: 280,
      width: 320,
      color: 4
    },
    position: [384, -260]
  }
});

const stickyForward = node({
  type: 'n8n-nodes-base.stickyNote',
  version: 1,
  config: {
    name: 'Sticky Forward',
    parameters: {
      content: '## Forward to internal workflows\n\nPOST { payload: <raw-json-string> } as application/json to the matching /webhook/internal/* path. n8n surfaces body.payload identically for form-encoded and JSON requests, so WF2/WF3 parsers see the same shape they always did.',
      height: 220,
      width: 320,
      color: 5
    },
    position: [608, -300]
  }
});

const stickyFallback = node({
  type: 'n8n-nodes-base.stickyNote',
  version: 1,
  config: {
    name: 'Sticky Fallback',
    parameters: {
      content: '## Unknown action_id fallback\n\nAny button whose action_id is not yet registered in Switch lands here. Posts an ephemeral via the click\'s response_url so the rep gets a real response instead of silence. Visible only to the clicker.',
      height: 200,
      width: 320,
      color: 3
    },
    position: [608, 320]
  }
});

export default workflow('slack-interactivity-router', 'Slack Interactivity Router')
  .add(slackInteraction)
  .to(parseSlackPayload)
  .to(switchByActionId
    .onCase(0, forwardExplain)
    .onCase(1, forwardContactDetails)
    .onCase(2, fallbackEphemeral))
  .add(stickyIngress)
  .add(stickyParse)
  .add(stickySwitch)
  .add(stickyForward)
  .add(stickyFallback);
