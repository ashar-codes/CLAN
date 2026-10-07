# Modules

## Legacy names

The product is **CLAN** (never expanded). These internal identifiers keep the old name because changing them would break
persisted data, signatures, installed apps or peers; none of them is shown to users.

| Identifier | Why it stays |
|---|---|
| `LEGACY_STORAGE_NAME = 'Classroom LAN'` (desktop `app.setName` before ready) | Keychain item `Classroom LAN Safe Storage` and the userData folder derive from it; renaming makes every stored key undecryptable (verified). The app switches to `CLAN` after the keystore is initialised. |
| `SERVICE_TYPE = 'classroomlan'` (mDNS `_classroomlan._tcp`) | Older clients discover by it. |
| `classroom-lan/*` signed payload `type` strings | Part of signed canonical bytes (receipts, manifests, endorsements, capabilities). |
| `@classroom/*` workspace packages, root package `classroom-lan` | Internal import paths only. |
| `app.classroomlan.desktop`, `app.classroomlan.student` | Bundle/application ids: changing them makes the OS treat it as a new app (lost keychain access, permissions). |
| Mobile Documents folder `Classroom LAN/` | Existing downloads and receipts live there. |
| SQLite tables `sessions`, `members`, `resources`, `assignments`, … and migrations 1–4 | Durable data; migrations are append-only. |
| `CLASSROOM_*` environment variables | Scripts and CI. |
| `Classroom*` TypeScript symbols (`ClassroomConnection`, `ClassroomInfo`) | A classroom is still a real concept: the CLASSROOM CLAN type. |
