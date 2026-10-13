# BTC-2R root-cause record

Baseline `7db61c7c9b8fe8e9bdff215c44c412dd380cc2e5`; branch `btc-2r-always-reachable`.

## Build identity first

Protected Desktop installer manifest records application `e73cd174f70716c8e914c8e8452030b7550f7f37` (BTC-1), version 0.1.0. BTC-2A–E deliberately did not replace these packages. Installed Mac `CFBundleShortVersionString` and ASAR package both report 0.1.0, internal QA; no embedded Git revision exists. Installed compiled `dist/main/main.js` SHA-256: `41c654735f1b53df4bc4709657913fe7b22d2d2ed6da7961e7a0d8d71f6c0ae2`. Delivery records associate it with BTC-1; version metadata alone cannot independently attest that exact application revision. Physical Windows is unavailable. The connected Redmi runs Android 13, QA version 0.1.0/versionCode 2. Its installed base APK SHA-256 exactly matches protected BTC-1 Android (`beecadf6bfd4fa023e7d6f4aaf4108d143229415fd08b55cc9508aa04a5da372`). Its foreground Keep service is active (notification 4401). No installed app/profile was changed. Thus it cannot validate current BTC-2R source; current-source acceptance uses the disposable emulator.

## Proven current-source defects repaired

- ConnectionManager retries only pending outbox/download recipients. An idle friend's authenticated link could disappear and stay disconnected until interaction/discovery. Availability-enabled runtimes now maintain known friends with stored authenticated routes, bounded to 100 candidates and four concurrent dials, queued work first, existing backoff/coalescing/key checks/blocking. Automatic idle redial is disabled under Invisible or disabled availability. No address scanning.
- Android network events woke delivery but did not restart NSD, clear discovery throttles/old hints or republish the listener. Native default-network callbacks now detect changed link addresses/routes as well as availability/loss. Existing native service pulses refresh discovery/advertisements, directory and transport, without requiring UI focus. Old NSD generations are discarded and resolve queue is bounded.
- People Bonjour browser ignored SRV/TXT updates and expiration. Refresh events and expiration now reach subscribers; new endpoint hints do not share an old endpoint's throttle. Desktop interface-change handling rebuilds browse sockets, clears hints and republishes; OS resume also wakes networking.

These are verified defects, not proven explanations of the user's Windows↔Mac or home-network Android observations. Those reports involve older installed packages and unobserved firewall/OEM conditions. No physical causal claim is made. Historical second-member approval intermittency remains separately tracked; do not increase its test timeout.

## Remaining hypotheses

Windows multicast interface/VPN choice, local-network permission, actual client isolation/firewall, old peer identity binding, stale older-package endpoints and Xiaomi battery termination require physical diagnostics. Windows installer permits program-scoped local-subnet inbound traffic; routed peers need explicitly approved scoped rules, not global firewall disable. No automatic firewall modification was added.

Follow-up source audit: concurrent mobile listener starts were not coalesced, and late listener completion could resurrect discovery after Stop. Startup is now coalesced and generation-fenced; two deterministic native-adapter lifecycle unit tests PASS. Stop clears the displayed listener port. Manual profile-code entry disables capitalization/autocorrection; the native driver now shell-quotes codes containing `&` rather than losing QR parameters. These follow-ups do not establish the original physical failure's cause.

## Native secure randomness failure

The current standalone Android QA app successfully dials the native TCP listener, but manual authenticated code connection fails visibly with `crypto.getRandomValues must be defined`. Hermes lacks Web Crypto; noble direct-link key generation and nonce generation depend on it. The application entry now initializes the missing random-source method using existing Expo native `getRandomValues` (OS CSPRNG), preserving any existing platform implementation and failing closed on native errors. No identity is regenerated. A regression removes global Web Crypto, initializes the adapter, and completes mutually authenticated encrypted direct-link exchange; existing crypto preservation and failure propagation are tested. Native acceptance remains required. This explains the observed current emulator direct-link failure, not the unobserved physical Windows issue.

## Native background stale-session recovery

Actual Android emulator acceptance passed foreground, UI-closed, locked-screen receipts and signed invitation notifications, but a queued receipt after airplane-mode recovery exceeded the unchanged 45-second gate. The direct-link health/request deadlines relied solely on JS timers; the native service pulse only flushed connections still marked open. A silent old socket could therefore suppress a new authenticated dial. Native pulses now run the same wall-clock health/request deadlines, unanswered requests close the link while retaining its outbox, and actual native interface changes invalidate old sessions before redial. Ordinary UI resume does not invalidate healthy sessions. Real TCP regressions cover session replacement, one delivery, retained outbox, and timer-independent deadline enforcement. Native recovery acceptance is tracked separately, not inferred from these tests.

## Windows CI follow-up

Current-source CI `38409946492` narrowed the meeting join failure: no authenticated pending screen, one join error, a discovery/reachability error, and no host approval button. Thus this occurrence is before approval propagation, not an approval UI delay. `multicast-dns` browses all memberships but sends Windows queries via the OS default interface (`0.0.0.0`), while advertising selects the host interface explicitly. Browsing now explicitly queries bounded candidate LAN interfaces and merges/retains their independent hints. A real late-browser multicast regression and deterministic multiple-interface lifecycle/merge tests pass on Mac. Windows CI must verify the repair; the physical report remains unproven.

Windows also recorded an uncaught Node `Readable.toWeb` cancelled-controller enqueue during the actual interrupted-upload regression. Node upload bodies now use Undici's documented async iterable support directly, with explicit source destruction on success/error/cancellation. Existing interrupted-upload, resume, idempotency, integrity and authorization assertions remain unchanged. The Windows crash-recovery fixture's earlier modal/handle failures no longer occur in this CI run; recovery passed without changing production recovery logic.

## Authority-check telemetry and permission UI

Source inspection proves that `StudentFiles` progress passed through a `send` callback that silently dropped it whenever SessionGate was revalidating host authority. A locally completed file could therefore leave the host's summary incomplete. The gate now offers bounded, coalesced, session-local deferred telemetry; desktop uses it only for `transfer.state`. Stop/stale authority discard it. Every live media/input action retains its immediate verified-authority requirement. File-sharing controls pause during authority checks without unmounting an ongoing meeting. Deterministic tests cover coalescing, stale host, stop and resource caps; actual Mac file/join/meeting fixtures pass. This proves the telemetry gap, not yet the exact cause of the intermittent Windows permission UI failure.

Windows diagnostic CI 38441379549: recovery relaunch process remains alive but its main thread cannot answer a bounded diagnostic evaluation. Therefore lock ownership/window count are unknown; do not falsely attribute this to a lock. A synchronous fatal startup dialog or blocking startup operation remains a hypothesis. Disposable-only recovery loader now logs sanitized fatal startup/bootstrap errors and lets the real startup failure quit; all recovery/data assertions remain required. The same run's sharing test passed; a four-publisher SFU teardown state timeout failed independently. Physical Windows cooperation remains unavailable.

## Confirmed locked-database misclassification

A disposable actual SQLite exclusive lock returns ERR_SQLITE_ERROR/errcode 5. The existing integrity helper catches every error as corruption; on Mac, openDbSafely then renamed the locked database and opened a fresh database without its original proof table. This is a reproduced data-safety defect, independent of the unproven Windows startup cause. Recovery must distinguish confirmed corruption (SQLite base codes 11/26 or failed quick_check) from lock, permission and I/O errors; uncertain failures must leave the database and backups untouched.

## E2E cleanup ownership failure

Overlapping a targeted Mac data fixture with the full Mac regression caused the target's global cleanup to terminate the full run's People apps. Cleanup previously checked only executable/project cwd, so distinct active runners were indistinguishable. Two People tests failed with Target page/context/browser closed during that cleanup. This is a fixture ownership defect and an avoidable execution mistake, not a People delivery result. Cleanup now requires live process ancestry under its own runner as well as the existing executable/cwd checks; uncertain reparented processes are retained. Two adversarial ownership tests pass. Full suites run serially; the failed 43 PASS/2 FAIL/2 existing skips remains recorded. Installed CLAN TEST was not matched or changed.

## Windows recovery cause narrowed to OS-protected key decryption

546bfba/8d995d1 CI diagnostic logs prove recovery startup quits because Keystore cannot decrypt an existing identity ciphertext; firstWindow was a symptom. The fail-closed behavior preserves the original key and is retained. Earlier successful 335549f recovery does not resolve this intermittent defect.

Pinned [Electron 44.5.1 safeStorage](https://github.com/electron/electron/blob/v44.5.1/shell/browser/api/electron_api_safe_storage.cc) uses synchronous OSCrypt; [browser process](https://github.com/electron/electron/blob/v44.5.1/shell/browser/browser_process_impl.cc) stores Windows DPAPI wrapping metadata in sessionData/Local State and commits pending preference writes at shutdown. An abrupt first-run crash before metadata reaches disk can strand identity ciphertext. This durability mechanism fits the failure; raw ciphertext/root keys are never logged, replaced or regenerated.

Keystore now waits at most 15 seconds for the DPAPI-wrapped metadata to exist and fsyncs its existing file before allowing new identity writes. Missing/malformed/unflushable metadata fails closed. Existing unreadable identities still fail unchanged. Newly created ciphertext is exclusively created and fsynced, avoiding overwrites. Mac/Linux retain their existing OS storage. Windows native crash acceptance must prove this candidate repair; it is not inferred from mocks. The CI job budget becomes 45 minutes for first-profile persistence waits; all join/window/assertion deadlines are unchanged.

The durability guard passed the early real Windows abrupt-crash/recovery fixture in CI 38455975750 at 3eab423. Complete suite repeat remains required; existing identities that already lost their wrapping metadata cannot be recovered by this guard. It prevents new first-run ciphertext being committed ahead of OS metadata; restoring an already-unreadable identity requires matching OS storage/secure backup. No data reset, identity rotation or encryption fallback is performed.

Final 3eab423 Windows native crash/recovery passed twice in CI 38455975750 (early fixture and independent complete-suite repeat); full Electron 45 PASS/2 existing PERF skips. The protected-key durability guard is validated for those real Windows fixtures. The actual earlier decryption failure is proven, while physical network/OEM causes and any already-lost wrapping metadata remain separate limitations.
