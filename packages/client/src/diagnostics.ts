// Connectivity diagnostics shared by desktop and phone (docs/DISCOVERY_RELIABILITY_VERIFICATION.md). Records the
// state of each discovery stage and a bounded list of transitions. Only coarse facts are kept: no keys, invites, QR
// secrets, message content, file names or full presence tags. Addresses are local-network addresses the person can
// already see in their network settings.
export type DiscoveryFailure =
  | 'no-network' | 'permission' | 'listener' | 'advertise' | 'browse' | 'resolve' | 'unreachable' | 'hidden-or-refused' | 'auth' | 'isolated';

export type DiscoveryState = {
  network: boolean; addresses: string[]; listener: number | null; advertising: boolean; browsing: boolean;
  clanBrowsing: boolean; servicesFound: number; servicesResolved: number; probesOk: number; probesFailed: number;
  clansFound: number; lastPeerAt: number | null; lastFailure: DiscoveryFailure | null; lastFailureAt: number | null;
  permissions: string[]; restarts: number; lastRestartAt: number | null;
};

const HINT: Record<DiscoveryFailure, string> = {
  'no-network': 'No Wi-Fi or LAN address. Join the same Wi-Fi as the other device.',
  permission: 'A permission is missing (Local Network on Apple devices, Nearby devices/notifications on Android).',
  listener: 'CLAN could not open its local listener. Restart CLAN; check that a firewall allows CLAN.',
  advertise: 'This device could not announce itself on the network (multicast refused). Others can still connect by code.',
  browse: 'This device could not look for others (multicast unavailable). Use a code or the host address.',
  resolve: 'Others were heard but their address could not be resolved. Tap Refresh discovery; if it persists use a code.',
  unreachable: 'Others were found but could not be reached: the network may isolate devices (guest/client isolation, VLANs) or a firewall blocks CLAN. Use a code or ask the administrator.',
  'hidden-or-refused': 'Devices were found but did not share a profile (Friends Only, Invisible, or blocked). This is expected privacy behaviour.',
  auth: 'A device answered but failed identity verification. It was not trusted.',
  isolated: 'The network blocks multicast discovery between devices. Use a QR code, the host address, or the internal directory.',
};

export class DiscoveryDiagnostics {
  state: DiscoveryState = { network: false, addresses: [], listener: null, advertising: false, browsing: false, clanBrowsing: false, servicesFound: 0, servicesResolved: 0,
    probesOk: 0, probesFailed: 0, clansFound: 0, lastPeerAt: null, lastFailure: null, lastFailureAt: null, permissions: [], restarts: 0, lastRestartAt: null };
  private events: { at: number; what: string }[] = [];
  private subs = new Set<() => void>();
  private readonly now: () => number;
  constructor(now = () => Date.now()) { this.now = now; }
  onChange(cb: () => void) { this.subs.add(cb); return () => { this.subs.delete(cb); }; }
  private changed() { for (const s of this.subs) s(); }
  /** Merge state and log the transition when something actually changed. */
  set(patch: Partial<DiscoveryState>, note?: string) {
    const before = JSON.stringify(this.state);
    this.state = { ...this.state, ...patch };
    if (note || JSON.stringify(this.state) !== before) this.event(note ?? Object.entries(patch).map(([k, v]) => `${k}=${Array.isArray(v) ? v.length : v}`).join(' '));
    else return;
    this.changed();
  }
  count(k: 'servicesFound' | 'servicesResolved' | 'probesOk' | 'probesFailed' | 'clansFound', by = 1) { this.state[k] += by; if (k === 'probesOk') this.state.lastPeerAt = this.now(); this.changed(); }
  fail(f: DiscoveryFailure, detail = '') { this.state.lastFailure = f; this.state.lastFailureAt = this.now(); this.event(`failure ${f}${detail ? `: ${clean(detail)}` : ''}`); this.changed(); }
  restarted(reason: string) { this.state.restarts++; this.state.lastRestartAt = this.now(); this.event(`restart (${clean(reason)})`); this.changed(); }
  event(what: string) { this.events.push({ at: this.now(), what: clean(what) }); if (this.events.length > 200) this.events.splice(0, this.events.length - 200); }
  hint() { return this.state.lastFailure ? HINT[this.state.lastFailure] : null; }
  recent(n = 30) { return this.events.slice(-n); }
  /** Plain text the person can share with support. Contains no keys, codes, invites, messages or file names. */
  export(meta: Record<string, string>) {
    const s = this.state, t = (x: number | null) => (x ? new Date(x).toISOString() : '—');
    return [
      'CLAN connectivity diagnostics', ...Object.entries(meta).map(([k, v]) => `${k}: ${clean(v)}`), '',
      `network: ${s.network ? 'available' : 'unavailable'} (${s.addresses.join(', ') || 'no LAN address'})`,
      `listener: ${s.listener ? `ready on port ${s.listener}` : 'not ready'}`, `advertising: ${s.advertising}`, `people discovery: ${s.browsing}`, `CLAN discovery: ${s.clanBrowsing}`,
      `services found/resolved: ${s.servicesFound}/${s.servicesResolved}`, `probes ok/failed: ${s.probesOk}/${s.probesFailed}`, `CLANs found: ${s.clansFound}`,
      `last authenticated peer: ${t(s.lastPeerAt)}`, `last failure: ${s.lastFailure ?? 'none'} at ${t(s.lastFailureAt)}`, `missing permissions: ${s.permissions.join(', ') || 'none'}`,
      `restarts: ${s.restarts} (last ${t(s.lastRestartAt)})`, `hint: ${this.hint() ?? '—'}`, '', 'recent events:',
      ...this.events.map((e) => `${new Date(e.at).toISOString()}  ${e.what}`),
    ].join('\n');
  }
}
/** Strip anything that looks like a key, token, invite or long identifier; bound the length. */
export function clean(s: string) {
  return String(s).replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]').replace(/clan:\/\/\S+/g, 'clan://[redacted]').slice(0, 200);
}
