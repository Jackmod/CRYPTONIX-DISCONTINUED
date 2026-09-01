import { describe, it, expect } from 'vitest';
import { buildTweetUrl, normalizeHandle, parseTweetRef } from './types';

describe('normalizeHandle', () => {
  it.each([
    ['ansem', 'ansem'],
    ['@ansem', 'ansem'],
    ['https://x.com/ansem', 'ansem'],
    ['https://twitter.com/ansem', 'ansem'],
    ['http://www.x.com/ansem', 'ansem'],
    ['x.com/ansem', 'ansem'],
    ['https://x.com/ansem/', 'ansem'],
    ['https://x.com/ansem?utm=1', 'ansem'],
    ['  @ansem  ', 'ansem'],
  ])('reads %s as %s', (input, expected) => {
    expect(normalizeHandle(input)).toBe(expected);
  });

  it('lowercases, because X handles are case-insensitive', () => {
    // Otherwise 'Ansem' and 'ansem' are two rows for one account, and every
    // tweet from it is posted twice.
    expect(normalizeHandle('@Ansem')).toBe('ansem');
    expect(normalizeHandle('ANSEM')).toBe('ansem');
  });

  it.each([
    ['', 'empty'],
    ['   ', 'only spaces'],
    ['@', 'just an at sign'],
    ['a'.repeat(16), 'over 15 characters'],
    ['bad handle', 'a space inside'],
    ['bad-handle', 'a hyphen'],
    ['bad.handle', 'a dot'],
    ['https://x.com/', 'a url with no handle'],
    ['https://example.com/ansem', 'a url that is not X'],
  ])('refuses %s (%s)', (input) => {
    expect(normalizeHandle(input)).toBeNull();
  });

  it('accepts the longest and shortest handles X allows', () => {
    expect(normalizeHandle('a')).toBe('a');
    expect(normalizeHandle('a'.repeat(15))).toBe('a'.repeat(15));
  });
});

describe('parseTweetRef', () => {
  it.each([
    ['https://x.com/vercel/status/1683920951807971329', '1683920951807971329'],
    ['https://twitter.com/vercel/status/1683920951807971329', '1683920951807971329'],
    ['https://x.com/vercel/status/1683920951807971329?s=20', '1683920951807971329'],
    ['https://twitter.com/i/web/statuses/1683920951807971329', '1683920951807971329'],
    ['1683920951807971329', '1683920951807971329'],
  ])('reads %s', (input, expected) => {
    expect(parseTweetRef(input)).toBe(expected);
  });

  it('keeps the id as a string, since it does not fit a JS number exactly', () => {
    const id = '1683920951807971329';
    expect(parseTweetRef(id)).toBe(id);
    // Proving the point: parsing would corrupt the last digits.
    expect(String(Number(id))).not.toBe(id);
  });

  it.each([['', 'empty'], ['notanid', 'not numeric'], ['https://x.com/vercel', 'a profile, not a tweet']])(
    'refuses %s (%s)',
    (input) => {
      expect(parseTweetRef(input)).toBeNull();
    }
  );
});

describe('buildTweetUrl', () => {
  it('links back to the tweet on x.com', () => {
    expect(buildTweetUrl('ansem', '123')).toBe('https://x.com/ansem/status/123');
  });
});
