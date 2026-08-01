import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import {
  buildBlocks,
  clientSafeError,
  jsonAttachments,
  parseAttachments,
  parseReactions,
  titleFromFirstMessage,
} from '../../src/core/do/utils';

describe('core utils', () => {
  it('attachment JSON round-trip (property)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.string({ minLength: 1, maxLength: 20 }),
            url: fc.webUrl(),
            contentType: fc.constantFrom('image/png', 'image/jpeg', 'text/plain'),
          }),
          { maxLength: 5 },
        ),
        (atts) => {
          const raw = jsonAttachments(atts);
          expect(parseAttachments(raw)).toEqual(atts);
        },
      ),
      { numRuns: 40 },
    );
  });

  it('parseReactions drops invalid entries (property)', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const out = parseReactions(s);
        expect(Array.isArray(out)).toBe(true);
        for (const r of out) {
          expect(r.count).toBeGreaterThan(0);
          expect(r.emoji.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 50 },
    );

    expect(
      parseReactions(
        JSON.stringify([
          { emoji: '👍', name: '+1', count: 2 },
          { emoji: '', name: 'x', count: 1 },
          { emoji: '🔥', name: 'fire', count: 0 },
        ]),
      ),
    ).toEqual([{ emoji: '👍', name: '+1', count: 2 }]);
  });

  it('clientSafeError never leaks raw SQL', () => {
    const e = clientSafeError('UNIQUE constraint failed: messages.slack_ts', 'send');
    expect(e.code).toBe('send_failed');
    expect(e.message.toLowerCase()).not.toContain('sqlite');
    expect(e.message.toLowerCase()).not.toContain('unique');
  });

  it('buildBlocks includes images and optional header', () => {
    const blocks = buildBlocks(
      {
        id: 'm1',
        conversationId: 'c1',
        body: 'hi',
        attachments: [
          {
            id: 'a',
            url: 'https://x/a.png',
            contentType: 'image/png',
            filename: 'a.png',
          },
        ],
        authorRole: 'customer',
        authorName: 'Ada',
        createdAt: 1,
      },
      'Title',
    );
    expect(blocks.some((b) => (b as { type: string }).type === 'header')).toBe(true);
    expect(blocks.some((b) => (b as { type: string }).type === 'image')).toBe(true);
  });

  it('titleFromFirstMessage', () => {
    expect(titleFromFirstMessage('hello world', 0)).toBe('hello world');
    expect(titleFromFirstMessage(null, 1)).toBe('Image');
    expect(titleFromFirstMessage(null, 0)).toBe('New chat');
  });
});
