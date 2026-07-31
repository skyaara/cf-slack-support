import { describe, expect, it } from 'vitest';
import { createMemoryChannelIndex } from '../src/index';

describe('createMemoryChannelIndex', () => {
  it('maps channel → customer', async () => {
    const index = createMemoryChannelIndex();
    expect(await index.getCustomerKey('C1')).toBeNull();
    await index.setCustomerKey('C1', 'user_a');
    expect(await index.getCustomerKey('C1')).toBe('user_a');
    await index.setCustomerKey('C1', 'user_b');
    expect(await index.getCustomerKey('C1')).toBe('user_b');
  });
});
