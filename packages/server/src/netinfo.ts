import { networkInterfaces } from 'node:os';

export type Iface = { name: string; address: string; private: boolean };

const isPrivate = (a: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(a);

/** IPv4 interfaces a classroom could be hosted on, best candidate first. */
export function candidateInterfaces(): Iface[] {
  const out: Iface[] = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      // Skip loopback and typical VPN/virtual adapters; students can't reach those.
      if (a.family !== 'IPv4' || a.internal || /^(utun|tun|tap|vEthernet|docker|br-|bridge|vmnet|awdl|llw)/i.test(name)) continue;
      out.push({ name, address: a.address, private: isPrivate(a.address) });
    }
  }
  const score = (i: Iface) => (i.private ? 0 : 2) + (i.address.startsWith('169.254.') ? 1 : 0) + (/^(en0|wi-?fi|wlan)/i.test(i.name) ? -1 : 0);
  return out.sort((x, y) => score(x) - score(y));
}
