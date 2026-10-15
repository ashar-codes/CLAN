# Discovery root cause analysis

Branch `fix/discovery-and-android-push`. Symptom reported: manual pairing (QR/code) works, automatic Nearby discovery
of people and live CLANs is unreliable on an unrestricted same-LAN network, especially between new installs.

Pipeline traced: interface → permission → listener → registration → multicast advert → browse → resolve → address
selection → anonymous probe → authentication → UI. Each finding below is marked **Proven** (reproduced/observed),
**Code-evident** (deterministic from code; device-dependent trigger), or **Fixed-unproven on hardware**.

## 1. Adverts published unreachable addresses; receivers used one of them — Proven
`bonjour-service` publishes an A record for **every** non-internal IPv4 address of the machine (VPN, VM, Docker,
Hyper-V, Internet Sharing bridges, link-local USB/Thunderbolt adapters) under the **OS host name**, while every CLAN
receiver used a single address: desktop browsers took the first IPv4 record, Android took `NsdServiceInfo.host`
(one arbitrary record). Picking an unreachable one fails the TCP/TLS probe, and the failure was swallowed, so the
person simply never appeared.

Reproduction on this Mac (`tools/diag/repro-link-addresses.mts`), interfaces `en0 192.168.18.223` (Wi‑Fi) and
`en7 169.254.102.138` (link-local adapter):
- before: on the wire `["192.168.18.223","169.254.102.138"]`
- after: on the wire `["192.168.18.223"]`, host `clan-<random>.local`; browser addrs ranked `["192.168.18.223"]` (3/3 runs)

Windows machines commonly have vEthernet/VPN/VirtualBox adapters, so desktop↔desktop and phone→Windows discovery was
especially exposed. **Fix:** `packages/server/src/lan-mdns.ts` publishes per real LAN interface (virtual/VPN adapters
excluded; link-local only when nothing else exists) with only that interface's address under a CLAN-specific host
name; browsers keep and rank all addresses (same subnet → hinted → private) and callers try each in order. The hosted
CLAN advert gets the same record filtering.

## 2. New users were not discoverable until they opened People — Proven (emulator)
The phone started its listener/advert/NSD browse only through `phonePeople()`, which ran at launch **only for users
who already had contacts**. Two fresh installs sitting on Home were invisible to each other; previously paired users
worked — matching the report. **Fix:** Nearby starts at launch for every onboarded person (Nearby "Off" respected).
Observed on the emulator: right after onboarding, with only Home open, Android registered `clan-rB0oHDq0`
(`_clanlink._tcp`) and started browsing.

## 3. Android NSD resolve queue could stall or drop services — Code-evident
`PeerRadios` resolved one service at a time with **no deadline** (a resolve that never answers blocked every later
service until restart) and **no retry** (a failed resolve, e.g. `FAILURE_ALREADY_ACTIVE` while another NSD client in
the same app was resolving, was dropped for good). CLAN discovery used `react-native-zeroconf`, a second NSD client in
the same process. **Fix:** one serialized queue for People and hosted CLANs, 10 s deadline per resolve, two retries
with backoff, de-duplication, status events (`found`, `resolve-failed`, `browse-failed`, `advertise-failed`) instead of
silent drops. On Android, hosted CLANs now browse through this queue.

## 4. Android passed one, possibly IPv6, address — Code-evident
Only `s.host` was used and turned into `tcp:<host>:<port>`; an IPv6 link-local answer produced an invalid link address
and the probe failed silently. **Fix:** all addresses (`hostAddresses` on API 34+), IPv4 first, IPv6 bracketed; JS
tries each.

## 5. No network-change handling outside Keep mode — Proven (emulator)
Only the Keep-available foreground service watched connectivity. **Fix:** a Wi‑Fi/Ethernet network callback in the
PeerLink module (debounced) restarts NSD browse + advert in normal foreground use. Observed: `svc wifi disable/enable`
produced a new registration (`clan-ElPp4gbz`) without user action.

## 6. Phones probed their own rotated adverts — Proven (emulator diagnostics)
After an advert id rotation the network still answered with the old one; the phone probed itself and the failure was
misclassified. **Fix:** remember recent own ids; reaching oneself is a no-op.

## 7. Join window and wrong-code misreporting — Proven (deterministic test)
The phone passed `discoveryWindowMs = 3000 − time already waited` (usually ≈0), so a host announced or resolved a moment
late was never tried. Separately, when the bounded window ended while a candidate was still pairing, the result was
`none_found` instead of that candidate's `bad_code` — the cause of the intermittent `join-discovery` unit failure.
Deterministic reproduction added (slow network: expected `bad_code`, received `none_found` before the fix).
**Fix:** state-based window (keep trying late, authenticated-only candidates while new adverts arrive; stop 2.5 s after
the last new one once known attempts settled; 9 s bound like desktop); `none_found` only when nothing else was tried.

## 8. Desktop CLAN browse did not follow network changes — Code-evident
Browsers were created once per Join screen with the interfaces of that moment. **Fix:** recreated when LAN addresses change.

## Not causes (checked)
- Service types match on all platforms (`_clanlink._tcp`, `_clanpeer._tcp`, `_classroomlan._tcp`).
- Android multicast lock: NSD acquires it (`WifiService: acquireMulticastLock … tag=NsdService` observed).
- Host readiness: `startClassroomServer` returns only after the advert is announced.
- Default visibility: fixed in the previous phase (new people default to Everyone Nearby).

## Privacy note (corrected wording)
Nearby probes strangers anonymously so an advertiser never learns who looked. Therefore while a person is Everyone
Nearby, anyone on the network — including someone they blocked — can see their public profile; blocking stops all
contact. UI text that said blocked people never see you was wrong and has been corrected. Friends Only / Invisible hide
from everyone.

## What remains unproven
Behaviour on real Android/iPhone/Windows hardware and on the user's own networks: emulators have no multicast to the
LAN. Findings 3–4 are fixed in code and exercised on the emulator but need the physical test guide
(DISCOVERY_QA_INSTALLATION.md) and an exported diagnostics report from the user's devices.
