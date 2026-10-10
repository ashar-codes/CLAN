# Android beta signing backup (operator procedure)

Status for RC1: the existing `clan-beta` PKCS#12 upload key is present outside the repository with owner-only file
permissions, and its password entry exists in the macOS login keychain. The currently published beta APK verifies with
certificate SHA-256 `9803dcd4a46b8f23768e27232f47ce0630d20bd09472131cc179606fbfc9a60b`. **An independent
offline backup has not been confirmed.** The owner must choose and approve the backup destination and custodian.

1. Choose two independent encrypted offline media or an approved secrets vault, with access restricted to the release
   owner. Do not put either copy in Git, CI artifacts, cloud-shared folders or a chat message.
2. On the owner's machine, copy `~/.clan-signing/clan-beta-upload.p12` to the chosen encrypted destination without
   opening it in a text viewer. Save the `CLAN Android upload key` keychain password separately in the approved password
   manager. Do not print the key or password into terminal logs.
3. Compare SHA-256 digests of source and backup locally, without publishing the digest if it would identify the private
   file. With the owner present, perform a test restore to a temporary secure location and sign a disposable APK. Check
   its certificate digest matches the beta certificate above; then securely remove the disposable restored copy.
4. Record custodian, date, media/location reference and restore result in the private release register. Review access
   after staff changes. If the upload key is lost, use the distribution platform's supported reset process; this
   procedure does not assume that an upload-key reset preserves sideload update compatibility.

Release scripts read the password from the login keychain and fail closed if it is unavailable. Do not export a
password to a persistent shell profile or commit a Gradle signing properties file.
