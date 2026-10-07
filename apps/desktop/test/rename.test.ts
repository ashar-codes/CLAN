// Product rename: user-facing text says CLAN; legacy identifiers that protect stored data and signatures stay.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { LEGACY_STORAGE_NAME, PRODUCT_NAME, SERVICE_TYPE } from '@classroom/protocol';

const root = join(import.meta.dirname, '../../..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

describe('CLAN rename', () => {
  it('product name is CLAN; storage identity and discovery type are unchanged', () => {
    expect(PRODUCT_NAME).toBe('CLAN');
    expect(LEGACY_STORAGE_NAME).toBe('Classroom LAN');
    expect(SERVICE_TYPE).toBe('classroomlan');
  });

  it('no user-facing surface says "Classroom LAN"', () => {
    const renderer = readdirSync(join(root, 'apps/desktop/src/renderer')).map((f) => `apps/desktop/src/renderer/${f}`);
    for (const f of [...renderer, 'apps/desktop/electron-builder.yml', 'apps/mobile/app.json', 'apps/mobile/src/App.tsx']) {
      expect(read(f), f).not.toMatch(/Classroom LAN/i);
    }
  });

  it('desktop sets the legacy storage name before ready and CLAN only after the keystore exists', () => {
    const main = read('apps/desktop/src/main/main.ts');
    const legacy = main.indexOf('app.setName(LEGACY_STORAGE_NAME)');
    const ready = main.indexOf('app.whenReady()');
    const keystore = main.indexOf('new Keystore()', ready);
    const product = main.indexOf('app.setName(PRODUCT_NAME)');
    expect(legacy).toBeGreaterThan(-1);
    expect(legacy).toBeLessThan(ready);
    expect(keystore).toBeLessThan(product);
  });

  it('signed payload types keep their legacy prefix (signatures depend on it)', () => {
    expect(read('packages/server/src/peers.ts')).toContain("'classroom-lan/peer-endorsement'");
  });
});
