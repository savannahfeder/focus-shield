// The bouncer's decision, shared by the extension and the Deno server so the
// prompt and the answer's shape live in one place. Keep it free of npm
// imports: Deno loads it by relative path.
import { BOUNCER_SYSTEM_PROMPT } from './bouncer-prompt.ts';

export interface BouncerMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface BouncerSiteMetadata {
  title: string;
  description: string;
}

export interface BouncerAccessAttempt {
  domain: string;
  reason: string;
  timestamp: number;
  outcome: string;
  durationSeconds?: number;
}

export interface BouncerRequest {
  hostname: string;
  reason: string;
  conversationHistory?: BouncerMessage[];
  siteMetadata?: BouncerSiteMetadata | null;
  accessHistory?: BouncerAccessAttempt[];
}

export interface BouncerDecision {
  reasoning: string;
  seconds: number;
  valid: boolean | null;
  message: string;
  followUpQuestion: string | null;
}

export const DEFAULT_OPENAI_MODEL = 'gpt-5.4-mini';

// Strict structured output: OpenAI guarantees this shape, so the null and
// type coercion below is only a backstop. `reasoning` comes first so the model
// writes its analysis before it decides.
export const BOUNCER_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reasoning', 'seconds', 'valid', 'message', 'followUpQuestion'],
  properties: {
    reasoning: { type: 'string' },
    seconds: { type: 'integer' },
    valid: { type: ['boolean', 'null'] },
    message: { type: 'string' },
    followUpQuestion: { type: ['string', 'null'] },
  },
} as const;

export function buildBouncerInput(
  req: BouncerRequest,
  now: number = Date.now()
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const input: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: BOUNCER_SYSTEM_PROMPT },
  ];
  for (const msg of req.conversationHistory ?? []) {
    input.push({ role: msg.role, content: msg.content });
  }

  let userContent = `Site: ${req.hostname}\nReason: ${req.reason}`;
  if (req.siteMetadata) {
    userContent += `\nPage Title: ${req.siteMetadata.title}`;
    if (req.siteMetadata.description) {
      userContent += `\nPage Description: ${req.siteMetadata.description}`;
    }
  }
  if (req.accessHistory && req.accessHistory.length > 0) {
    const historyStr = req.accessHistory
      .slice(0, 10)
      .map((a) => {
        const timeAgo = Math.round((now - a.timestamp) / 60000);
        const timeStr =
          timeAgo < 60 ? `${timeAgo}m ago` : `${Math.round(timeAgo / 60)}h ago`;
        return `- ${timeStr}: "${a.reason}" → ${a.outcome}${
          a.durationSeconds ? ` (${a.durationSeconds}s)` : ''
        }`;
      })
      .join('\n');
    userContent += `\n\nRecent history for this site (last 24h):\n${historyStr}`;
  }
  input.push({ role: 'user', content: userContent });
  return input;
}

export function normalizeDecision(raw: unknown): BouncerDecision {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Bouncer answer was not an object');
  }
  const r = raw as Record<string, unknown>;
  const valid = r.valid === true ? true : r.valid === false ? false : null;
  const n = Number(r.seconds);
  let seconds = Number.isFinite(n) ? Math.round(n) : 0;
  seconds = Math.min(3600, Math.max(0, seconds));
  // An approval with 0 seconds expires the instant it is granted and bounces
  // the user straight back to the block page.
  if (valid === true && seconds <= 0) seconds = 300;
  return {
    reasoning: typeof r.reasoning === 'string' ? r.reasoning : '',
    seconds,
    valid,
    message: typeof r.message === 'string' ? r.message : '',
    followUpQuestion:
      typeof r.followUpQuestion === 'string' && r.followUpQuestion.trim()
        ? r.followUpQuestion
        : null,
  };
}

// Reads the text of a Responses API reply. A refusal or an incomplete reply
// becomes an error rather than a blank decision.
export function readResponsesOutput(body: unknown): string {
  const b = body as {
    status?: string;
    incomplete_details?: { reason?: string } | null;
    error?: { message?: string } | null;
    output?: Array<{
      type?: string;
      content?: Array<{ type?: string; text?: string; refusal?: string }>;
    }>;
  };
  if (b?.error?.message) throw new Error(b.error.message);
  if (b?.status === 'incomplete') {
    throw new Error(`OpenAI reply incomplete: ${b.incomplete_details?.reason ?? 'unknown'}`);
  }
  for (const item of b?.output ?? []) {
    if (item.type !== 'message') continue;
    for (const part of item.content ?? []) {
      if (part.type === 'refusal') throw new Error(`OpenAI refused: ${part.refusal}`);
      if (part.type === 'output_text' && part.text) return part.text;
    }
  }
  throw new Error('OpenAI reply had no text');
}

export interface AskOpenAIOptions {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export async function askOpenAI(
  req: BouncerRequest,
  { apiKey, model = DEFAULT_OPENAI_MODEL, timeoutMs = 20000, fetchImpl = fetch }: AskOpenAIOptions
): Promise<BouncerDecision> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl('https://api.openai.com/v1/responses', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: buildBouncerInput(req),
        reasoning: { effort: 'low' },
        store: false,
        text: {
          format: {
            type: 'json_schema',
            name: 'bouncer_decision',
            strict: true,
            schema: BOUNCER_JSON_SCHEMA,
          },
        },
      }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const detail = (body as { error?: { message?: string } } | null)?.error?.message;
      throw new Error(`OpenAI returned ${res.status}${detail ? `: ${detail}` : ''}`);
    }
    return normalizeDecision(JSON.parse(readResponsesOutput(body)));
  } finally {
    clearTimeout(timer);
  }
}
