/**
 * Posting a change where people actually are.
 *
 * A raw JSON POST is right for a customer's own endpoint and useless in a chat
 * app, which renders whatever shape it was given. Slack and Discord both accept
 * an incoming webhook with a `text` field, so recognising those two hosts turns
 * an integration nobody would build into one that works by pasting a URL.
 *
 * Everything else keeps getting the JSON payload, which is what Zapier, n8n and
 * Make expect.
 */

export type WebhookFlavour = 'slack' | 'discord' | 'json';

export function webhookFlavour(url: string): WebhookFlavour {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === 'hooks.slack.com') return 'slack';
    if (host === 'discord.com' || host === 'discordapp.com' || host.endsWith('.discord.com')) {
      return 'discord';
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
  if (flavour === 'json') {
    return {
      event: 'watch.changed',
      watch: { name: notice.name, url: notice.url },
      change_pct: notice.changePct,
      summary: notice.summary,
      before: notice.beforeUrl,
      after: notice.afterUrl,
      detail_url: notice.watchUrl,
    };
  }

  const headline = notice.summary || `${notice.changePct}% of the page changed.`;
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
