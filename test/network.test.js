import { describe, expect, it } from 'vitest';
import { listInterfaces } from '../src/utilities/network.js';

describe('listInterfaces', () => {
  it('returns IPv4 cards with real ones before loopback', () => {
    const list = listInterfaces();
    expect(list.length).toBeGreaterThan(0);
    for (const i of list) expect(i.address).toMatch(/^\d{1,3}(\.\d{1,3}){3}$/);
    const firstLoop = list.findIndex((i) => i.internal);
    if (firstLoop >= 0) expect(list.slice(firstLoop).every((i) => i.internal)).toBe(true);
  });
});
