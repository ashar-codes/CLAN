// The static QR codes CLAN shows and scans: people (profile / friend request / chat invitation, TLS endpoints and/or
// link listeners), device linking, and Wi-Fi hotspots. Untrusted text in, strictly validated values out.
import { describe, expect, it } from 'vitest';
import { linkQr, parseLinkQr, parseProfileQr, parseWifiQr, profileQr, wifiQr } from '../src/index.ts';

const key = 'A'.repeat(43), invite = '0123456789abcdef0123456789abcdef', spki = 'B'.repeat(44);
describe('CLAN QR codes', () => {
  it('person codes: computer (TLS + link), phone (link only), intents, and refusals', () => {
    const pc = parseProfileQr(profileQr({ key, endpoints: ['192.168.1.5:4000'], spkiSha256: spki, links: ['tcp:192.168.1.5:4001'], name: 'Aisha', invite, intent: 'friend' }))!;
    expect(pc).toMatchObject({ key, endpoints: ['192.168.1.5:4000'], spkiSha256: spki, links: ['tcp:192.168.1.5:4001'], intent: 'friend', name: 'Aisha' });
    const phone = parseProfileQr(profileQr({ key, endpoints: [], links: ['tcp:192.168.49.1:7000', 'tcp:[fe80::1%wlan0]:7000'], name: 'Bilal', invite, intent: 'chat' }))!;
    expect(phone).toMatchObject({ endpoints: [], spkiSha256: '', links: ['tcp:192.168.49.1:7000', 'tcp:[fe80::1%wlan0]:7000'], intent: 'chat' });
    expect(parseProfileQr(profileQr({ key, endpoints: [], name: 'x', invite }))).toBeNull(); // nowhere to connect
    expect(parseProfileQr(`clan://p/${key}?h=1.2.3.4:5&s=${spki}&i=short`)).toBeNull();
    expect(parseProfileQr(`clan://p/${key}?l=http://evil:80&i=${invite}`)).toBeNull();
    expect(parseProfileQr(`clan://p/${key}?h=1.2.3.4:5000&i=${invite}`)).toBeNull(); // TLS endpoint without a pin
    expect(parseProfileQr('clan://p/' + key + '?l=tcp:1.2.3.4:5000&i=' + invite + '&x=admin')?.intent).toBe('profile');
  });
  it('device link codes carry only the one-time code and an address', () => {
    expect(parseLinkQr(linkQr('ABCDEFGHJKMN', ['192.168.1.9:51000']))).toEqual({ code: 'ABCDEFGHJKMN', address: '192.168.1.9:51000' });
    expect(parseLinkQr('clan://link?c=nope')).toBeNull();
    expect(parseLinkQr('clan://link?c=ABCDEFGHJKMN&a=evil.example:443')).toEqual({ code: 'ABCDEFGHJKMN', address: '' });
  });
  it('Wi-Fi hotspot codes round-trip with escaping and reject invalid networks', () => {
    expect(parseWifiQr(wifiQr('Phone;"hot":spot', 'pa;ss:wo,rd!'))).toEqual({ ssid: 'Phone;"hot":spot', passphrase: 'pa;ss:wo,rd!' });
    expect(parseWifiQr('WIFI:T:WPA;S:Net;P:short;;')).toBeNull();
    expect(parseWifiQr('WIFI:T:WPA;S:' + 'x'.repeat(40) + ';P:longenough;;')).toBeNull();
    expect(parseWifiQr('not wifi')).toBeNull();
  });
});
