// Test fixture: a first launch now shows onboarding. E2E profiles are disposable temp dirs, so seed the onboarding
// result (name + device; no ID number, so join forms still ask) unless a test already created one.
import { _electron } from 'playwright-core';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const launch = _electron.launch.bind(_electron);
_electron.launch = (o?: Parameters<typeof launch>[0]) => {
  const dir = o?.env?.CLASSROOM_USER_DATA;
  if (dir && !existsSync(join(dir, 'profile.json')) && o.env.CLAN_E2E_ONBOARDING !== '1') {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'profile.json'), JSON.stringify({ fullName: 'E2E Tester', rollNo: '', deviceName: 'E2E device' }));
  }
  return launch(o);
};
