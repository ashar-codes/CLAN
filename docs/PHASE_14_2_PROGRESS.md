# Phase 14.2 progress

Branch `phase-14.2` in worktree `/Users/ashar/clan-astra-phase12` (from `clan-astra-phase12` @ `1994793`, which is
tag `clan-beta-v0.1.0-rc1` + one docs commit). Status values: PASS (executed), FAIL, NOT TESTED, NOT STARTED.

| # | Item | State | Commit | Evidence |
|---|---|---|---|---|
| P0-1 | Windows-hosted CLAN: Mac/Android discover but can't connect | **Fixed in source, NOT TESTED on Windows** | `fd8249c`, `a833dd1` | `packages/server/test/multi-address.test.ts` (3 PASS); join/discovery/security/mobile/integration suites 138 PASS; typecheck PASS |
| P0-2 | Chat scrolling/pagination/jump-to-latest (desktop + mobile) | IMPLEMENTED; desktop + Android emulator PASS | see git log | 4 desktop E2Es + 17 targeted unit tests + full emulator cross-device run PASS; physical Android NOT TESTED |
| P0-3 | Classroom student file-sharing policies (everyone / approval / teacher only) | IMPLEMENTED; host + desktop PASS, native UI pending | see git log | 70 targeted units + 5 desktop chat/sharing E2Es PASS |
| P0-4 | File preview / open / save-export (SAF, iOS Files) | IMPLEMENTED; desktop + Android emulator PASS; Windows/iOS native NOT TESTED | `7d16b04` | 6 desktop E2Es + 3 preview security units PASS; native Android passive preview, SAF export hash and viewer chooser PASS |
| P0-5 | CLAN archive / remove from device / leave / delete | IMPLEMENTED; desktop PASS; native cleanup completion pending | see git log | Core/security units, desktop removal/delete E2Es PASS; native archive/leave PASS; cleanup confirmation defect fixed, rerun interrupted by low storage |
| P1-6 | In-app join alerts + Raise Hand | IMPLEMENTED; server + desktop PASS; native execution pending | see git log | 3 security/transport tests + desktop E2E PASS; native script prepared, blocked by storage |
| P1-7 | Persistent mobile CLANs: signed hosting authority / fencing layer | IMPLEMENTED (domain only, not wired/exposed) | see git log | 6 deterministic authority tests + 131 clan units PASS (Linux cloud); replication/checkpoint, host gating, UI NOT STARTED |
| P1-8…10 | Android hosting, iOS parity, installers | DESIGN/PREFLIGHT; implementation incomplete | see git log | Hosting design/runtime investigation; iOS prebuild/Pods PASS, compile pending storage; no candidates |

## P0-1 root cause and fix
Two independent source defects, both consistent with "Windows host is discovered but nobody can connect" and
neither visible on a Mac host:
1. **Clients used the first advertised address.** mDNS (bonjour-service) publishes A records for *all* the host's
   IPv4 addresses; `packages/server/src/discovery.ts` (desktop) and `apps/mobile/src/discovery.ts` (phone) took the
   first. On Windows that is often a WSL/Hyper-V/VMware/hotspot adapter. Fix: hosts add TXT `a` = bound address;
   browsers keep all usable IPv4 addresses (`lanUrls`, preferred first) and `lanCarrier` (`packages/client/src/pairing.ts`)
   probes `GET /api/info` on all, pairing once with the first that reports the expected session. OPAQUE + pinned
   TLS still decide authenticity; older (RC1) hosts without TXT `a` also benefit.
2. **The Windows host could bind a virtual adapter.** `candidateInterfaces()` only filtered Unix adapter names;
   Windows names (VMware, VirtualBox, `Local Area Connection*` hotspot, Bluetooth, Hyper-V, Teredo…) passed with the
   same score as the real adapter. Fix: Windows patterns excluded, `Ethernet`/`Wi-Fi` preferred. Direct Mode unaffected
   (binds the helper-provided address).

Not yet ruled out on real hardware: Windows Defender Firewall when running `pnpm dev` (no installer rules: Windows
asks once per program — "Allow" on Private networks is required; a dismissed prompt blocks inbound), and Wi-Fi
profile set to *Public*. See the retest procedure in `docs/CODEX_HANDOFF_PHASE_14_2.md`.

## Codex continuation (2026-10-11)

Preflight confirmed clean isolated worktree on `phase-14.2` at `4a7dcaa`; original staged checkout, release tags,
signing material and application profiles preserved. Reviewed both Windows fixes. `phase-14.2` is on GitHub;
`40fa357` adds [the exact native Windows retest](WINDOWS_RETEST_PHASE_14_2.md). Physical Windows connectivity is
**NOT TESTED** pending Windows Codex feedback.

Baseline: typecheck PASS; complete serial unit suite **327/327 PASS**, 36 files, 242.46 s.
Desktop E2E **22/22 active PASS**, two opt-in performance cases skipped, 269.50 s. The first unit invocation was interrupted after command-line arguments were incorrectly
placed after `--` and Vitest started parallel workers; the corrected full serial run above passed.
Logs: `/tmp/clan-142-typecheck.log`, `/tmp/clan-142-unit-baseline-serial.log`, `/tmp/clan-142-e2e-baseline.log`.
No timeouts were increased. The [P1 hosting design](PHASE_14_2_HOSTING_DESIGN.md) defines authorization, durable
relinquishment, replication and fencing gates before implementation.

## P0-2 chat implementation

Desktop chat has a bounded internal scroll area, reader-position preservation when older pages load, and Jump to
latest. Mobile uses a full-screen keyboard-aware modal with an inverted FlatList, older-page loading, explicit
Retry/Discard for failed sends, and durable idempotent retries. Read receipts require a visible conversation and an
active app. Shared catch-up walks all 200-message pages and reloads edits/removals at their original sequence.
No chat domain, whiteboard protocol or permission checks were replaced.

PASS: typecheck; 17 targeted unit cases (4 history/catch-up and 13 existing secure-host chat cases);
final desktop chat E2E **4/4 PASS** (41.97 s), including widths 1440/1024/390/360, pagination and live arrivals while
reading. An earlier E2E revealed a genuine 26px scroll shift caused by anchoring a day separator; anchoring the
message article fixed it. Logs `/tmp/clan-142-chat-unit-final.log`, `/tmp/clan-142-chat-typecheck4.log`,
`/tmp/clan-142-chat-e2e-final.log`.

Android release APK built with the existing signing identity, installed on a fresh dedicated `clan_phase142` AVD
(no original emulator/user profile reused). First cross-device run passed personal sync/conflicts/revocation and
secure joining, then failed to open chat. The harness incorrectly searched for absent OS prompt buttons while
scrolling and accepted the room preview as chat evidence. A focused native check opened the modal successfully.
The harness now handles only a visible OS prompt and verifies Close chat; a full rerun is in progress. No timeout
was increased. Emulator results do not establish physical Android performance or connectivity.

## P0-3 classroom student file sharing

Classroom defaults to teacher-only. The host may select Everyone or Teacher approval; permission changes reach
connected students immediately. Other CLAN types retain their existing defaults. Approval uploads are checksum-verified
and quarantined in host temporary storage without a resource/manifest/download until approved. The host sees a bounded
queue and may approve/decline; duplicate approval returns the same resource. Authorization is checked at initiation,
resume, final upload, and immediately before resource publication, including removal during asynchronous copying.
Pending clients return an explicit approval result rather than endlessly uploading a completed file.

Database migration 8 appends the session policy and upload approval columns. Existing upload states, IDs, byte/hash
validation and authenticated transport remain unchanged. This is a live-session policy; new sessions default to the
safer teacher-only rule. Pending review is scoped to its originating session and remains stored if that session ends.
Cross-host transfer of such queues belongs to the separately gated durable hosting design.

PASS: typecheck; **70/70** targeted sharing/chat/security/data-safety unit tests (32.12 s);
**5/5 desktop chat/sharing E2Es** (51.96 s). Tests cover real HTTP credentials, WSS privilege denial, cross-session review,
checksum failure, duplicate approval, policy change and removal during copying, plus live controls/table visibility.
Logs `/tmp/clan-142-sharing-typecheck2.log`, `/tmp/clan-142-sharing-unit2.log`, `/tmp/clan-142-sharing-e2e1.log`.
Native UI changes still require an updated APK and emulator verification. Physical devices remain NOT TESTED.

### Native chat observation fixes

Two full emulator runs failed at the chat interaction, not at secure joining or personal sync. Evidence identified
an asynchronous Android notification prompt intercepting the tap and the harness's Escape key closing the new native
modal (ReactModalHostView explicitly treats KEYCODE_ESCAPE as a modal-close request). The harness now observes the
actual prompt/window, verifies Close chat, sends with the keyboard open and uses Android Back to hide the IME.
The simulated host now records its own local chat-reader handle, matching desktop setup; otherwise `/state` falsely
reported an empty local projection even for persisted messages. Host persistence is now an explicit assertion.
A focused emulator run has passed both-way chat, host persistence, older-page access, retained reading position and
Jump to latest (`/tmp/clan-142-chat-native-focused3.log`). Whiteboard/file checks and an updated-APK full rerun are still
pending; no timeout increases and no physical-device claims.

## P0-4 file actions

Desktop and mobile share passive preview policy (256 KiB text, 8 MiB PNG/JPEG, validated headers and dimensions).
Unknown/active-content types show metadata; every file can be saved. All actions recheck the recorded SHA-256.
Desktop supports host/member table and chat files, exclusive Save Copy with post-copy verification, macOS application
selection and Windows SHOpenWithDialog (Windows runtime NOT TESTED). Android adds a small sandbox-restricted native
bridge for FileProvider viewer grants and streaming SAF export with independent destination size/hash verification.
iOS uses the existing system sharing interface; native build and Files behavior remain NOT TESTED.

PASS: typecheck (`/tmp/clan-142-preview-typecheck4.log`); 3 preview security units
(`/tmp/clan-142-preview-unit1.log`); 6 desktop chat/sharing/preview E2Es, 56.53 s
(`/tmp/clan-142-preview-e2e1.log`). The strengthened preview/export case passed a focused rerun, 8.56 s
(`/tmp/clan-142-preview-e2e-final.log`; five other cases intentionally unselected).
Signed Android release build passed; the latest source was rebuilt successfully with existing signing identity
(`/tmp/clan-142-preview-android-build3.log`, Gradle quiet mode), installed on `clan_phase142` only.
Full native cross-device and SAF/viewer runtime verification are in progress. See [file actions](FILE_ACTIONS_PHASE_14_2.md).

### Updated-APK full emulator cross-device result

PASS: `python3 -u apps/mobile/e2e/android_cross_device.py`, one complete successful updated-APK run
(`/tmp/clan-142-preview-android-cross-device.log`, exit 0, approximately nine minutes). Real native app/emulated Android
and real Mac test peers covered personal sync, offline conflicts/Keep both, revocation, private share inbox, OPAQUE +
pinned TLS join, both-way persisted chat, older pages/reader position/Jump latest, whiteboard both ways and verified
1.5 MB download. No increased timeouts. Load was approximately 16 at start and 38 at finish; this is not physical-device
performance evidence. A subsequent focused export driver initially started before peer teardown finished and failed
its preflight with EADDRINUSE; it was rerun after the full suite exited. That failed preflight is not a product PASS.
Focused native Android file-action checks then passed: literal HTML markup displayed as plain text with no WebView;
system folder selection/grant scoped to the disposable `Documents/CLAN_Phase142_Test` folder; streamed SAF copy and
app destination hash verification; independent adb readback SHA-256 equal to the original host file; native viewer
chooser offered installed viewers and Back returned safely to CLAN. This was emulator UI inspection/automation,
not physical testing. The temporary driver `/tmp/clan-142-native-export.py` uses the production API and native UI;
it does not stub the picker or native bridge. iOS prerequisite recheck confirms Command Line Tools only, no Xcode.app;
the user has agreed to install Xcode and complete first launch. Windows chooser execution remains NOT TESTED.

## P0-5 local archive/restore increment

`clans` migration 2 appends a local-user archive preference, leaving canonical archive/expiry unchanged. Desktop
Archive requires confirmation; Archived CLANs remain readable and Restore returns them to My CLANs. Mobile Home has
matching archive confirmation/restore controls (native verification pending). Membership and all permission, linked
course, assignment and host-identity lookups retain archived CLANs. Core local leave rejects owners and preserves
personal data; it is not exposed as a complete live leave until remote token/peer revocation is coordinated.
Remove-copy, owner deletion and their cleanup/tombstone controls remain unfinished, not substitutes for archive.

PASS: typecheck `/tmp/clan-142-lifecycle-typecheck1.log`; **26/26 targeted units** including four new lifecycle cases
(`/tmp/clan-142-lifecycle-unit2.log`, 2.87 s); desktop archive/cancel/restart/read/restore E2E **1/1 PASS**
(`/tmp/clan-142-lifecycle-e2e2.log`, 7.40 s). First unit run caught a missing SQL conjunction in the new archive query
(two failures); fixed before rerun. First E2E used unsupported Playwright matchers with Vitest (automation failure);
replaced with this repository's existing polling assertions, without changing timeouts. See lifecycle boundary doc.

### P0-5 member leave increment

Authenticated `/api/member/leave` revokes only the caller through existing removal checks, including tokens,
WSS, peers and media. Strict CLAN match and body validation prevent targeted removal of another member. New desktop/
mobile Leave membership confirmations are separate from session disconnect. Local membership becomes left;
only this session's downloads/peer activity stop. Desktop discards scoped reconnect routes, retains receipt anchors
and signing identities, and checks left membership before reconnect. Existing paired records remain readable;
new records optionally retain canonical CLAN ID. Five-second UI wait is for offline responsiveness, not an increase
to test deadlines: failed/delayed acknowledgement reports remote revocation unconfirmed. Offline leave warns explicitly.

PASS: typecheck (`/tmp/clan-142-leave-typecheck3.log`); final **50/50** security/lifecycle units, 23.13 s
(`/tmp/clan-142-leave-unit-final.log`); desktop live/offline leave, retained private notes, restart and approval on
rejoin **1/1 PASS**, 11.98 s (`/tmp/clan-142-leave-e2e2.log`; earlier live case also passed, 20.31 s).
Android signed build/install passed with the existing identity; native `android_lifecycle.py` **PASS**, exit 0,
covering archive confirmation/restore after restart, host revocation on membership leave, retained personal note,
restart and OPAQUE rejoin under host approval. Log `/tmp/clan-142-native-lifecycle.log`, approximately five minutes;
load approximately 26–29. Dedicated emulator only. A preceding focused archive observation failed on Android's
uppercase ARCHIVE label; corrected label check then passed, with no timeout increase. Physical Android remains
NOT TESTED. No project-owned test peers remained after teardown.

Remaining P0-5 work: remove local copies and owner deletion with durable markers, scoped cleanup and last-copy
warnings. Shared blob references must protect personal files and other CLANs. Neither destructive control is exposed yet.

### P0-5 cleanup foundation (software only)

Durable remove/delete intents now fence authority and restart imports; pending cleanup cannot be cleared by joining.
Scoped module cleanup retains private data, other CLAN shares and stable file references in personal/archived Courses.
Candidate object IDs are journaled for retries. Exact managed-orphan collection protects referenced and in-flight bytes
and resumes unlink-before-metadata crashes. Adopted server files/download cleanup and destructive UI remain pending;
this increment does not claim completed erasure. File publication now rechecks membership after storage (add/ingest
regressions pass). Targeted **51/51** units including module boundaries PASS, 3.92 s
(`/tmp/clan-142-cleanup-unit4.log`); typecheck PASS (`/tmp/clan-142-cleanup-typecheck5.log`).
Earlier targeted run failed because the new test called the personal board creation API for a CLAN board; corrected
to the existing host API, no production permission bypass. Xcode 26.6 now exists/selected; native SDK commands report
unaccepted license. User has been asked to complete Xcode's license/first-launch setup. Windows feedback is still setup
only; branch pushed through `385c623`, native Windows PASS remains unverified.

### Stopped-host and download cleanup preparation

Server-owned scoped cleanup now refuses live/invalid session scopes, validates all UUID paths, preserves adopted bytes
through the Resource Store before erasure, and deletes server history in foreign-key order. Changed adopted bytes fail
closed with cleanup pending. Canonical tombstones/private courses remain. `clans` migration 4 records authenticated
member-side session ownership independently of expiring transport receipts. Rehosting now checks active ownership.
Desktop downloads journal exact session/resource ownership before transfers, serialize atomic index updates, stop/wait
only scoped jobs, and remove verified indexed copies/owned partials; changed files, shared paths, symlinks and external
exports are retained. Legacy partials without ownership evidence must be retained, not guessed by class title.

PASS: typecheck (`/tmp/clan-142-download-cleanup-typecheck-final.log`); **33/33** targeted core/server/download units,
4.91 s (`/tmp/clan-142-download-cleanup-unit2.log`); **8/8** desktop chat/preview/archive/leave regressions, 70.56 s
(`/tmp/clan-142-cleanup-desktop-regression.log`). Initial download cleanup check used the wrong return shape for the
existing hash helper (string, not object); typecheck/test exposed it, corrected without timeout changes.
Destructive cleanup coordinator/desktop and mobile controls remain pending; these helpers are not a completed removal
feature. Final full suites, native cleanup controls and packaging remain pending. Machine load at gate finish ~36/46/37;
no physical-device performance claim. Xcode license/SDK check now PASS (26.6, iOS SDK 26.5); no simulator runtime/device
installed. CocoaPods setup and an isolated unsigned native compile script are being prepared; no IPA exists yet.

### Desktop removal/delete controls

Desktop confirmation and retry UI now coordinates scoped cleanup. End the local live session first; private data and
other hosts remain intact. Owner deletion keeps a durable tombstone/last-copy warning; member removal clears local
membership/routes. Modified/shared/external downloads are retained and counted. Unknown legacy ownership is retained,
explicitly described in confirmation. Failures stay unavailable under Cleanup pending until successful retry.
PASS: typecheck (`/tmp/clan-142-cleanup-controls-typecheck2.log`); owner actual Electron E2E **1/1**, 5.87 s
(`/tmp/clan-142-cleanup-controls-e2e1.log`), including changed-byte failure/retry, source/private retention, restart and
host-authority fencing; secure member join/removal **1/1**, 7.31 s (`/tmp/clan-142-remove-controls-e2e1.log`), including
owner-action refusal, cancellation, restart/cache/reconnect cleanup and intact remote host. Mobile remains pending.
Xcode/CocoaPods 1.17.0 prerequisites PASS; isolated iOS prebuild/codegen succeeded and pod installation is downloading
native dependencies (`/tmp/clan-142-ios-build1.log`), not yet compile PASS. Dedicated `clan.phase142.emu` launchd job
stopped to release its 3 GB while iOS builds; emulator/profile files retained. Branch pushed through `a2840ed`.

### iOS first native build attempt

User completed Xcode first launch; license and SDK queries PASS. CocoaPods 1.17.0 installed. Isolated native build
script now completes Expo prebuild/codegen and pod installation, but native compile **FAIL/BLOCKED**: Xcode has no
eligible iOS destination, reporting missing iOS 26.5 platform support. `-showdestinations` confirms the block.
Logs: `/tmp/clan-142-ios-build1.log`, `/tmp/clan-142-ios-destinations.log`. No IPA/.app, simulator or physical iOS PASS.
User platform-component installation request remains pending. Free disk space about 9 GB; no personal data or signing
material deleted. Android disposable emulator can be restarted independently. See BUILDING.md for exact rerun.

### Mobile cleanup and stored copies after leave

Implemented native confirmation/retry/scoped download and Outbox cleanup, plus desktop/mobile stored-copy controls
after leaving. Delayed chat writes cannot resurrect pending/removed caches. Private and other-session references stay;
corrupt indexes fail closed; synchronous moves precede reported download completion. Typecheck PASS, **27/27** target
units (15.40 s, `/tmp/clan-142-mobile-cleanup-unit2.log`), updated desktop cleanup E2Es **2/2** (18.86 s,
`/tmp/clan-142-stored-copy-e2e.log`). Contract mock initially normalized file URIs incorrectly; corrected adapter, no
production permission bypass. Native build/install PASS. Initial native cleanup **FAIL** exposed an empty-card return
hiding successful completion. Source fixed; rerun **INTERRUPTED** exit130 due <1GB disk, after archive/restart/restore,
authenticated leave and private retention PASS. Final native completion/rejoin remains NOT TESTED; no timeout increase.
Logs `/tmp/clan-142-native-cleanup.log`, `/tmp/clan-142-native-cleanup2.log`. Verified project-owned Python test/peer
and launchd emulator job stopped; profile preserved. Other processes/data/signing keys untouched.

Xcode now lists iOS26.5 generic destinations and iPhone17 simulator; earlier component block resolved
(`/tmp/clan-142-ios-destinations2.log`). Native compile rerun and further heavy software/native gates are blocked by
storage (790MiB free at stop). User asked to free >=15GB; do not delete user data/signing material. No IPA or iOS PASS.
Machine load during checks ~23–33; available tests ran sequentially, and software gates remain distinguishable from
physical hardware evidence. Final complete suites/reliability/install-update/candidate packaging remain pending.

### Session attention and native sharing verification preparation

Added caller-scoped strict Raise Hand messages, host-only acknowledgment, idempotence, one-second transition limit,
and session cleanup on removal/final socket close/end. Host-only queue; other members receive only their own state.
Controls wait for advertised host support; no new presenting/sharing/hosting rights. Desktop in-app join/hand alerts use
generic deduplicated status text. Background host OS notifications are not implemented. Whiteboard protocol unchanged.
PASS: 3 dedicated security/pinned-WSS tests (in **22/22** scoped run, 2.57 s, `/tmp/clan-142-hands-cleanup-unit.log`),
1 real Electron E2E, 10.02 s (`/tmp/clan-142-hands-desktop-e2e.log`), final typecheck
(`/tmp/clan-142-hands-cleanup-typecheck-final.log`). Final Outbox/filesystem mock contracts **5/5**, 343ms,
`/tmp/clan-142-cleanup-contract-final.log`. Current source also reports storage failures without clearing typed drafts.

Prepared `android_attention_sharing.py` for actual native Raise Hand and Classroom teacher-only/approval transitions,
OS picker upload, quarantine, host approval and verified SHA. **NOT RUN**: storage gate. The existing loopback-only
class-peer controller adds hands/policy/review visibility through actual authorized host APIs, not permission bypasses.
Latest source differs from installed test APK by final storage-error handling; rebuild before final native verification.
Node mobile published runtime is 18.20.4; open Node24/SQLite PRs are possible candidates but not audited/installed.
See hosting design for primary source URLs and required safety/build evidence. Persistent delegation/native hosting remain
unfinished; do not report durable availability, final software gates or Phase14.2 completion. No installer distribution.

## Cloud continuation (Linux container, 2026-10-11)

Resumed at checkpoint `4b12b2f` (tip of `phase-14.2`, no later commits) on cloud branch `claude/laughing-clarke-yql2cy`.
Environment: Linux x64, Node 24.21.0 (official tarball, SHA-256 verified), pnpm 11.20.0, `pnpm install --frozen-lockfile`
with `ELECTRON_SKIP_BINARY_DOWNLOAD=1`. No Android SDK/emulator, Windows, Xcode or physical devices: none of those
gates can be run or claimed from this environment. No signing material accessed.

WIP checkpoint `4b12b2f` (test temp-dir registration in `packages/clan/test/helpers.ts`; SIGINT/SIGTERM cleanup in
`tools/sim/class-peer.ts` and `tools/sim/sync-peer.ts`): typecheck PASS and the clan suite uses the shared teardown
registry. The sim-peer signal handlers are typechecked only; they are exercised by the Mac/Android harnesses, NOT RUN here.

Baseline full serial unit run (`vitest run --no-file-parallelism`): **351 PASS, 14 skipped, 1 FAIL** (44 files). The
failure was genuine and pre-existing since `bd8f545`: the architecture test forbids security code branching on the
`CLASSROOM` type name. Fixed by `hasMemberFilePolicy()` beside the capability table (behaviour unchanged; 98 sharing/
security/mobile units + `clan.test.ts` 16 PASS). Note: that baseline run overlapped with new hosting files being written;
the final full run below is the authoritative result.

P1-7 authority layer: see [hosting design › Authority layer implementation](PHASE_14_2_HOSTING_DESIGN.md). Not wired
to host write paths, pairing or UI; nothing advertises durable handoff.

Final cloud gate on this branch: typecheck PASS; full serial unit **358 PASS / 14 skipped / 0 FAIL**, 42 files passed +
3 skipped, 277.82 s. Skips are environment gates (no usable LAN interface for mDNS discovery, no local SFU binary for
screen sharing), not passes. Desktop Electron E2E (`pnpm test:e2e`) and all Android/iOS/Windows suites NOT RUN here.

### P1-7 checkpoint B: CLAN checkpoints and self-verifying staging (cloud)

Frozen hosts build one durable, content-addressed checkpoint per epoch (`prepareCheckpoint`): each registered
section is canonical JSON stored as a SHA-256 blob, every file is re-hashed at the source, and the header (sections +
file list) hash is what the destination acknowledges; `relinquish` now refuses an acknowledgment of any other
checkpoint, and `unfreeze` discards it. Sections: `clans` (canonical record + session links), `chat` (threads,
messages, reactions, read positions, names; never this device's handle/Outbox), `whiteboard` (CLAN boards, op log,
snapshots), `files` (CLAN file refs + bytes) and `server` (ended sessions without join codes/host keys, members with
status but never tokens, trusted devices of the CLAN scope, resource metadata + bytes without old signed manifests).
Not carried: presence/events/transfers, assignments/submissions, pending share reviews (stay on the previous host).
Destinations must be the owner's own devices (owner or linked-device anchor). `completeStaging` verifies everything
itself: blob sizes/hashes (corrupt blobs deleted for re-download), canonical section bytes and row counts, exactly
the registered sections, strict per-table column/scope validation, and file list equality. Activation re-verifies,
materializes bytes, then imports all sections inside the transaction that records the new epoch (a failed import
leaves the device standby). PASS: typecheck; `packages/clan/test` 134/134 incl. 9 hosting cases (Linux).

### P1-7 checkpoint C: resumable hand-over transport (cloud)

The personal-sync HTTPS server (pinned per-device certificate, every request signed by a linked unrevoked device key)
gains `/host/offer`, `/host/blob/:clan/:sha` (byte ranges) and `/host/relinquish`, enabled only when a
`ReplicationHost` is supplied. `HostAuthority.replicationSource` re-checks the owner's delegation to the caller's key
on every call, serves blobs only of the prepared checkpoint and only to the device it was offered to, and re-delivers
only a transition already signed for that caller. `replicateClan` (`@classroom/client/sync`) runs the destination:
offer → anchor/record CLAN (caller) → stage → ranged resumable download (`.part`) → self-verification (one retry of a
corrupt blob) → acknowledge → transition → activation; re-running after any interruption resumes. PASS: real-HTTPS
hand-over test (unprepared refusal, wrong-device delegation, unoffered blob 404, crash during verification, mid-file
resume, single writer, replay after success); `packages/clan/test` + `server/test/clan.test.ts` 151/151 (Linux).

### P1-7 checkpoint D: host-epoch fencing and owner-key anchoring at pairing (cloud)

`startClassroomServer({ authority })`: the session refuses to start unless this device holds the CLAN's current
epoch; every non-GET HTTPS/bootstrap request (pairing, join, reconnect, uploads, shares, reviews, leave, peer reports)
and every WebSocket message except ephemeral relays (`wb.sync`, `wb.cursor`, `chat.typing`) and liveness re-checks
it and fails with `503 host_unavailable` / `error host_unavailable`. Reads continue. Legacy CLANs (no authority record)
are unchanged. The owner-signed genesis is sent only in `hello` inside the authenticated session; desktop
(`clan:joined`) and phone (`recordJoined`) anchor it (first binding wins; a different owner is refused). Desktop wiring:
hosted sessions pass `authority` when a chain exists; the device-link server serves hand-overs with the sync device key
as hosting key; the host-server checkpoint section is registered. No hand-over UI yet. PASS: typecheck;
`server/test/hosting-fence.test.ts` 3/3; all server suites + hosting suites 202 PASS / 13 environment skips (Linux).
