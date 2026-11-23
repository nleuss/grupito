// Claude (Anthropic API) integration: word explanations and context-aware translation.
// The user's own API key is used directly from the extension (it never leaves this device
// except in requests to api.anthropic.com).
import Anthropic from '@anthropic-ai/sdk';
import type { ExplainResult } from '../shared/types';
import { languageName } from '../shared/languages';

let client: Anthropic | null = null;
let clientKey = '';

function getClient(apiKey: string): Anthropic {
  if (!client || clientKey !== apiKey) {
    client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 2, timeout: 90_000 });
    clientKey = apiKey;
  }
  return client;
}

// Models that accept server-side refusal fallbacks (`fallbacks: "default"`).
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-opus-5', 'claude-fable-5-2', 'claude-fable-5-1']);

export interface StructuredRequest {
  system: string | Anthropic.Beta.Messages.BetaTextBlockParam[];
  user: string;
  schema: Record<string, unknown>;
  maxTokens: number;
  /** Short, latency-sensitive tasks use "low"; one-off analyses can afford more. */
  effort?: 'low' | 'medium' | 'high';
  /** Stream the response (long inputs such as a whole book) to avoid HTTP timeouts. */
  stream?: boolean;
  timeoutMs?: number;
}

/** One Messages API call whose answer is JSON matching `schema` (structured outputs). */
export async function structured<T>(apiKey: string, model: string, req: StructuredRequest): Promise<T> {
  const params: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming = {
    model,
    max_tokens: req.maxTokens,
    system: req.system,
    messages: [{ role: 'user', content: req.user }],
    output_config: { effort: req.effort ?? 'low', format: { type: 'json_schema', schema: req.schema } },
  };
  if (FALLBACK_MODELS.has(model)) {
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }
  let res: Anthropic.Beta.Messages.BetaMessage;
  try {
    const c = getClient(apiKey);
    const opts = req.timeoutMs ? { timeout: req.timeoutMs } : undefined;
    res = req.stream ? await c.beta.messages.stream(params, opts).finalMessage() : await c.beta.messages.create(params, opts);
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new Error('Invalid Claude API key');
    if (e instanceof Anthropic.PermissionDeniedError) throw new Error('This Claude API key cannot use this model');
    if (e instanceof Anthropic.RateLimitError) throw new Error('Claude rate limit reached, try again in a moment');
    if (e instanceof Anthropic.BadRequestError) throw new Error(`Claude rejected the request: ${e.message}`);
    if (e instanceof Anthropic.APIConnectionError) throw new Error('Could not connect to the Claude API');
    throw e;
  }
  if (res.stop_reason === 'refusal') throw new Error('Claude declined to answer this request');
  if (res.stop_reason === 'max_tokens') throw new Error('Claude response was cut off (max_tokens)');
  const text = res.content
    .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
  return JSON.parse(text) as T;
}

export const EXPLAIN_PROPERTIES = {
  lemma: { type: 'string', description: 'Dictionary form of the word, in the source language' },
  reading: { type: 'string', description: 'Pronunciation aid: kana for Japanese, pinyin for Chinese, romanization for non-Latin scripts, IPA otherwise; empty if not useful' },
  partOfSpeech: { type: 'string' },
  meaning: { type: 'string', description: 'What the word means in this exact sentence' },
  grammar: { type: 'string', description: 'Form used here: tense, person, conjugation, particles, agreement, idiom…' },
  otherMeanings: { type: 'array', items: { type: 'string' } },
  examples: {
    type: 'array',
    items: {
      type: 'object',
      additionalProperties: false,
      required: ['text', 'translation'],
      properties: { text: { type: 'string' }, translation: { type: 'string' } },
    },
  },
  sentenceTranslation: { type: 'string' },
};

const EXPLAIN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: Object.keys(EXPLAIN_PROPERTIES),
  properties: EXPLAIN_PROPERTIES,
};

export async function explainWord(apiKey: string, model: string, word: string, sentence: string, from: string, to: string): Promise<ExplainResult> {
  const L = languageName(from);
  const N = languageName(to);
  const system =
    `You are a concise language tutor inside an app where people learn ${L} by watching videos with subtitles. ` +
    `The learner is a ${N} speaker who clicked a word in a subtitle line. ` +
    `Write every explanation in ${N}; keep examples in ${L}. Be brief: meaning under 25 words, grammar under 45 words, ` +
    `at most 3 other meanings and 2 short everyday examples. If the word is part of an idiom or phrasal expression, explain the whole expression.`;
  const user = `Subtitle line: «${sentence}»\nClicked word: «${word}»`;
  return structured<ExplainResult>(apiKey, model, { system, user, schema: EXPLAIN_SCHEMA, maxTokens: 4000 });
}

const TRANSLATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['translations'],
  properties: { translations: { type: 'array', items: { type: 'string' } } },
};

export async function translateLines(apiKey: string, model: string, lines: string[], from: string, to: string, title?: string, context?: string): Promise<string[]> {
  const system =
    `You translate ${context ? 'passages of a book' : 'subtitle lines'} from ${languageName(from)} to ${languageName(to)} for a language learner. ` +
    `Translate each item faithfully and naturally, using the neighbouring items only as context. ` +
    `Return exactly one translation per input item, in the same order: never merge, split, skip or reorder items. Keep speaker dashes.` +
    (context ? `\n\nAbout the work (keep names and special terms consistent with it):\n${context}` : '');
  const user = JSON.stringify({ title: title ?? '', count: lines.length, items: lines });
  const res = await structured<{ translations: string[] }>(apiKey, model, {
    system,
    user,
    schema: TRANSLATE_SCHEMA,
    maxTokens: Math.min(64000, 4000 + Math.ceil(lines.join(' ').length / 1.5)),
    stream: true,
  });
  const out = Array.isArray(res.translations) ? res.translations : [];
  return lines.map((_, i) => (typeof out[i] === 'string' ? out[i] : ''));
}
