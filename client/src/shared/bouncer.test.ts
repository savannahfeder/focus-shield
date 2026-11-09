// The bouncer moved from Groq behind a hosted server to OpenAI's Responses API
// with a strict schema, called from the extension itself. These pin the
// request it sends and how it reads every kind of reply.
import { describe, expect, it, vi } from 'vitest';
import {
  askOpenAI,
  BOUNCER_JSON_SCHEMA,
  buildBouncerInput,
  DEFAULT_OPENAI_MODEL,
  normalizeDecision,
  readResponsesOutput,
} from './bouncer';
import { BOUNCER_SYSTEM_PROMPT } from './bouncer-prompt';

const reply = (decision: object) => ({
  status: 'completed',
  output: [
    { type: 'reasoning', summary: [] },
    { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(decision) }] },
  ],
});

describe('normalizeDecision', () => {
  it('passes a clean approval through', () => {
    expect(
      normalizeDecision({ reasoning: 'r', seconds: 900, valid: true, message: 'Go', followUpQuestion: null })
    ).toEqual({ reasoning: 'r', seconds: 900, valid: true, message: 'Go', followUpQuestion: null });
  });

  it('floors a zero-second approval at five minutes', () => {
    expect(normalizeDecision({ valid: true, seconds: 0 }).seconds).toBe(300);
  });

  it('keeps zero seconds for a rejection and a follow-up', () => {
    expect(normalizeDecision({ valid: false, seconds: 0 }).seconds).toBe(0);
    expect(normalizeDecision({ valid: null, seconds: 0, followUpQuestion: 'Now?' })).toMatchObject({
      seconds: 0,
      valid: null,
      followUpQuestion: 'Now?',
    });
  });

  it('clamps seconds into 0..3600 and rounds them', () => {
    expect(normalizeDecision({ valid: true, seconds: 99999 }).seconds).toBe(3600);
    expect(normalizeDecision({ valid: false, seconds: -5 }).seconds).toBe(0);
    expect(normalizeDecision({ valid: true, seconds: 44.6 }).seconds).toBe(45);
  });

  it('treats anything but a boolean as a follow-up and fills missing text', () => {
    expect(normalizeDecision({ valid: 'yes', seconds: 'x', message: null })).toEqual({
      reasoning: '',
      seconds: 0,
      valid: null,
      message: '',
      followUpQuestion: null,
    });
  });

  it('drops a blank follow-up question', () => {
    expect(normalizeDecision({ valid: null, followUpQuestion: '  ' }).followUpQuestion).toBeNull();
  });

  it('refuses something that is not an object', () => {
    expect(() => normalizeDecision('nope')).toThrow();
  });
});

describe('readResponsesOutput', () => {
  it('finds the message text after a reasoning item', () => {
    expect(readResponsesOutput(reply({ a: 1 }))).toBe('{"a":1}');
  });

  it('turns a refusal, an incomplete reply and an error into errors', () => {
    expect(() =>
      readResponsesOutput({ output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] })
    ).toThrow(/refused/);
    expect(() =>
      readResponsesOutput({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } })
    ).toThrow(/max_output_tokens/);
    expect(() => readResponsesOutput({ error: { message: 'boom' } })).toThrow('boom');
    expect(() => readResponsesOutput({ output: [] })).toThrow(/no text/);
  });
});

describe('buildBouncerInput', () => {
  it('puts the prompt first, then the conversation, then the request with context', () => {
    const now = Date.UTC(2026, 0, 1, 12);
    const input = buildBouncerInput(
      {
        hostname: 'youtube.com',
        reason: 'tutorial',
        conversationHistory: [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'Need it now?' },
        ],
        siteMetadata: { title: 'React', description: 'Hooks' },
        accessHistory: [
          { domain: 'youtube.com', reason: 'old', timestamp: now - 5 * 60000, outcome: 'approved', durationSeconds: 60 },
          { domain: 'youtube.com', reason: 'older', timestamp: now - 3 * 3600000, outcome: 'rejected' },
        ],
      },
      now
    );
    expect(input[0]).toEqual({ role: 'system', content: BOUNCER_SYSTEM_PROMPT });
    expect(input.slice(1, 3).map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(input[3].content).toBe(
      'Site: youtube.com\nReason: tutorial\nPage Title: React\nPage Description: Hooks\n\n' +
        'Recent history for this site (last 24h):\n- 5m ago: "old" → approved (60s)\n- 3h ago: "older" → rejected'
    );
  });

  it('sends only the site and reason when there is no context', () => {
    const input = buildBouncerInput({ hostname: 'x.com', reason: 'scroll' });
    expect(input).toHaveLength(2);
    expect(input[1].content).toBe('Site: x.com\nReason: scroll');
  });
});

describe('askOpenAI', () => {
  it('posts a strict-schema Responses request with the key and returns the decision', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify(reply({ reasoning: '', seconds: 45, valid: true, message: 'Ok', followUpQuestion: null })))
    );
    const decision = await askOpenAI(
      { hostname: 'weather.com', reason: 'bike home' },
      { apiKey: 'sk-test', fetchImpl: fetchImpl as unknown as typeof fetch }
    );
    expect(decision).toMatchObject({ valid: true, seconds: 45, message: 'Ok' });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe(DEFAULT_OPENAI_MODEL);
    expect(body.store).toBe(false);
    expect(body.text.format).toEqual({
      type: 'json_schema',
      name: 'bouncer_decision',
      strict: true,
      schema: BOUNCER_JSON_SCHEMA,
    });
  });

  it('reports the status and OpenAI message on an error reply', async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ error: { message: 'Incorrect API key' } }), { status: 401 });
    await expect(
      askOpenAI({ hostname: 'x.com', reason: 'r' }, { apiKey: 'bad', fetchImpl: fetchImpl as typeof fetch })
    ).rejects.toThrow('OpenAI returned 401: Incorrect API key');
  });

  it('gives up at its deadline', async () => {
    const fetchImpl = (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    await expect(
      askOpenAI({ hostname: 'x.com', reason: 'r' }, {
        apiKey: 'k',
        timeoutMs: 20,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).rejects.toThrow(/aborted/);
  });
});

describe('the strict schema', () => {
  it('requires every property, as strict mode demands', () => {
    expect([...BOUNCER_JSON_SCHEMA.required].sort()).toEqual(Object.keys(BOUNCER_JSON_SCHEMA.properties).sort());
  });
});
