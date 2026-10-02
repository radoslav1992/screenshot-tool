/**
 * Posting a change where people actually are.
 *
 * A raw JSON POST is right for a customer's own endpoint and useless in a chat
 * app, which renders whatever shape it was given. Slack, Discord, Microsoft
 * Teams and Google Chat each accept an incoming webhook in a shape of their
 * own, so recognising those hosts turns an integration nobody would build into
 * one that works by pasting a URL.
 *
 * Everything else keeps getting the JSON payload, which is what Zapier, n8n and
 * Make expect.
 */

export type WebhookFlavour = 'slack' | 'discord' | 'teams' | 'google_chat' | 'json';

export function webhookFlavour(url: string): WebhookFlavour {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === 'hooks.slack.com') return 'slack';
    if (host === 'discord.com' || host === 'discordapp.com' || host.endsWith('.discord.com')) {
      return 'discord';
    }
    if (host === 'chat.googleapis.com') return 'google_chat';
    /*
     * Teams hands out three kinds of webhook URL: the retiring Office 365
     * connectors, and Workflows on Power Automate or Logic Apps. The Logic
     * Apps host also serves flows customers build for themselves, which is
     * why the Teams body carries the JSON fields alongside the card.
     */
    if (
      host === 'outlook.office.com' ||
      host.endsWith('.webhook.office.com') ||
      host.endsWith('.logic.azure.com') ||
      host.endsWith('.api.powerplatform.com')
    ) {
      return 'teams';
    }
  } catch {
    /* an unparseable URL is nobody's chat app */
  }
  return 'json';
}

export interface ChangeNotice {
  name: string;
  url: string;
  changePct: number;
  summary: string | null;
  beforeUrl: string | null;
  afterUrl: string | null;
  watchUrl: string;
  /**
   * The alert rule that fired and what it found. For a text, phrase, price or
   * element rule the finding is the news — "“In stock” appeared on the page" —
   * where a pixel percentage would read "0% of the page changed".
   */
  rule?: { kind: string; detail: string | null } | null;
}

/** What a message leads with: a rule's own finding, then the summary, then the percentage. */
export function noticeHeadline(notice: ChangeNotice): string {
  if (notice.rule && notice.rule.kind !== 'visual' && notice.rule.detail) return notice.rule.detail;
  return notice.summary || `${notice.changePct}% of the page changed.`;
}

/**
 * The message body for a flavour.
 *
 * Slack and Discord differ in the details — Slack takes blocks, Discord takes
 * embeds — but both render `text`/`content` markdown well enough that one
 * sentence and two links is the whole message. Keeping it to the common field
 * means one shape to get right rather than two to keep in step.
 */
export function webhookBody(flavour: WebhookFlavour, notice: ChangeNotice): unknown {
  const json = {
    event: 'watch.changed',
    watch: { name: notice.name, url: notice.url },
    change_pct: notice.changePct,
    summary: notice.summary,
    before: notice.beforeUrl,
    after: notice.afterUrl,
    detail_url: notice.watchUrl,
    rule: notice.rule ? { kind: notice.rule.kind, detail: notice.rule.detail } : null,
  };
  if (flavour === 'json') return json;

  const headline = noticeHeadline(notice);
  const links = [
    notice.beforeUrl ? `<${notice.beforeUrl}|before>` : null,
    notice.afterUrl ? `<${notice.afterUrl}|after>` : null,
  ].filter(Boolean);

  if (flavour === 'slack') {
    return {
      text: `*${notice.name}* changed — ${headline}`,
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `*<${notice.watchUrl}|${notice.name}>* changed\n${headline}` },
        },
        ...(links.length
          ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: links.join('  ·  ') }] }]
          : []),
      ],
    };
  }

  // Google Chat reads the same `<url|label>` links and `*bold*` as Slack, as plain text.
  if (flavour === 'google_chat') {
    return {
      text: `*${notice.name}* changed — ${headline}\n${[`<${notice.watchUrl}|Open monitor>`, ...links].join('  ·  ')}`,
    };
  }

  if (flavour === 'teams') {
    const open = (title: string, url: string | null) => (url ? [{ type: 'Action.OpenUrl', title, url }] : []);
    return {
      ...json,
      type: 'message',
      attachments: [
        {
          contentType: 'application/vnd.microsoft.card.adaptive',
          contentUrl: null,
          content: {
            $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
            type: 'AdaptiveCard',
            version: '1.4',
            body: [
              { type: 'TextBlock', text: `${notice.name} changed`, weight: 'Bolder', wrap: true },
              { type: 'TextBlock', text: headline, wrap: true },
            ],
            actions: [
              ...open('Open monitor', notice.watchUrl),
              ...open('Before', notice.beforeUrl),
              ...open('After', notice.afterUrl),
            ],
          },
        },
      ],
    };
  }

  // Discord uses plain markdown links rather than Slack's angle-bracket form.
  const discordLinks = [
    notice.beforeUrl ? `[before](${notice.beforeUrl})` : null,
    notice.afterUrl ? `[after](${notice.afterUrl})` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return {
    content: `**[${notice.name}](${notice.watchUrl})** changed — ${headline}${discordLinks ? `\n${discordLinks}` : ''}`,
  };
}
