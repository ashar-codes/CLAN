# Real-device testing: Mac + Windows + Android on one LAN

Goal: run the RC1 hardware gates ([RC1_HARDWARE_GATES.md](RC1_HARDWARE_GATES.md)) and the
[student](../release/beta-v0.1.0/STUDENT_CHECKLIST.md) / [teacher](../release/beta-v0.1.0/TEACHER_CHECKLIST.md)
checklists on real hardware. Nothing below has been run on real hardware yet; record every result (device, OS, build
SHA-256, time, PASS/FAIL, sanitized symptom). Emulator or responsive-view results don't count.

## Setup
| Device | Role | Build |
|---|---|---|
| Mac (Apple Silicon, macOS 13+) | host and/or student; Mac Codex works here | RC1 DMG, or `pnpm dev` from the RC1 tag |
| Windows 10/11 x64 PC | host and/or student; Windows Claude works here | `CLAN Setup` installer built on Windows ([WINDOWS_SETUP.md](WINDOWS_SETUP.md)) or `pnpm dev` |
| Android phone (arm64, 7.0+) | student | RC1 APK (versionCode 2, beta upload certificate `9803dcd4…a60b`) |

* All three on the **same Wi-Fi/subnet**, client isolation off (home router or a test SSID; guest/public Wi-Fi usually
  isolates clients). Note the IP family and whether multicast works (mDNS discovery). If discovery fails, type the
  address the host shows (`IP:port`) — that is a supported path, but record it.
* Installers come from the local, git-ignored `release/beta-v0.1.0-rc1/`, never from Git. Hand them over by USB or a
  private channel you control and check `SHA256SUMS` on every device (`shasum -a 256`, `Get-FileHash`,
  `sha256sum`). Android: also check `apksigner verify --print-certs` (or the RC1 README digest).
* Use **disposable test data** (made-up names, no real student data). Desktop experiments: set `CLASSROOM_USER_DATA`
  to a temp folder. Phones: a test profile; uninstalling deletes phone data (no Android backup, by design).

## Session A — Windows hosts, Mac + Android join (teacher flow)
1. Windows: install, launch, CLANs → Create CLAN → Classroom → Start. Record SmartScreen/UAC prompts and confirm the
   three firewall rules exist (see WINDOWS_SETUP.md §6).
2. Mac and phone: Join a CLAN with the code; the Windows host approves both. Then: chat (everyone / one person),
   shared file download with SHA-256 check, assignment submit, whiteboard text **with the keyboard open on the phone**,
   presentation (Windows presents a window; Mac + phone view), student "Request to present" from the Mac.
3. Interruptions: phone Wi-Fi off 20 s → on; Mac sleep 1 min → wake; quit and restart the Windows host → Host again →
   members rejoin; remove and block a member.

## Session B — Mac hosts a Study group, Windows + Android join
Same as A with a Study group (members may send files and draw). Also: Mac ↔ phone **device linking** (Me › My Devices),
a note edited on both while one is offline → conflict shown → Keep both; unlink → phone refused.

## Session C — no internet, LAN only
Unplug the router's uplink (LAN stays up) and repeat a short A. CLAN must not need the internet anywhere.

## Session D — Direct Network (only on hardware that supports it)
Windows host with Wi-Fi Direct capable adapter, phone joins without infrastructure Wi-Fi. Record radio support first;
mark NOT TESTED on unsupported hardware.

## Collecting results
* Desktop: Me › Beta feedback → Save feedback… (diagnostics only if ticked; preview first). Windows Event Viewer,
  macOS Console for crashes. Android: `adb logcat -d > logcat.txt` **only with the tester's consent** and after
  checking it contains no personal data.
* Results go into `design/beta/<version>/hardware/<date>-<device>.md` via a PR (below). Never commit installers,
  logs with personal data, keys or databases.

## Working on branches (Windows Claude Code + Mac Codex)
* **Release tags are immutable:** `clan-beta-v0.1.0-rc1` (and earlier tags) are never moved, re-created or
  force-pushed. A new candidate gets a new tag (`clan-beta-v0.1.0-rc2`, …) on the integration branch after review.
* **Integration branch:** `clan-astra-phase12` on GitHub. Nobody pushes to it directly; it changes only through
  reviewed PRs. No force-pushes anywhere.
* **Per-agent branches, short-lived, from the integration branch:**
  * Windows Claude: `win/<topic>` (e.g. `win/installer-firewall-check`, `win/hardware-results-2026-10-12`)
  * Mac Codex: `mac/<topic>` (e.g. `mac/whiteboard-keyboard-fix`)
  ```sh
  git fetch origin && git switch -c win/<topic> origin/clan-astra-phase12
  # … commit small, focused changes with tests …
  git push -u origin win/<topic>
  gh pr create --base clan-astra-phase12 --title "<what>" --body "<why, evidence, platform tested>"
  ```
* **Each PR states:** platform and hardware it was tested on, commands run (`pnpm typecheck`, `pnpm test`,
  `pnpm test:e2e`, Android suites when relevant) with results — failures included, nothing skipped silently.
  Hardware-result PRs add only Markdown under `design/beta/`.
* **Integration:** the owner (or an agent asked by the owner) reviews, then merges with a normal merge or squash — no
  rebase of shared history. Both agents `git fetch` and rebase their own *unpushed* work, or merge
  `origin/clan-astra-phase12` into a pushed topic branch. If both agents touch the same file, the second PR merges the
  first's changes before review.
* **Cutting the next candidate:** after the fixes are merged and the gates re-run, tag the merge commit
  `clan-beta-v0.1.0-rc2` and push that one tag: `git push origin clan-beta-v0.1.0-rc2`. Build artifacts locally on the
  platform they're for; record SHA-256 in `release/<version>/SHA256SUMS`; keep binaries out of Git.
