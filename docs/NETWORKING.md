# Networking

## LAN Mode (implemented, Windows/macOS/Linux teacher)
1. Teacher picks a network adapter (auto: private IPv4, Wi-Fi first; VPN/virtual adapters skipped).
2. Server binds that address: a plaintext bootstrap port (advertised via DNS-SD, OPAQUE only) and an HTTPS port (learned only
   from the OPAQUE-authenticated binding).
3. Students browse and run OPAQUE with the code against each classroom found; the one where OPAQUE succeeds is theirs
   (discovery is never trusted — see PAIRING_AND_TRUST.md).
4. Fallback: the student "Can't find the class?" panel explains client isolation / firewall issues and accepts the
   address shown on the teacher's Network card. Ordinary users never need it.

Verified on this machine: real multicast discovery on `en0` (Wi-Fi), desktop teacher ↔ desktop student (E2E test).

Common real-world failure: guest/university Wi-Fi with **client isolation** blocks device-to-device traffic entirely;
no software workaround exists — use a classroom router or Direct Mode (Windows, M3).

## Direct Mode
Not implemented yet (Milestone 3). See WINDOWS_DIRECT_MODE.md. The UI shows it disabled with an OS-specific reason.

## Peer traffic (Milestone 2.75)
Peer servers bind only the interface on the teacher's subnet; peer traffic never uses cellular or the internet. Peers are found
through the teacher's tracker (authenticated) and a last-known cache — not by trusting mDNS, IPs or names.
On a single Wi-Fi access point, peer-to-peer traffic consumes the same shared airtime as teacher traffic (A → AP → B); peer
assistance offloads the teacher *machine*, it does not create channel capacity. Multi-AP and wired networks gain capacity.
See PEER_ASSISTED_MODE.md and TRANSPORT_MODES.md.
