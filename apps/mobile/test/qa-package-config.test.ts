import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
const require = createRequire(import.meta.url);
const configure = require('../app.config.js');
it('keeps the ordinary mobile identity unchanged and isolates QA app, group and source stamp', () => {
  const config = require('../app.json').expo;
  const oldMode = process.env.CLAN_BTC2R_QA, oldSha = process.env.CLAN_SOURCE_SHA;
  try {
    delete process.env.CLAN_BTC2R_QA;
    expect(configure({ config })).toBe(config);
    process.env.CLAN_BTC2R_QA = '1'; process.env.CLAN_SOURCE_SHA = 'a'.repeat(40);
    const qa = configure({ config });
    expect(qa.ios.bundleIdentifier).toBe('app.classroomlan.student.btc2r');
    expect(qa.ios.infoPlist.CLANShareGroup).toBe('group.app.classroomlan.student.btc2r');
    expect(qa.ios.infoPlist.CLANSourceCommit).toBe('a'.repeat(40));
    expect(qa.ios.entitlements).toEqual(config.ios.entitlements);
    expect(config.ios.bundleIdentifier).toBe('app.classroomlan.student');
  } finally {
    if (oldMode === undefined) delete process.env.CLAN_BTC2R_QA; else process.env.CLAN_BTC2R_QA = oldMode;
    if (oldSha === undefined) delete process.env.CLAN_SOURCE_SHA; else process.env.CLAN_SOURCE_SHA = oldSha;
  }
});
