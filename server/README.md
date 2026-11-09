# Focus Shield - Bouncer API

The AI bouncer that decides whether a blocked site gets unblocked, and for how long.

## Setup

The prompt, schema and OpenAI call are shared with the extension in `../client/src/shared/bouncer.ts`.

```bash
echo 'OPENAI_API_KEY="your-key"' > .env
deno task dev                            # http://localhost:8000
```

| Env var | Default | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | required | OpenAI credentials |
| `OPENAI_MODEL` | `gpt-5.4-mini` | Override the model without a code change |

If `/validate` starts returning 500s, check the `detail` field in the response body first: it carries OpenAI's own message.

## API

### GET /health

Returns `{ "ok": true, "model": "gpt-5.4-mini" }`. Use it to confirm which model is live without sending a validation request.

### POST /validate

**Request** (only `reason` and `hostname` are required):

```json
{
  "hostname": "youtube.com",
  "reason": "Need to watch a React tutorial for work",
  "conversationHistory": [{ "role": "user", "content": "..." }],
  "siteMetadata": { "title": "...", "description": "..." },
  "accessHistory": [{ "domain": "youtube.com", "reason": "...", "timestamp": 0, "outcome": "approved" }]
}
```

**Response:**

```json
{
  "reasoning": "Specific work task that needs this site now.",
  "seconds": 900,
  "valid": true,
  "message": "Go ahead, watch that tutorial.",
  "followUpQuestion": null
}
```

- `valid` is `true` (approve), `false` (reject), or `null` (the bouncer wants a follow-up first, in `followUpQuestion`)
- `seconds` is 0 to 3600. It is 0 for rejections and follow-ups, and floored at 300 for approvals
- `reasoning` is the model's chain of thought, shown nowhere in the UI but useful when tuning the prompt

Errors return `{ error, detail, model }` with status 500, where `detail` is the upstream message.
