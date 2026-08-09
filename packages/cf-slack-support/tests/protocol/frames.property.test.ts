import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import {
  isClientFrameType,
  isServerFrameType,
  parseClientFrame,
  parseServerFrame,
} from '../../src/protocol';

const clientTypes = [
  'hello',
  'send',
  'open_conversation',
  'close_conversation',
  'reopen_conversation',
  'ping',
] as const;

const serverTypes = [
  'ready',
  'message',
  'messages',
  'conversation',
  'ack',
  'error',
  'pong',
] as const;

describe('protocol frames', () => {
  it('parses known client frame types (property)', () => {
    fc.assert(
      fc.property(fc.constantFrom(...clientTypes), (type) => {
        const raw = JSON.stringify({ type, clientId: 'c1', conversationId: 'x' });
        const frame = parseClientFrame(raw);
        expect(frame).not.toBeNull();
        expect(frame!.type).toBe(type);
        expect(isClientFrameType(type)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('parses known server frame types (property)', () => {
    fc.assert(
      fc.property(fc.constantFrom(...serverTypes), (type) => {
        const raw = JSON.stringify({ type, code: 'x', message: 'y', clientId: 'c' });
        const frame = parseServerFrame(raw);
        expect(frame).not.toBeNull();
        expect(frame!.type).toBe(type);
        expect(isServerFrameType(type)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('rejects unknown types and invalid JSON (property)', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 40 }).filter((s) => !clientTypes.includes(s as never)),
        (type) => {
          expect(parseClientFrame(JSON.stringify({ type }))).toBeNull();
        },
      ),
      { numRuns: 50 },
    );

    fc.assert(
      fc.property(fc.string(), (s) => {
        // Random strings are almost never valid JSON objects with a type field.
        if (s.trim().startsWith('{')) return;
        expect(parseClientFrame(s)).toBeNull();
        expect(parseServerFrame(s)).toBeNull();
      }),
      { numRuns: 100 },
    );
  });

  it('round-trips JSON objects with required type', () => {
    const frame = parseClientFrame(
      JSON.stringify({
        type: 'send',
        clientId: 'abc',
        body: 'hello',
        attachmentIds: ['u1/a.png'],
      }),
    );
    expect(frame).toEqual({
      type: 'send',
      clientId: 'abc',
      body: 'hello',
      attachmentIds: ['u1/a.png'],
    });
  });

  it('rejects malformed and oversized known frames', () => {
    expect(parseClientFrame(JSON.stringify({ type: 'send', body: 'missing client id' }))).toBeNull();
    expect(
      parseClientFrame(JSON.stringify({ type: 'send', clientId: 'c1', attachmentIds: 'bad' })),
    ).toBeNull();
    expect(
      parseClientFrame(JSON.stringify({ type: 'send', clientId: 'c1', body: 'x'.repeat(8_001) })),
    ).toBeNull();
    expect(
      parseClientFrame(
        JSON.stringify({
          type: 'send',
          clientId: 'c1',
          attachmentIds: Array.from({ length: 11 }, (_, index) => `u/a-${index}.png`),
        }),
      ),
    ).toBeNull();
  });
});
