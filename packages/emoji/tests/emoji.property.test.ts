import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import {
  isStandardSlackReaction,
  normalizeSlackReactionName,
  slackReactionToUnicode,
} from '../src/index';

describe('@cf-slack-support/emoji', () => {
  it('normalizes skin-tone suffixes (property)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('thumbsup', '+1', 'heart', 'white_check_mark', 'fire'),
        fc.integer({ min: 2, max: 6 }),
        (base, tone) => {
          const name = `${base}::skin-tone-${tone}`;
          expect(normalizeSlackReactionName(name)).toBe(base);
          expect(slackReactionToUnicode(name)).toBe(slackReactionToUnicode(base));
          expect(isStandardSlackReaction(name)).toBe(true);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('maps known standard names to non-empty unicode', () => {
    for (const name of ['+1', 'thumbsup', 'heart', 'white_check_mark', 'tada', 'eyes']) {
      const emoji = slackReactionToUnicode(name);
      expect(emoji).toBeTruthy();
      expect(emoji!.length).toBeGreaterThan(0);
    }
  });

  it('returns null for custom / unknown names (property)', () => {
    fc.assert(
      fc.property(
        fc
          .string({ minLength: 1, maxLength: 24 })
          .filter((s) => !/^[a-z0-9_+-]+$/i.test(s) || s.includes('custom')),
        (name) => {
          // Not all random strings are unknown, but custom_* should be.
          if (name.startsWith('custom_') || name.includes(' ')) {
            expect(slackReactionToUnicode(name)).toBeNull();
          }
        },
      ),
      { numRuns: 80 },
    );

    expect(slackReactionToUnicode('my_custom_workspace_emoji')).toBeNull();
    expect(slackReactionToUnicode('')).toBeNull();
    expect(isStandardSlackReaction('not_a_real_emoji_zzz')).toBe(false);
  });

  it('is case-insensitive and trims', () => {
    expect(slackReactionToUnicode('  Heart  ')).toBe(slackReactionToUnicode('heart'));
    expect(normalizeSlackReactionName('  +1::skin-tone-2 ')).toBe('+1');
  });
});
