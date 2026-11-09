import { DEFAULT_OPENAI_MODEL } from '../client/src/shared/bouncer.ts';

export const OPENAI_MODEL = Deno.env.get('OPENAI_MODEL') ?? DEFAULT_OPENAI_MODEL;
