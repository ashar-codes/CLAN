# Known limitations (current build)

* Milestones 0–3 (CLAN, universal join, Direct Network — unverified on hardware) exist. No screen sharing, presentation, chat, quizzes, whiteboard, exam mode, in-app archive browser yet.
* One file per submission (students zip multiple files). Group submissions are modelled (`mode: 'group'`) but rejected until groups exist.
* Mobile uploads restart from byte 0 on retry (still idempotent); desktop resumes from the server offset.
* Teacher app restart starts a new session; in-progress uploads from the old session are marked failed. Resources are per session (re-add files to a new class).
* Download progress shown to the teacher is self-reported by students.
* Strict Range handling: multi-range or malformed `Range` headers get 416 rather than a full 200.
* **Phones: implemented (2.6) but never run on a device.** The native Swift/Kotlin transport modules have not been compiled for iOS/Android on this machine; expect first-device fixes.
* Joining takes ~0.2–0.4 s of client CPU for OPAQUE key stretching (Argon2id); the teacher process holds ~75 MB of extra WASM memory after registering the class code.
* Replacing a laptop, reinstalling, or losing the OS keychain item creates a new device key: the teacher must approve it again. Likewise a new teacher computer/key triggers a warning for students.
* A changed LAN IP mid-class needs a class restart (new code, new certificate); students pair again.
* Classroom certificates last 24 h; a class running longer is ended automatically.
* Real-Wi-Fi measurements still pending; `lan-bench` measures raw LAN capacity in a browser (it cannot exercise the pinned TLS path).
* **Direct Network is UNVERIFIED on real hardware.** Implemented and exercised end-to-end only against the mock backend; the Windows
  helper builds but has never run on Windows. Hosting a Direct network is impossible through supported APIs on macOS.
* Direct: package identity may be required for `wiFiControl`/`bluetooth` (sparse-package path prepared, untested); per-session
  firewall rules need administrator rights (otherwise the installer's program + LocalSubnet rule applies).
* Direct: a full-tunnel VPN on host or member can break joining. CLAN detects VPN-like interfaces and warns; it does not change routes.
* Direct over BLE: BLE connection ids rotate, so the per-source guess limit is weak there; the CLAN-wide limit (50 failures/min)
  still applies to every attempt (tested), and throttling is counted and noted on the host timeline.
* Networks with client isolation cannot work in LAN Mode.
* Session tokens are in memory: restarting the student app means re-entering the code (an already-approved device is
  let back in without re-approval).
* If two classrooms on one LAN ever share a code (1-in-a-million per pair), the student joins whichever answers first.
* Mobile and Windows builds have not been executed on real devices/OS from this machine.
* Peer assistance does not add Wi-Fi capacity on a single access point (airtime is shared); it offloads the teacher machine.
  Real-Wi-Fi measurements are still pending (`lan-bench --mode classroom`).
* On loopback, peer-assisted distribution is slower than teacher-only (the teacher is effectively infinitely fast there); the
  win is teacher bytes (5–10 % of teacher-only for 10–100 MB files to 60–100 clients).
* Phones download from peers but don't seed. Peer discovery relies on the teacher's tracker plus a cache (no peer mDNS).
* While the teacher is offline, peer downloads continue only until capabilities expire (15 min) and only for resources whose
  manifest the student already had.
* Removed/blocked students keep files they already downloaded; a peer that missed the revocation push accepts them until the
  capability expires (≤ 15 min).
* Teacher handoff/delegation is designed, not implemented. Mesh is not implemented.
