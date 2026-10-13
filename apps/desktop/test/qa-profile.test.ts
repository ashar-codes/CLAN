import { expect, it } from 'vitest';
import { qaProfile } from '../src/main/qa-profile.ts';
it('preserves production and original TEST defaults', () => {
  expect(qaProfile({})).toBeUndefined();
  expect(qaProfile({ clanInternalQa: true })).toEqual({ profile: 'personal-beta-test', appId: 'app.classroomlan.desktop.qa' });
});
it('selects the isolated BTC2R package profile and toast identity', () => {
  expect(qaProfile({ clanInternalQa: true, clanQaProfile: 'btc2r1-test', clanQaAppId: 'app.classroomlan.desktop.btc2r' })).toEqual({ profile: 'btc2r1-test', appId: 'app.classroomlan.desktop.btc2r' });
});
it('fails closed on invalid QA storage/identity instead of touching another profile', () => {
  for (const profile of ['../personal-beta-test', '', '/tmp/test']) expect(() => qaProfile({ clanInternalQa: true, clanQaProfile: profile })).toThrow();
  expect(() => qaProfile({ clanInternalQa: true, clanQaAppId: 'another.app' })).toThrow();
});
