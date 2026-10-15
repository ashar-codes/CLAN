# Discovery reliability verification

Branch `fix/discovery-and-android-push`. Legend: **PASS** · **FAIL** · **SKIPPED** · **NOT TESTED** (needs hardware or
networks not available here) · **BLOCKED**.

## Real-network matrix (`packages/clan/test/discovery-matrix.test.ts`)

Real multicast DNS-SD, real TCP/TLS and clan-link/1 over this Mac's Wi‑Fi interface (`192.168.18.223`, a second
link-local adapter present), independent identities and databases per participant, no loopback shortcuts. Two runs
(8 and 10 repetitions), all scenarios PASS. Same-host limitation: both participants are processes on one Mac, so
cross-device radio/AP effects are not covered here.

| Measurement | n | min ms | median | p90 | max |
|---|---|---|---|---|---|
| Fresh ↔ fresh mutual People discovery | 18 | 813 | 892 | 947 | 971 |
| From first app start (second app starts 0 or 1.5 s later) | 18 | 890 | 1756 | 2517 | 2555 |
| Friend request (no QR) → both friends | 18 | 31 | 37 | 65 | 71 |
| Live CLAN appears — browser started before host | 9 | 970 | 1099 | 1206 | 1207 |
| Live CLAN appears — host started before browser | 9 | 956 | 1082 | 1134 | 1140 |
| Six-digit code join (OPAQUE + pinned TLS), approval pending | 18 | 146 | 161 | 174 | 195 |
| Join by host address when multicast is blocked | 2 | 160 | 162 | 164 | 164 |
| Reappear after Invisible → Everyone | 2 | 857 | 894 | 931 | 931 |
| Rediscovery after app restart (same identity) | 2 | 855 | 907 | 960 | 960 |
| Rediscovery after network change | 2 | 127 | 485 | 843 | 843 |

Also asserted in every run: real names shown; host approval; wrong code → `bad_code` (never “no CLAN”); Friends Only
never visible to strangers; Invisible disappears; blocking stops requests; multicast-blocked network → `none_found`
and the manual address works; identity unchanged across restart; diagnostics record advertising and successful probes.

## Root-cause checks
| Check | Result |
|---|---|
| Advert carries only reachable LAN address (repro script, 3 runs) | PASS (`["192.168.18.223"]`, was `[".223","169.254.102.138"]`) |
| Deterministic slow wrong-code join reports `bad_code` | PASS (failed before fix) |
| Previously intermittent `join-discovery` test, 5 repeated runs | PASS 5/5 |

## Android (emulator, API 36 — no multicast to the LAN)
| Check | Result |
|---|---|
| Fresh user advertises + browses right after onboarding, People never opened | PASS (registration `clan-rB0oHDq0` observed) |
| Diagnostics: network, listener, announced, browsing, counts, hint | PASS |
| Wi‑Fi off/on in foreground (not Keep mode) → automatic re-advertisement | PASS |
| Own rotated advert no longer probed / misclassified | Fixed after observation; covered by code review |
| Hosted CLAN radar uses native NSD queue (`_classroomlan._tcp`), not zeroconf | PASS |
| Keep CLAN Available: background + screen off + Wi‑Fi off/on → re-advertised, process alive | PASS |
| Duplicate restarts per handover (3 in 1.4 s) | Found; debounced to one |
| Forced deep Doze: no processing while idle (OS policy), recovery 4 s after idle ends | PASS (as expected) |
| Force-stop | Not supported by Android for background work (documented) |
| Two Android devices / Android ↔ Mac on a real LAN | NOT TESTED (no hardware attached) |

## Desktop
| Suite | Result |
|---|---|
| Unit/integration (macOS) | PASS 80 files, 557 tests (4 opt-in matrix skips) |
| Electron E2E (macOS, 29 files: OPAQUE/pinned TLS join, People, chat, files, calls, meetings, screen sharing, remote control + consent, hosting, sync, study) | PASS 28 + 1 pre-existing conditional skip |
| Mac ↔ Mac separate disposable profiles (real mDNS) | PASS (matrix) |
| Windows (native runner): unit + full Electron E2E + discovery matrix | PASS (CI below) |
| Windows ↔ Mac physical | NOT TESTED |

## Not testable here
Physical Android/Windows hardware, different routers/APs, client-isolated or VLAN networks, the user's own Wi‑Fi.
Use docs/DISCOVERY_QA_INSTALLATION.md and send exported diagnostics.

## CI
Source `a350c09`:
| Workflow | Run | Result |
|---|---|---|
| Regression: Linux + Windows unit, full Windows Electron E2E, real-network discovery matrix on both runners | 38723106255 | **PASS** |
| Windows installer: build, silent install, launch, packaged regression, uninstall, firewall preservation | 38723106202 | **PASS** |

Native runner matrix (6 repetitions, real mDNS on each runner's own interface, same-host):
| | Linux (10.1.0.44) median / max ms | Windows (10.1.0.156) median / max ms |
|---|---|---|
| People mutual discovery | 860 / 930 | 910 / 991 |
| CLAN appears (browser first / host first) | 1151 / 1182 · 1080 / 1213 | 1133 / 1148 · 1178 / 1231 |
| Code join | 188 / 222 | 232 / 249 |
| Friend request → friends | 47 / 74 | 83 / 104 |
| Rediscover after restart / network change | 873 · 899 | 940 · 54 |
