import { describe, expect, it } from 'vitest';
import { retainPeople } from '../src/people/availability.ts';
describe('availability consent and OS limits', () => {
  it('keeps Android listening while disconnected only with explicit keep mode', () => {
    expect(retainPeople('android', 'keep', false)).toBe(true);
    for (const mode of ['app', 'off', 'session']) expect(retainPeople('android', mode, false)).toBe(false);
    expect(retainPeople('android', 'session', true)).toBe(true);
    expect(retainPeople('android', 'off', true)).toBe(false);
  });
  it('never promises an iOS background LAN listener, even with saved Android settings', () => {
    for (const mode of ['keep', 'session', 'app', 'off']) expect(retainPeople('ios', mode, true)).toBe(false);
  });
});
