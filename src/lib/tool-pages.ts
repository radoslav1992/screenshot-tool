import { env } from 'cloudflare:workers';
import type { AstroGlobal } from 'astro';
import { HttpError, readBody } from './http';
import { toHttpError } from './errors';
import { FREE_TOOL_LIMITS, RENDER_COST, TOOL_RENDER, runTool, type ToolId, type ToolResult } from './free-tools';

/**
 * What the /tools pages say about themselves: the words a search lands on, the
 * how-to and the questions, and the structured data that names each one a
 * free web application. The tools themselves are in free-tools.ts.
 */

export interface ToolFaq {
  q: string;
  a: string;
}

export interface ToolPage {
  id: ToolId;
  path: string;
  /** Short name, for links between the tools. */
  name: string;
  /** The <title>, before " · Easy Screen Capture". */
  title: string;
  description: string;
  /** The h1, worded as the search it answers: `heading`, then `accent` in orange. */
  heading: string;
  accent: string;
  /** One line under the name in the index and in links between tools. */
  summary: string;
  /** Mono label of the page head. */
  meta: string;
  steps: string[];
  faq: ToolFaq[];
}

const perDay = FREE_TOOL_LIMITS.rendersPerVisitor;
const tallest = TOOL_RENDER.maxHeight.toLocaleString('en-US');

const NOTHING_KEPT: ToolFaq = {
  q: 'Do you keep the pages I check?',
  a: 'No. The result is sent straight back to your browser and is not stored, and we keep no log of who asked for what. To limit abuse we count requests against a hashed, daily-changing form of your IP address, which expires within two days.',
};

export const TOOL_PAGES: Record<ToolId, ToolPage> = {
  'full-page-screenshot': {
    id: 'full-page-screenshot',
    path: '/tools/full-page-screenshot',
    name: 'Full page screenshot',
    title: 'Free full page screenshot of any website',
    description:
      'Paste a URL and get a full-page screenshot of the whole website, top to bottom, as one JPEG. Desktop or mobile. Free, no signup.',
    heading: 'Full page screenshot',
    accent: 'of any website',
    summary: 'The whole page, top to bottom, as one image.',
    meta: 'DESKTOP OR MOBILE / ONE TALL JPEG',
    steps: [
      'Paste the address of the page, for example example.com/pricing.',
      'Choose desktop or mobile. Mobile loads the page as Safari on an iPhone.',
      'Take the screenshot. It takes 5 to 20 seconds; then download the JPEG.',
    ],
    faq: [
      {
        q: 'Is it really free?',
        a: `Yes. You can take ${perDay} screenshots a day without an account. A free account adds 20 screenshots a month, saved captures and 3 page monitors.`,
      },
      {
        q: 'How long can the page be?',
        a: `Up to ${tallest} pixels. A longer page is cut there; the app captures pages up to 20,000 pixels.`,
      },
      {
        q: 'Why is there a small mark in the corner?',
        a: 'Free screenshots carry a small easyscreencapture.com mark. Paid plans remove it.',
      },
      {
        q: 'Can it capture a page behind a login?',
        a: 'No. The page is loaded as a first-time visitor would see it, with no cookies or passwords. Cookie banners are dismissed and ads are blocked where possible.',
      },
      NOTHING_KEPT,
    ],
  },
  'responsive-preview': {
    id: 'responsive-preview',
    path: '/tools/responsive-preview',
    name: 'Responsive preview',
    title: 'Responsive design checker: phone, tablet and desktop',
    description:
      'See how any website looks on a phone, a tablet and a desktop, side by side, from one URL. A free responsive design checker, no signup.',
    heading: 'See any website on',
    accent: 'phone, tablet and desktop',
    summary: 'One address, three screens, side by side.',
    meta: 'IPHONE / IPAD / DESKTOP',
    steps: [
      'Paste the address of the page you want to check.',
      'Run the preview. The page is loaded once and shown at three screen sizes.',
      'Compare the first screen on each device side by side, and download any of them.',
    ],
    faq: [
      {
        q: 'Which screen sizes are shown?',
        a: 'An iPhone (390 × 844), an 11-inch iPad (834 × 1194) and a desktop (1440 × 900), each the first screen of the page, as a visitor sees it before scrolling.',
      },
      {
        q: 'How many previews can I run?',
        a: `A preview takes three of the ${perDay} free renders a day. A free account adds 20 screenshots a month.`,
      },
      {
        q: 'Is this how the site looks on a real phone?',
        a: 'Close to it: the phone and tablet get a mobile viewport and touch, so responsive layouts and the viewport tag apply. The page is loaded once as a desktop browser, so a site that sends phones a different page altogether may differ.',
      },
      NOTHING_KEPT,
    ],
  },
  'seo-tag-checker': {
    id: 'seo-tag-checker',
    path: '/tools/seo-tag-checker',
    name: 'SEO tag checker',
    title: 'SEO meta tag checker: title, description, canonical',
    description:
      'Check any page’s title, meta description, canonical, robots, h1, hreflang, Open Graph and Twitter tags, with plain-English warnings and a Google preview. Free.',
    heading: 'Check any page’s',
    accent: 'SEO tags',
    summary: 'Title, description, canonical, robots and social tags, explained.',
    meta: 'TITLE / META / CANONICAL / OPEN GRAPH',
    steps: [
      'Paste the address of the page.',
      'Check it. The page’s HTML is read in a second or two, without a browser.',
      'Fix what the warnings point at, and see how the page may look on Google and when shared.',
    ],
    faq: [
      {
        q: 'What does it check?',
        a: 'The HTTP status and redirects, title, meta description, canonical, robots meta and X-Robots-Tag, h1 headings, hreflang, Open Graph and Twitter tags, the viewport and the page language.',
      },
      {
        q: 'Why is a tag I can see in my browser missing?',
        a: 'The checker reads the HTML the server sends, before any JavaScript runs, which is what a search engine reads first. A tag that only a script adds is not in it.',
      },
      {
        q: 'How many pages can I check?',
        a: `${FREE_TOOL_LIMITS.seoChecksPerVisitor} an hour, free. To be told when a page’s title, canonical or robots tags change, monitor it with a free account.`,
      },
      NOTHING_KEPT,
    ],
  },
  'compare-pages': {
    id: 'compare-pages',
    path: '/tools/compare-pages',
    name: 'Compare pages',
    title: 'Compare two web pages visually, free',
    description:
      'Screenshot two URLs, such as staging and live, and see the changed areas highlighted with the share of the page that changed. Free visual comparison, no signup.',
    heading: 'Compare two web pages',
    accent: 'visually',
    summary: 'Staging against live, with the changes boxed.',
    meta: 'STAGING VS LIVE / CHANGES HIGHLIGHTED',
    steps: [
      'Paste the two addresses, for example your staging page and the live one.',
      'Choose desktop or mobile, and compare. Both pages are captured in full, one after the other.',
      'See how much of the page changed, with each changed area boxed in orange.',
    ],
    faq: [
      {
        q: 'What counts as a change?',
        a: 'Pixels that differ by more than a small tolerance, so font smoothing and image compression do not count. If one page is longer, the extra part counts as changed.',
      },
      {
        q: 'How many comparisons can I run?',
        a: `A comparison takes two of the ${perDay} free renders a day. Both pages are cut at ${tallest} pixels.`,
      },
      {
        q: 'Can I compare a page with itself over time?',
        a: 'That is what a monitor does. A free account watches 3 pages every week and emails you the changed areas.',
      },
      NOTHING_KEPT,
    ],
  },
};

export const TOOL_ORDER: ToolId[] = ['full-page-screenshot', 'responsive-preview', 'seo-tag-checker', 'compare-pages'];

/** The site's own address, for canonical links: PUBLIC_SITE_URL, as emails and sitemaps use. */
export function siteUrl(path: string): string {
  return `${(env.PUBLIC_SITE_URL || 'https://easyscreencapture.com').replace(/\/+$/, '')}${path}`;
}

/** schema.org data naming a tool a free web application, with its questions as an FAQ page. */
export function toolJsonLd(page: ToolPage): string {
  const data = [
    {
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: `${page.name} · Easy Screen Capture`,
      description: page.description,
      url: siteUrl(page.path),
      applicationCategory: 'DeveloperApplication',
      operatingSystem: 'Any (web browser)',
      isAccessibleForFree: true,
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      publisher: { '@type': 'Organization', name: 'Easy Screen Capture', url: siteUrl('/') },
    },
    {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: page.faq.map((entry) => ({
        '@type': 'Question',
        name: entry.q,
        acceptedAnswer: { '@type': 'Answer', text: entry.a },
      })),
    },
  ];
  // Inside a <script>, `</` would end it early.
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

export interface ToolRun {
  /** What the form shows: the visitor's last input, or a `?url=` prefill. */
  input: Record<string, string>;
  result: ToolResult | null;
  error: HttpError | null;
}

/** The fields each tool's form has; nothing else is read back into it. */
const FIELDS: Record<ToolId, string[]> = {
  'full-page-screenshot': ['url', 'device'],
  'responsive-preview': ['url'],
  'seo-tag-checker': ['url'],
  'compare-pages': ['a_url', 'b_url', 'device'],
};

/**
 * A tool page's own request. A GET shows the form, filled from `?url=` when a
 * link brought one; a POST is the form without JavaScript, and runs the tool
 * here so the page comes back with the result in it. The page's script posts
 * the same form with fetch() and takes the result from the same markup.
 */
export async function handleToolRequest(Astro: AstroGlobal, tool: ToolId): Promise<ToolRun> {
  const prefill = (Astro.url.searchParams.get('url') ?? '').slice(0, 2048);
  const input: Record<string, string> = tool === 'compare-pages' ? { a_url: prefill } : { url: prefill };
  if (Astro.request.method !== 'POST') return { input, result: null, error: null };

  // A result is for whoever asked, once: never cached, by the browser or anything between.
  Astro.response.headers.set('cache-control', 'no-store');
  let body: Record<string, string> = {};
  try {
    body = await readBody(Astro.request);
    for (const field of FIELDS[tool]) input[field] = (body[field] ?? '').slice(0, 2048);
    return { input, result: await runTool(Astro.request, tool, body), error: null };
  } catch (error) {
    const failure = toHttpError(error, `tools.${tool}`, 'The tool could not run. Try again in a minute.');
    Astro.response.status = failure.status;
    return { input, result: null, error: failure };
  }
}

/** "5 free renders a day", as the forms say what a run costs. */
export function costNote(tool: ToolId): string {
  if (tool === 'seo-tag-checker') return `${FREE_TOOL_LIMITS.seoChecksPerVisitor} free checks an hour · no browser, no signup`;
  const cost = RENDER_COST[tool];
  return `${cost === 1 ? 'Uses 1' : `Uses ${cost}`} of ${perDay} free renders a day · nothing is stored`;
}
