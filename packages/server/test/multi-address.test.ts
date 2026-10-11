// Phase 14.2: a host advertised at several addresses (Windows mDNS lists WSL/Hyper-V/VMware/hotspot adapters too).
// Joining must reach the real CLAN even when the first advertised address is unreachable or another CLAN, and must try
// the code against the real host once.
import { afterEach, describe, expect, it } from 'vitest';
import * as opaque from '@serenity-kit/opaque';
import { lanUrls } from '@classroom/protocol';
import { pairAndJoin } from '@classroom/client';
import { pinnedTransport } from '@classroom/client/node';
import { classWith, device, names } from './helpers.ts';

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const c of closers.splice(0)) await c(); });

describe('lanUrls', () => {
  it('orders preferred addresses first, keeps only usable IPv4, de-duplicates and caps the list', () => {
    expect(lanUrls(5000, ['172.28.0.1', 'fe80::1', '192.168.1.20', '127.0.0.1', '999.1.1.1'], ['192.168.1.20', undefined]))
      .toEqual(['http://192.168.1.20:5000', 'http://172.28.0.1:5000']);
    expect(lanUrls(0, ['192.168.1.20'])).toEqual([]);
    expect(lanUrls(1, Array.from({ length: 20 }, (_, i) => `10.0.0.${i + 1}`))).toHaveLength(8);
  });
});

describe('join through a multi-address advertisement', () => {
  it('skips an unreachable address and a different CLAN, pairs once with the real host', async () => {
    const real = (await classWith(0)).s, other = (await classWith(0)).s;
    closers.push(() => real.close(), () => other.close());
    let pairStarts = 0;
    const counting = (u: string, i?: RequestInit) => { if (u.startsWith(real.bootstrapUrl) && u.endsWith('/api/pair/start')) pairStarts++; return fetch(u, i); };
    await opaque.ready;
    const r = await pairAndJoin({
      candidates: [{ url: 'http://127.0.0.1:1', alt: [other.bootstrapUrl, real.bootstrapUrl], sid: real.classroom.id }],
      code: real.classroom.code, profile: names(1), device: device(), opaque: opaque.client, transportFor: pinnedTransport, plainFetch: counting,
    });
    expect(r.classroom.sessionId).toBe(real.classroom.id);
    expect(new URL(r.url).hostname).toBe('127.0.0.1');
    expect(pairStarts).toBe(1);
  });
});

describe('host interface choice on Windows', () => {
  it('binds the real LAN adapter, not WSL/Hyper-V, VMware, VirtualBox, hotspot or Bluetooth adapters', async () => {
    const { candidateInterfaces } = await import('../src/netinfo.ts');
    const v4 = (address: string) => [{ address, family: 'IPv4' as const, internal: false, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: `${address}/24` }];
    const names = candidateInterfaces({
      'VMware Network Adapter VMnet8': v4('192.168.233.1'), 'VirtualBox Host-Only Network': v4('192.168.56.1'),
      'vEthernet (WSL)': v4('172.28.0.1'), 'Local Area Connection* 2': v4('192.168.137.1'), 'Bluetooth Network Connection': v4('169.254.10.1'),
      'Wi-Fi': v4('192.168.18.40'),
    }).map((i) => i.name);
    expect(names).toEqual(['Wi-Fi']);
  });
});
