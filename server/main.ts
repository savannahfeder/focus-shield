import '@std/dotenv/load';
import { askOpenAI } from '../client/src/shared/bouncer.ts';
import { OPENAI_MODEL } from './config.ts';

const CORS = { 'Access-Control-Allow-Origin': '*' };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

Deno.serve({ port: 8000 }, async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        ...CORS,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  const path = new URL(req.url).pathname;

  if (req.method === 'POST' && path === '/validate') {
    try {
      const { reason, hostname, conversationHistory, siteMetadata, accessHistory } =
        await req.json();
      if (!reason || !hostname) {
        return json({ error: 'Missing reason or hostname' }, 400);
      }
      const apiKey = Deno.env.get('OPENAI_API_KEY');
      if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
      const result = await askOpenAI(
        { reason, hostname, conversationHistory, siteMetadata, accessHistory },
        { apiKey, model: OPENAI_MODEL }
      );
      return json(result);
    } catch (error) {
      console.error('Error:', error);
      const detail = error instanceof Error ? error.message : String(error);
      return json({ error: 'Internal server error', detail, model: OPENAI_MODEL }, 500);
    }
  }

  if (req.method === 'GET' && path === '/health') {
    return json({ ok: true, model: OPENAI_MODEL });
  }

  return new Response('Not Found', { status: 404 });
});

console.log('🚀 Server running on http://localhost:8000');
