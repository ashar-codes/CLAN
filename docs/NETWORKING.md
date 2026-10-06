# Networking

## LAN Mode (implemented, Windows/macOS/Linux teacher)
1. Teacher picks a network adapter (auto: private IPv4, Wi-Fi first; VPN/virtual adapters skipped).
2. Server binds that address on a random free port and advertises `_classroomlan._tcp` via DNS-SD on that interface.
3. Students browse, POST the code to each classroom found, and the matching one answers.
4. Fallback: the student "Can't find the class?" panel explains client isolation / firewall issues and accepts the
   address shown on the teacher's Network card. Ordinary users never need it.

Verified on this machine: real multicast discovery on `en0` (Wi-Fi), desktop teacher ↔ desktop student (E2E test).

Common real-world failure: guest/university Wi-Fi with **client isolation** blocks device-to-device traffic entirely;
no software workaround exists — use a classroom router or Direct Mode (Windows, M3).

## Direct Mode
Not implemented yet (Milestone 3). See WINDOWS_DIRECT_MODE.md. The UI shows it disabled with an OS-specific reason.
