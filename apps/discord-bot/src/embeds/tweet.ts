import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';

/** Field-for-field what apps/engine's TweetMonitor stores in alerts.payload. */
export interface TweetAlertPayload {
  tweetId: string;
  authorHandle: string;
  authorName: string;
  authorAvatarUrl: string | null;
  text: string;
  mediaUrl: string | null;
  postedAt: string;
  url: string;
}

/** Amber, not green or red: a tweet is not a gain or a loss. */
const PHOSPHOR = 0xffb000;

/** Discord's own limits. It rejects the message rather than truncating for you. */
const MAX_AUTHOR_NAME = 256;
const MAX_DESCRIPTION = 4096;

/**
 * Payloads arrive as `unknown` off a JSON socket, shared with wallet trades
 * and new coins. Anything that is not a tweet is declined here rather than
 * rendered into a live channel.
 */
export function isTweetAlertPayload(value: unknown): value is TweetAlertPayload {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Partial<TweetAlertPayload>;
  return (
    typeof p.tweetId === 'string' &&
    typeof p.authorHandle === 'string' &&
    typeof p.authorName === 'string' &&
    typeof p.text === 'string' &&
    typeof p.postedAt === 'string' &&
    typeof p.url === 'string' &&
    // The nullable fields need checking too: an ABSENT mediaUrl would pass a
    // truthiness test and then be handed to setImage, which throws.
    isStringOrNull(p.authorAvatarUrl) &&
    isStringOrNull(p.mediaUrl)
  );
}

function isStringOrNull(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Discord rejects an image or author icon whose URL it cannot parse, and that
 * would cost the whole alert rather than the picture. Avatars and media come
 * from a third party, so both are checked.
 */
function isUsableLink(link: string | null): link is string {
  if (link === null) return false;
  try {
    const url = new URL(link);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * A tweet rendered as a card (spec §5.2): author name, handle and real avatar,
 * the text, a media thumbnail when there is one, the timestamp, and a link
 * back to X.
 */
export function buildTweetMessage(payload: TweetAlertPayload) {
  const embed = new EmbedBuilder()
    .setColor(PHOSPHOR)
    .setDescription(clamp(payload.text, MAX_DESCRIPTION))
    // Timestamped from the tweet, not from now: a replayed alert after an
    // outage must not claim an old tweet just happened.
    .setTimestamp(toDate(payload.postedAt));

  const author: { name: string; url: string; iconURL?: string } = {
    name: clamp(`${payload.authorName} (@${payload.authorHandle})`, MAX_AUTHOR_NAME),
    url: `https://x.com/${payload.authorHandle}`,
  };
  // Spec §5.3's rule: the real avatar, never a stand-in — but only when it is
  // a URL Discord will accept.
  if (isUsableLink(payload.authorAvatarUrl)) author.iconURL = payload.authorAvatarUrl;
  embed.setAuthor(author);

  if (isUsableLink(payload.mediaUrl)) embed.setImage(payload.mediaUrl);

  if (!isUsableLink(payload.url)) {
    console.error(`tweet ${payload.tweetId} has an unusable link; posting without the button`);
    return { embeds: [embed], components: [] };
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setLabel('View on X').setURL(payload.url).setStyle(ButtonStyle.Link)
  );

  return { embeds: [embed], components: [row] };
}

/** An unparseable timestamp must not throw out of the renderer. */
function toDate(value: string): Date {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}
