import type { AccessAttemptOutcome } from '../../options/types';
import { askOpenAI, DEFAULT_OPENAI_MODEL } from '../../shared/bouncer';

export interface AIResponse {
  valid: boolean | null; // null = follow-up needed
  seconds: number;
  message: string;
  followUpQuestion?: string | null;
}

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface SiteMetadata {
  title: string;
  description: string;
}

export interface AccessAttempt {
  domain: string;
  reason: string;
  timestamp: number;
  outcome: AccessAttemptOutcome;
  durationSeconds?: number;
}

const VALIDATION_SERVICE_URL = import.meta.env.DEV
  ? 'http://localhost:8000/validate'
  : 'https://smart-blocker.moritzwa.deno.net/validate';
// A local build (scripts/build-local.sh) bakes in the owner's OpenAI key and
// asks OpenAI directly, so no server is involved.
const OPENAI_API_KEY: string | undefined = import.meta.env.VITE_OPENAI_API_KEY;
const OPENAI_MODEL: string =
  import.meta.env.VITE_OPENAI_MODEL || DEFAULT_OPENAI_MODEL;
const REQUEST_TIMEOUT = 10000; // 10 seconds
const MAX_RETRIES = 5; // Increased for serverless cold starts

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeout: number
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

export async function validateUnblockReason(
  hostname: string,
  reason: string,
  conversationHistory: ConversationMessage[] = [],
  siteMetadata?: SiteMetadata | null,
  accessHistory?: AccessAttempt[]
): Promise<AIResponse | { error: string }> {
  if (OPENAI_API_KEY) {
    return askOpenAIWithRetry(hostname, reason, conversationHistory, siteMetadata, accessHistory);
  }

  let lastError: Error | null = null;

  // Retry logic
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(
        `🤖 AI validation attempt ${attempt}/${MAX_RETRIES} for ${hostname}`,
        '\n📜 Conversation history:', conversationHistory,
        '\n💬 Current message:', reason
      );

      const response = await fetchWithTimeout(
        VALIDATION_SERVICE_URL,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hostname, reason, conversationHistory, siteMetadata, accessHistory }),
        },
        REQUEST_TIMEOUT
      );

      console.log(
        `📡 Response status: ${response.status} ${response.statusText}`
      );

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'No error details');
        console.log(`❌ Server error (${response.status}):`, errorText);
        throw new Error(
          `Server returned ${response.status}: ${response.statusText}`
        );
      }

      const data = await response.json();
      console.log(`✅ AI validation successful:`, data);
      return data;
    } catch (error) {
      lastError = error as Error;

      // Log retry attempts as info (not errors) - won't show in Errors page
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          console.log(`⏱️ Request timeout (attempt ${attempt}/${MAX_RETRIES})`);
        } else if (error.message.includes('Failed to fetch')) {
          console.log(
            `🌐 Network error - likely serverless cold start (attempt ${attempt}/${MAX_RETRIES}):`,
            error.message
          );
        } else {
          console.log(
            `❌ Validation error (attempt ${attempt}/${MAX_RETRIES}):`,
            error.message
          );
        }
      }

      // Don't retry on last attempt
      if (attempt < MAX_RETRIES) {
        // Exponential backoff: 1s → 2s → 4s → 8s
        const delay = 1000 * Math.pow(2, attempt - 1);
        console.log(`⏳ Retrying in ${delay}ms... (exponential backoff)`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  // All retries failed
  console.error(
    `💥 All ${MAX_RETRIES} attempts failed. Last error:`,
    lastError
  );

  // Provide detailed error messages
  let errorMessage = 'Failed to connect to validation service.';
  if (lastError?.name === 'AbortError') {
    errorMessage =
      'Request timed out after multiple attempts. Please try again.';
  } else if (lastError?.message.includes('Failed to fetch')) {
    errorMessage =
      'Network error - server may be starting up. Please try again in a moment.';
  }

  return { error: errorMessage };
}

const OPENAI_ATTEMPTS = 2;

async function askOpenAIWithRetry(
  hostname: string,
  reason: string,
  conversationHistory: ConversationMessage[],
  siteMetadata?: SiteMetadata | null,
  accessHistory?: AccessAttempt[]
): Promise<AIResponse | { error: string }> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= OPENAI_ATTEMPTS; attempt++) {
    try {
      const decision = await askOpenAI(
        { hostname, reason, conversationHistory, siteMetadata, accessHistory },
        { apiKey: OPENAI_API_KEY!, model: OPENAI_MODEL }
      );
      console.log(`✅ OpenAI (${OPENAI_MODEL}) decided:`, decision);
      return decision;
    } catch (error) {
      lastError = error as Error;
      console.log(`❌ OpenAI attempt ${attempt}/${OPENAI_ATTEMPTS}:`, lastError.message);
      // A bad key or model will not fix itself on a second try.
      if (/OpenAI returned (400|401|403|404)/.test(lastError.message)) break;
      if (attempt < OPENAI_ATTEMPTS) await new Promise((r) => setTimeout(r, 1000));
    }
  }
  if (lastError?.name === 'AbortError') {
    return { error: 'OpenAI took too long to answer. Please try again.' };
  }
  return { error: `OpenAI error: ${lastError?.message ?? 'unknown'}` };
}
