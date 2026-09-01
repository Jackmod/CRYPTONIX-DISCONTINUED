/**
 * One tweet, normalised away from whichever source produced it.
 *
 * Deliberately the same shape whether it came from X's free embed CDN or from
 * a paid discovery API, so the Discord embed and the desktop card never have
 * to know which one they are looking at.
 */
export interface Tweet {
  /** X's own id, as a string: these exceed Number.MAX_SAFE_INTEGER. */
  id: string;
  authorHandle: string;
  authorName: string;
  /** The author's real avatar (spec §5.3 — real imagery, never a placeholder). */
  authorAvatarUrl: string | null;
  text: string;
  /** Media attached to the tweet, in the order X returns it. */
  media: TweetMedia[];
  /** ISO 8601. */
  postedAt: string;
  likeCount: number | null;
  replyCount: number | null;
  url: string;
}

export interface TweetMedia {
  type: 'photo' | 'video' | 'animated_gif';
  url: string;
}

/**
 * A handle the user asked to follow.
 *
 * Stored without the '@': that is display sugar, and keeping it would make
 * '@ansem' and 'ansem' two different rows for the same account.
 */
export interface TrackedHandle {
  id: number;
  handle: string;
  addedAt: string;
}

/** X's own limits: 1-15 characters, letters, digits and underscore. */
const HANDLE_PATTERN = /^[A-Za-z0-9_]{1,15}$/;

/**
 * Accepts what a person will actually paste — '@ansem', 'ansem',
 * 'https://x.com/ansem', 'twitter.com/ansem/' — and returns the bare handle,
 * lowercased.
 *
 * Lowercased because X handles are case-insensitive: following 'Ansem' and
 * 'ansem' would otherwise poll the same account twice and post every tweet
 * from it twice.
 */
export function normalizeHandle(input: string): string | null {
  let value = input.trim();
  if (value === '') return null;

  // A pasted profile URL, with or without a scheme.
  const urlMatch = /^(?:https?:\/\/)?(?:www\.)?(?:twitter|x)\.com\/([^/?#]+)/i.exec(value);
  if (urlMatch) value = urlMatch[1];

  if (value.startsWith('@')) value = value.slice(1);
  // A trailing slash survives the URL match above when nothing followed it.
  value = value.replace(/\/+$/, '');

  return HANDLE_PATTERN.test(value) ? value.toLowerCase() : null;
}

/**
 * Pulls a tweet id out of whatever the user pasted.
 *
 * Returned as a string throughout: a tweet id is a 64-bit snowflake and
 * already exceeds what a JavaScript number holds exactly, so parsing one
 * would silently corrupt the last digits.
 */
export function parseTweetRef(input: string): string | null {
  const value = input.trim();
  if (value === '') return null;

  // One or more path segments before /status: the canonical form has one
  // ('/vercel/status/1'), but X also serves '/i/web/statuses/1'.
  const urlMatch = /(?:twitter|x)\.com\/(?:[^/]+\/)+status(?:es)?\/(\d{1,25})/i.exec(value);
  if (urlMatch) return urlMatch[1];

  return /^\d{1,25}$/.test(value) ? value : null;
}

/** The canonical link back to a tweet. */
export function buildTweetUrl(handle: string, tweetId: string): string {
  return `https://x.com/${handle}/status/${tweetId}`;
}
