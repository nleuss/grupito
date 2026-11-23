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

async function structured<T>(apiKey: string, model: string, system: string, user: string, schema: Record<string, unknown>, maxTokens: number): Promise<T> {
  const params: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming = {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
    // Short, latency-sensitive tasks: low effort keeps answers quick and cheap.
    output_config: { effort: 'low', format: { type: 'json_schema', schema } },
  };
  if (FALLBACK_MODELS.has(model)) {
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }
  let res: Anthropic.Beta.Messages.BetaMessage;
  try {
    res = await getClient(apiKey).beta.messages.create(params);
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

const EXPLAIN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['lemma', 'reading', 'partOfSpeech', 'meaning', 'grammar', 'otherMeanings', 'examples', 'sentenceTranslation'],
  properties: {
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
  },
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
  return structured<ExplainResult>(apiKey, model, system, user, EXPLAIN_SCHEMA, 4000);
}

const TRANSLATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['translations'],
  properties: { translations: { type: 'array', items: { type: 'string' } } },
};

export async function translateLines(apiKey: string, model: string, lines: string[], from: string, to: string, title?: string): Promise<string[]> {
  const system =
    `You translate subtitle lines from ${languageName(from)} to ${languageName(to)} for a language learner. ` +
    `Translate each line faithfully and naturally, the way a professional subtitler would, using the neighbouring lines only as context. ` +
    `Return exactly one translation per input line, in the same order: never merge, split, skip or reorder lines. Keep speaker dashes.`;
  const user = JSON.stringify({ video: title ?? '', count: lines.length, lines });
  const res = await structured<{ translations: string[] }>(apiKey, model, system, user, TRANSLATE_SCHEMA, Math.min(32000, 2000 + lines.length * 120));
  const out = Array.isArray(res.translations) ? res.translations : [];
  return lines.map((_, i) => (typeof out[i] === 'string' ? out[i] : ''));
}
