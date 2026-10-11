# Phase 14.2 persistent hosting — hardware test instructions

The cloud session verified software only (Linux container: unit, integration and two-instance Electron E2E). Nothing
here has run on Mac, Windows, a physical Android phone or iOS. Record every result (PASS/FAIL, build commit, device,
OS version, network) in `design/hardware/` and never mark a step PASS that was not executed.

## 0. Preparation (all machines)
- Check out the branch under test (`claude/laughing-clarke-yql2cy`, or `phase-14.2` after merge) and note `git rev-parse HEAD`.
- `pnpm install --frozen-lockfile && pnpm typecheck && pnpm test` on the Mac first (must be green).
- Use **disposable profiles**: `CLASSROOM_USER_DATA=/path/to/fresh/dir pnpm dev` (Mac/Windows). Do not use the real
  application profiles or signing keys. One Wi-Fi network, profile **Private** on Windows (`Get-NetConnectionProfile`);
  answer the Windows Defender Firewall prompt with **Allow — Private networks** on first start.
- Android: build a test APK from the same commit (`NO_INSTALL=1 apps/mobile/scripts/android-dev.sh --prebuild --release`)
  with the existing upload key (do not create or replace keys). Install on a test phone/disposable emulator only.

## 1. Link the owner's devices
1. Mac A: Me › My Devices › Link a device (shows a code). Windows B: My Devices › Join with code. Approve on A.
2. Android phone P: Me › My Devices › link to Mac A with A's code.
Expected: each lists the others; personal sync works as before (regression).

## 2. Phone-owned CLAN hosted by a computer (Android → Mac)
1. P: Me › Hosting › New CLAN hosted on your computer: name "HW phone group", host computer = Mac A › Create… ›
   Create and hand over. Expected: progress, then "Mac A now hosts …". P states phones do not host.
2. Mac A: CLANs › HW phone group › Hosting: "This computer hosts this CLAN." Host again → a member (Windows B or a second
   phone) joins with the code. Member desktop must show **no** host warning.
3. Interrupt test: create a second CLAN on P and turn Mac A's Wi-Fi off right after tapping Create and hand over
   (a new phone CLAN is small; large-transfer resumption is tested in section 3). Expected: an error saying nothing was lost;
   P's card says "Paused here for a hand-over — finish it below". Turn Wi-Fi on; tap "Finish hand-over to Mac A".
   Expected: completes; Mac A hosts. Record transfer resumption (no restart from zero for large data).

## 3. Move hosting between computers (Mac → Windows) with real data
1. Mac A hosts "HW group" with: chat messages, a whiteboard drawing, a 200 MB file on the table, a Classroom assignment
   with one student submission (use a CLASSROOM CLAN for this part), and one student share waiting for approval
   (file policy "Teacher approval").
2. End the live session on A. Owner device (P or A): request move to Windows B ("Move hosting to…" / "Move to B").
3. A: Hosting panel shows the request. Check blocking items (none expected) and any "I understand" acknowledgments.
   Hand over to B… › Pause and hand over. Watch progress. Pull B's network cable mid-transfer once; retry on A.
4. Expected on B: "This computer now hosts this CLAN"; chat, board, file (open it, SHA verified), assignment and the
   submission file, the pending share (approve it on B after hosting again) are all present. A shows "Hosted by B".
5. On A press Host again: refused ("handed hosting over" / "Another device is the authorized host").
6. Members who were in A's session join B's session with B's code; their member screen shows no warning.

## 4. Fencing, revocation, conflicts
1. While B hosts and a member is connected, the owner taps "Stop B hosting" (P or A). Expected: B's host screen shows
   writes refused ("expired or was revoked"); a member's send shows the host-unavailable warning; nothing is deleted.
2. Hand hosting back to A (owner requests A; B confirms and hands over — a revoked host may still hand back).
3. Storage: on the destination, fill the disk until < 300 MB free, start a hand-over. Expected: refused before transfer
   with the needed/free MB; nothing changes on either device.
4. Rollback: on a host computer after it handed over, quit CLAN, corrupt the database file (make it unreadable) so the
   app restores its newest backup, restart. Expected: the CLAN shows "restored from an older backup" and refuses to
   host it. (Do this only on a disposable profile.)
5. Conflict (optional, destructive, disposable profiles only): requires two copies of the same host key — not
   reproducible without manual key copying; covered by deterministic tests (`packages/clan/test/hosting.test.ts`).

## 5. Windows-specific
- Repeat section 3 with Windows B as the source and Mac A as destination.
- Verify the Windows Firewall prompt appears for the device-link (sync) server and the host server; with the profile
  set to Public, hand-over must fail with "could not be reached", never partially.

## 6. iOS
Not available: the iOS build is blocked (see docs/BUILDING.md). Do not claim iOS results.

## 7. Report
For each step: PASS/FAIL, commit, devices/OS, network, timings for the 200 MB transfer, screenshots of each Hosting
panel state, and logs (desktop: `CLASSROOM_USER_DATA/logs`, Android: `adb logcat -d | grep -i clan`).
