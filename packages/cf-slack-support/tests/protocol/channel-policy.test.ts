import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import {
  CHANNEL_POLICY_PRESETS,
  decideInboundStaffMessage,
  describeChannelPolicy,
  resolveChannelPolicy,
  type ChannelPolicyMode,
} from '../../src/protocol';

const modes: ChannelPolicyMode[] = [
  'threads_only',
  'bidirectional',
  'staff_main_customer_threads',
];

describe('channel policy', () => {
  it('resolves string, object, and default', () => {
    expect(resolveChannelPolicy(undefined).mode).toBe('bidirectional');
    expect(resolveChannelPolicy('threads_only').mode).toBe('threads_only');
    expect(resolveChannelPolicy(CHANNEL_POLICY_PRESETS.staffMainCustomerThreads).mode).toBe(
      'staff_main_customer_threads',
    );
    expect(resolveChannelPolicy({ mode: 'bidirectional' }).mode).toBe('bidirectional');
  });

  it('thread replies always deliver for every mode (property)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...modes),
        fc.stringMatching(/^[a-z0-9.]{3,16}$/),
        (mode, ts) => {
          const parent = `p.${ts}`;
          const reply = `r.${ts}`;
          const d = decideInboundStaffMessage(mode, { ts: reply, thread_ts: parent });
          expect(d).toEqual({
            action: 'deliver_to_customer',
            threadRoot: parent,
            isThreadParent: false,
          });
        },
      ),
      { numRuns: 40 },
    );
  });

  it('top-level: bidirectional starts conversation', () => {
    expect(decideInboundStaffMessage('bidirectional', { ts: '10.1' })).toEqual({
      action: 'deliver_to_customer',
      threadRoot: '10.1',
      isThreadParent: true,
    });
    expect(decideInboundStaffMessage(CHANNEL_POLICY_PRESETS.bidirectional, { ts: '10.1' }).action).toBe(
      'deliver_to_customer',
    );
  });

  it('top-level: threads_only drops', () => {
    expect(decideInboundStaffMessage('threads_only', { ts: '10.1' })).toEqual({
      action: 'drop',
      reason: 'top_level_threads_only',
    });
  });

  it('top-level: staff_main_customer_threads drops as staff-only', () => {
    expect(decideInboundStaffMessage('staff_main_customer_threads', { ts: '10.1' })).toEqual({
      action: 'drop',
      reason: 'top_level_staff_main',
    });
  });

  it('missing ts always drops', () => {
    for (const mode of modes) {
      expect(decideInboundStaffMessage(mode, {})).toEqual({
        action: 'drop',
        reason: 'missing_ts',
      });
    }
  });

  it('describeChannelPolicy is non-empty for all modes', () => {
    for (const mode of modes) {
      expect(describeChannelPolicy(mode).length).toBeGreaterThan(20);
    }
  });
});
