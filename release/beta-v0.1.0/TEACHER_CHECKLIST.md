# CLAN v0.1.0 beta — teacher checklist

One laptop (macOS arm64 or Windows x64) hosts; 2–5 students join from laptops or Android phones on the **same Wi-Fi**.
Allow about 45 minutes. Write `OK`, `FAIL` or `SKIP` and a short note per line. Nothing is sent anywhere by CLAN: you
collect the results (this file + optional feedback files, see the end).

Computer: ____________ OS/version: ____________ Wi-Fi: ____________ Date: ________

## A. Install and first start
| # | Step | Result / note |
|---|---|---|
| A1 | Install CLAN (SETUP.md). macOS: first open is blocked (unsigned) → System Settings › Privacy & Security › Open Anyway. Windows: SmartScreen "More info → Run anyway", then allow the installer (admin) | |
| A2 | First start shows My Space. Me › AI settings does **not** say "This computer has no secure key storage" | |
| A3 | macOS asks for Local Network access → Allow. Windows: no firewall prompt expected (installer added rules) | |

## B. Host a Classroom
| # | Step | Result / note |
|---|---|---|
| B1 | CLANs → Create CLAN → Classroom → Start Classroom. A 6-digit code and an address appear | |
| B2 | Students join with the code (STUDENT_CHECKLIST B). Each request appears; Approve them one by one | |
| B3 | A wrong code is refused on the student device and no request appears for you | |
| B4 | Remove one student → their app says so and they can't send anything. Let them join again and Approve | |
| B5 | Block a device → it can't rejoin with the code | |

## C. Teach
| # | Step | Result / note |
|---|---|---|
| C1 | Shared files → Add files (a PDF and a ~50 MB video). Students download; SHA-256 check passes on their side | |
| C2 | New assignment → a student submits a file → you see it with a signed receipt | |
| C3 | Present → pick a window. Students see it live within ~2 s. Switch source. Stop | |
| C4 | A student uses "Request to present" → you Allow → you see their screen → Stop | |
| C5 | Whiteboard: students can only view until you let them draw; then their strokes appear for everyone | |
| C6 | Chat: message everyone; students can message you; **students can't send files in a Classroom** | |

## D. Permissions and privacy
| # | Step | Result / note |
|---|---|---|
| D1 | A student of another CLAN on the same Wi-Fi can't see your files, chat or board | |
| D2 | Nothing asks for an account, email or internet. Turning off the internet (router uplink) changes nothing | |

## E. Recovery
| # | Step | Result / note |
|---|---|---|
| E1 | Turn Wi-Fi off on your laptop for 20 s, then on. Students reconnect by themselves | |
| E2 | Quit CLAN while students are in. Start it again → Host again → students rejoin (approved devices aren't asked again) | |
| E3 | Me › Your data → Back up now → Show backups: a `teacher-….db` file is there | |
| E4 | Me › Your data → Export my data… (Diary unticked) → a `CLAN export …` folder with your notes, no Diary | |
| E5 | End class. Students see that it ended | |

## F. Feedback (optional, local only)
Me › Beta feedback → write what went wrong or felt slow → tick "Attach diagnostics" only if you agree (press "Show
exactly what's attached" first: versions, counts and error kinds, never your notes, Diary, chats or names) → Save
feedback… → send the saved file yourself together with this checklist.
