# Profiles, visibility and discovery (final phase)

## Onboarding

- Phone and computer require **full name** and **device name** on first run (Unicode, whitespace collapsed,
  ≤ 80 / ≤ 60 characters). Student/ID number, picture, university/department/course are optional; the ID number is
  asked only when joining a CLAN that needs it.
- The person chooses **Everyone nearby (default)**, Friends only or Invisible, with a plain explanation.
- Nothing is advertised and no profile is released until a real name exists (`People.ready()`).
- Placeholder/demo values removed from production code (“Ashar Khan”, “Ashar-MacBook”, “Ashar-iPhone”, the
  `CLAN user` fallback name). Test fixtures keep their sample names inside tests.

## Real names everywhere

Root cause of wrong names: phones never copied the onboarding name into the People profile, so they advertised the
placeholder `CLAN user`. Now `People.adoptIdentity(name, device, previous)` runs on every start and profile save:
it replaces only an unset/placeholder People name (or the previous onboarding name), never a name the person chose
separately, and always records the device name. The device name travels inside the authenticated link `hi` message
and is shown as the secondary label (chat header, contact details). Identity stays the device key; renaming never
creates a new contact. Unauthenticated adverts carry no names.

Notifications show the sender's real name when previews are allowed (desktop and phone).

## Visibility

| | Before | Now |
|---|---|---|
| New person | Friends Only | **Everyone Nearby, until changed** |
| Everyone Nearby | always expired after 1 h | persistent; “Only for 1 hour” is an explicit option |
| Existing users | — | keep their saved choice (migration never touches it) |

Blocking, Invisible and per-field visibility are unchanged and still enforced on every profile release.

## Why new devices could not find each other

Strangers are discovered only by an anonymous probe that succeeds when the other device is in Everyone mode. With
Friends Only as the default and Everyone expiring after an hour, two fresh installs never saw each other; previously
paired devices worked because friends recognise each other's presence tags. Changing the default (and fixing the
`CLAN user` name) addresses the reported behaviour without weakening the protocol: adverts still contain only a random
id and presence tag.

## Hosted CLAN discovery

- A CLAN appears only while it is **live-hosted** (created-but-offline CLANs are not advertised); the radar says so.
- Phone browsing (`apps/mobile/src/discovery.ts`) no longer swallows errors: failed scans are restarted with backoff
  and on returning to the foreground; the state is shown in the CLAN radar.
- Join codes, host approval, QR/manual address remain unchanged; QR/manual is the fallback.

## Network scope

Same router, bridged access points (same L2 multicast domain), no-internet LANs: discovery by mDNS/NSD/Bonjour.
Routed subnets: only through the existing optional authenticated LAN directory or QR/manual address. CLAN does not
scan ranges or bypass client isolation/VLANs. Diagnostics separate discovery, reachability, authentication and session
states (Nearby › Connectivity diagnostics, CLAN radar status).

Physical multi-router / different-AP testing: **NOT TESTED**.
