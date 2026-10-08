import { env } from 'cloudflare:workers';
import { MODEL, aiAvailable } from './summarise';
import { acceptSummary, plainSummary, summaryFacts, type CareSnapshot } from './care-rules';

/**
 * The care report's paragraph for the client, written as the alert summaries
 * are (lib/summarise.ts): Workers AI when the binding is there, the plain
 * sentences otherwise.
 *
 * The model is given the snapshot's counts and the monitors' names, never
 * page text or captured URLs, and its answer is used only when every number
 * in it is one of those facts (acceptSummary). Anything else — no binding, an
 * error, an empty or made-up answer — is the plain paragraph, so a report
 * always has one and it never says more than the report shows.
 */
export async function careSummary(snapshot: CareSnapshot): Promise<{ text: string; source: 'model' | 'plain' }> {
  const plain = { text: plainSummary(snapshot), source: 'plain' as const };
  if (!aiAvailable()) return plain;
  const facts = summaryFacts(snapshot);
  try {
    const response = (await (env as any).AI.run(MODEL, {
      messages: [
        {
          role: 'system',
          content:
            'You write the opening paragraph of a monthly website care report that a web agency sends to its client. ' +
            'You are warm, plain and factual. You use only the facts given to you, you never invent a number, a page or an event, ' +
            'and you do not give advice beyond saying that next steps follow.',
        },
        {
          role: 'user',
          content: [
            'Facts for this month:',
            ...facts.map((fact) => `- ${fact}`),
            '',
            'Write ONE paragraph of two to four sentences, at most 90 words, addressed to the client as "you", from the agency as "we".',
            'Use the numbers exactly as given. Do not use lists, links, headings or markdown.',
            'Reply with the paragraph only.',
          ].join('\n'),
        },
      ],
      max_tokens: 220,
    })) as { response?: string };
    const accepted = acceptSummary(response?.response ?? '', facts);
    return accepted ? { text: accepted, source: 'model' } : plain;
  } catch (error) {
    console.error('[care] summary model call failed', error);
    return plain;
  }
}
