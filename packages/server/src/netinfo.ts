import { networkInterfaces } from 'node:os';

export type Iface = { name: string; address: string; private: boolean };

const isPrivate = (a: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(a);

/** IPv4 interfaces a classroom could be hosted on, best candidate first. */
// Virtual adapters students can't reach: Unix names, plus Windows adapter names (WSL/Hyper-V, VMware, VirtualBox,
// Mobile-hotspot/Wi-Fi-Direct "Local Area Connection* N", Bluetooth PAN, tunnelling pseudo-interfaces).
const VIRTUAL = /^(utun|tun|tap|vEthernet|docker|br-|bridge|vmnet|awdl|llw)|VMware|VirtualBox|Hyper-V|Local Area Connection\*|Bluetooth|Loopback|isatap|Teredo/i;
export function candidateInterfaces(ifaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): Iface[] {
  const out: Iface[] = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs ?? []) {
      // Skip loopback and typical VPN/virtual adapters; students can't reach those.
      if (a.family !== 'IPv4' || a.internal || VIRTUAL.test(name)) continue;
      out.push({ name, address: a.address, private: isPrivate(a.address) });
    }
  }
  const score = (i: Iface) => (i.private ? 0 : 2) + (i.address.startsWith('169.254.') ? 1 : 0) + (/^(en0|wi-?fi|wlan|ethernet)/i.test(i.name) ? -1 : 0);
  return out.sort((x, y) => score(x) - score(y));
}

const VPN = /^(utun|tun|tap|ppp|ipsec|wg|tailscale|zt|nordlynx|proton|mullvad|.*vpn.*|.*wireguard.*)/i;
/** Active VPN-looking interfaces (name patterns + CGNAT range used by overlay VPNs). Best effort: used to warn, never to trust. */
export function vpnInterfaces(ifaces = networkInterfaces()): string[] {
  const out = new Set<string>();
  for (const [name, addrs] of Object.entries(ifaces)) for (const a of addrs ?? []) {
    if (a.internal) continue;
    if (VPN.test(name) || (a.family === 'IPv4' && /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address))) out.add(name);
  }
  return [...out];
}
