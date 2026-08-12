import { env } from 'cloudflare:workers';
import { describeChange, type TextChange } from './text-diff';

/**
 * One sentence saying what changed.
 *
 * Workers AI is on the same platform, so this adds no vendor, no key and no
 * egress. It is also strictly an improvement on a fallback that already works:
 * with no binding, or on any failure, the plain list of added and removed lines
 * goes out instead. An alert that arrives plain beats an alert that does not
 * arrive.
 */

/** Small and fast. The job is to compress a diff, not to reason about it. */
const MODEL = '@cf/meta/llama-3.1-8b-instruct';

/** Lines each way. Beyond this the prompt costs more than the answer is worth. */
const MAX_LINES = 12;

function aiAvailable(): boolean {
  return Boolean((env as unknown as Record<string, unknown>).AI);
}

export interface ChangeSummary {
  /** One sentence, or empty when nothing could be produced. */
  sentence: string;
  /** The plain rendering, always present when the change was comparable. */
  detail: string;
  source: 'model' | 'plain' | 'none';
}

export async function summariseChange(change: TextChange, pageName: string): Promise<ChangeSummary> {
  const detail = describeChange(change);
  if (!change.comparable || (!change.added.length && !change.removed.length)) {
    return { sentence: '', detail, source: 'none' };
  }
  if (!aiAvailable()) return { sentence: '', detail, source: 'plain' };

  const prompt = [
    `A web page called "${pageName}" changed since it was last checked.`,
    '',
    'Lines that are now on the page:',
    ...change.added.slice(0, MAX_LINES).map((line) => `+ ${line}`),
    '',
    'Lines that were there before and are gone:',
    ...change.removed.slice(0, MAX_LINES).map((line) => `- ${line}`),
    '',
    'In ONE sentence of at most 30 words, say what changed in plain English.',
    'Name the concrete before and after where you can, for example a price or a date.',
    'If the lines only differ in wording or ordering, say the content is unchanged.',
    'Reply with the sentence only.',
  ].join('\n');

  try {
    const response = (await (env as any).AI.run(MODEL, {
      messages: [
        {
          role: 'system',
          content:
            'You summarise differences between two versions of a web page. You are terse and factual, and you never invent detail that is not in the lines given to you.',
        },
        { role: 'user', content: prompt },
      ],
      max_tokens: 90,
    })) as { response?: string };

    const sentence = (response?.response ?? '').trim().split('\n')[0]?.trim() ?? '';
    // A model that returns nothing usable is the same as no model at all.
    if (!sentence) return { sentence: '', detail, source: 'plain' };

    return { sentence: sentence.slice(0, 300), detail, source: 'model' };
  } catch (error) {
    console.error('[summarise] model call failed', error);
    return { sentence: '', detail, source: 'plain' };
  }
}
