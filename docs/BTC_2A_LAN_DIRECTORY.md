# BTC-2A internal LAN directory

BTC-2A extends the existing LAN transports; it does not make isolated networks reachable. Shared ISP access does not imply an internal route. Multicast Bonjour/NSD still provides same-subnet discovery, including bridged access points. A scanned trusted QR/address already supports authenticated routed TCP. The optional directory supplies cross-subnet discovery without scanning address ranges or forwarding messages.

## Trust and privacy

Clients explicitly enable an administrator-provided HTTPS configuration under People → Nearby. Its certificate and SPKI pin are required. The administrator explicitly enrolls each device's **public** Ed25519 identity key, shown on that screen. Registration and lookup signatures bind the method, path, body hash, recipient pin, timestamp and nonce. Replays, unenrolled callers, wrong pins and malformed input fail closed.

The trusted administrator sees enrolled public keys, connection addresses and rotating advertisements. Lookup replies omit publisher keys and private profiles. Friends recognize existing presence tags; other people disclose only profiles their visibility permits after an anonymous encrypted handshake. Invisible suppresses People publication. A discoverable hosted CLAN publishes its public title/type and OPAQUE bootstrap address. Hints are untrusted: enrollment does not certify ownership of an advertised address or CLAN. Actual identity, friendship, blocking, certificate pinning, OPAQUE pairing and host authority remain enforced by the existing transports.

Registrations expire within 90 seconds; refresh normally takes 30 seconds. Disable removes local hints immediately; the server record expires automatically. There is no durable directory identity database, plaintext message/file access, payload forwarding, internet relay, push service or firewall bypass. “Connected via Gateway” is therefore **not** displayed. “Internal Network” indicates directory discovery, not a measured subnet, distance or a guarantee of a working route. Persistent Connected/Reconnecting/Offline state comes from the authenticated connection manager.

## Administrator deployment

Use Node 24 and the checked-out BTC-2A revision, with `pnpm install --frozen-lockfile`. Use an existing, separately provisioned ECDSA P-256 CLAN-compatible TLS certificate/key (same CA/SPKI trust contract as other CLAN endpoints). Never use an application's identity private key as the server TLS key. Keep server configuration and private TLS material outside the repository, restricted to the service account. The service does not generate or replace keys.

Example **server configuration shape**, with placeholders to replace locally:

```json
{"host":"10.71.0.1","port":7443,"certFile":"/secure/clan-directory/cert.pem","keyFile":"/secure/clan-directory/key.pem","spkiSha256":"<base64 SHA-256 of DER SubjectPublicKeyInfo>","allowedKeys":["<device public Ed25519 key, base64url>"]}
```

Start as an ordinary service user from the repository:

```sh
node tools/sim/lan-directory.ts /secure/clan-directory/config.json
```

Bind one explicit RFC1918 IPv4 address or IPv6 ULA interface; wildcard/public addresses and DNS endpoint names are rejected. Provide permitted routes and narrowly scoped firewall rules through the network administrator. No public internet is needed at runtime. Windows TEST's existing inbound rules are local-subnet scoped: an administrator must explicitly authorize the intended routed subnets; BTC-2A does not broaden those rules automatically. Client isolation, blocked VLAN routes or NAT cannot be repaired by discovery alone.

Provide users this **public client configuration**, after verifying its pin through a trusted channel:

```json
{"url":"https://10.71.0.1:7443","certificate":"<DER certificate, standard base64>","spkiSha256":"<base64 SHA-256 of DER SubjectPublicKeyInfo>"}
```

Users paste it into People → Nearby → Optional internal network directory and enable it deliberately. Obtain their enrollment public keys and restart the service with an updated allowlist for enrollment/revocation. No passwords, private keys or app profiles belong in either Git or test reports.

Limits: 256 enrolled keys, 128 advertisements total, eight per publisher, three endpoints per advert, 16 KiB request bodies, bounded replay cache, 240 requests/minute globally. This is a small trusted internal deployment; the global budget can be exhausted by hostile internal callers. Use administrator-controlled ingress/rate controls and size deployment accordingly. It is not a hardened public internet service. Client validation caps parsed responses at 128 KiB; native response buffering and cancellation remain platform transport limitations, so the configured directory must be trusted. TLS redirect forwarding is disabled on Android/iOS and directory requests reject redirects on desktop.

## Routing and lifecycle

Keep an existing authenticated session; rank remembered addresses using actual IPv4 interface/netmask matches where available, then routed hints. Attempts are bounded, identical dials coalesce, duplicate sessions use the existing deterministic identity rule, failures back off, and network-change events wake retries. No stale WebRTC signaling is queued. Existing encrypted outboxes, recipient delivery receipts, attachment consent, SHA verification, expiration and blocking remain unchanged.

Profile/visibility/friendship changes rotate local hints and request a follow-up directory round, even when another round is in flight. Multicast publication is serialized so Invisible cannot leave an orphan advertisement. Blocking closes authenticated direct sessions before another flush. Invalid saved directory certificates fail closed without disabling ordinary peer networking; invalid replacements do not overwrite a working desktop configuration.

On mobile, explicitly select While using CLAN or Keep CLAN Available before expecting the phone to publish/listen; enabling the directory does not silently enable continuous background availability. Android directory refresh is driven by the existing foreground-service availability pulses when the user enables Keep CLAN Available. Default Android/iOS stop or suspend according to OS policy and reconnect on resume. Desktop address changes are observed without closing healthy sessions. IPv4 is primary; the directory accepts IPv6 ULA endpoints, but native IPv6 roaming and multi-interface routing require hardware validation. Unicast DNS-SD/discovery-proxy integration and encrypted gateway forwarding are not implemented; the authenticated directory is the implemented cross-subnet discovery option.

## Verification and hardware handoff

`tools/sim/lan-topology.sh routed` runs only on a disposable Linux CI runner, creates three named network namespaces, routes two /24 subnets internally, cuts a link, changes the recipient IP and restores it. The `bridged` mode uses an actual virtual Ethernet bridge and multicast route with directory discovery disabled. `lan-topology.ts` uses the production pinned directory and People runtime; the routed mode disables multicast to require cross-subnet directory discovery. File-system markers coordinate phases only; authenticated text/receipts, consented file/voice bytes and live call signaling travel through real TCP sockets. Fresh test-only identities/certificates never replace user keys. This is virtual routing evidence, not physical access-point or audio-device evidence.

1. Two test devices on one LAN: discover, verify identities, send text/file/voice and place a call.
2. Move one device to another bridged AP: repeat; confirm no duplicates and no invented distance.
3. On administrator-permitted routed subnets, exchange a trusted QR and verify direct connectivity first.
4. Enable/enroll the directory on both devices; confirm Internal Network discovery and authenticated connection/receipts.
5. Disable a permitted route: recipients remain unreachable, deliveries stay queued, and directory hints never imply Connected.
6. Restore routing and change a device IP: pending text/file/voice deliver once; file SHA and recipient receipts match.
7. Repeat with Android Keep enabled, locked screen, desktop tray, restart and iOS resume. iOS continuous suspended LAN listening is not promised.
8. Block/revoke a device; verify refusal, then repeat existing classroom hosting/handover fencing tests.

See BTC_2A_RESULTS.md for actual measured results and remaining gates. BTC-1 installers and installed profiles are preserved; no BTC-2A distribution build is delivered in this stage.
