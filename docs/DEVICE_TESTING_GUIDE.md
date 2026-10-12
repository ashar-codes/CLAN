# CLAN personal device tests — TEST / UNVERIFIED

These builds are for your private testing. Physical interoperability is not certified and public release is not approved.
Use disposable names, messages and files. Keep your current CLAN installation and data. The Android app named
**CLAN TEST** is separate from the beta. The packaged computer TEST apps use a separate `personal-beta-test` profile automatically
(see the supplied installation instructions). Do not clear your real application's data or change its identity.

Start with the Mac, then Windows and Android, then the two iPhones through Xcode. Allow local-network access and
the app's firewall prompt. Allow camera/microphone only when trying those features. Compare the version/commit
in the delivery manifest on every device. Record the device models, OS versions and network used.

For each test mark one result: **PASS**, **FAIL**, or **NOT TESTED**. If a feature is unsupported, write why; do not
mark it PASS. Keep codes, QR invitations, addresses, passwords and private messages out of public reports.

1. **Mac ↔ Windows.** Put both on the same Wi-Fi. Create a disposable Study Group on the Mac, join from Windows,
   approve the request, then send a message each way. Repeat with Windows hosting.
   Expected: the correct group appears, both messages arrive once, and an unapproved device has no access.
   [ ] PASS  [ ] FAIL  [ ] NOT TESTED

2. **Android ↔ computers.** On CLAN TEST, join a Mac-hosted group and repeat with Windows. Send messages each way.
   Link your disposable personal profiles through Me → My Devices with approval on the other computer.
   Expected: group messages arrive; a personal note edited on one linked device appears on the other.
   [ ] PASS  [ ] FAIL  [ ] NOT TESTED

3. **Two iPhones and iPhone ↔ Mac.** Install through the supplied Xcode instructions. Enable Nearby People on both
   phones, verify each other's identity, connect and send a message. Repeat phone ↔ Mac.
   Expected: the intended peer appears and messages arrive once. Record whether same-Wi-Fi and router-free paths work
   separately; a simulator build does not prove either radio path.
   [ ] PASS  [ ] FAIL  [ ] NOT TESTED

4. **Nearby People and privacy.** Set disposable names/profiles, opt into discovery, send/accept a friend request,
   compare identity fingerprints on both screens, then block the other person and turn discovery off.
   Expected: the profile and request belong to the verified person; blocking stops contact and new access; discovery
   off stops advertising. An already known friend may remain in the local friends list.
   [ ] PASS  [ ] FAIL  [ ] NOT TESTED

5. **Individual chats and files.** Send a private message and a small file to one friend while a third device is present.
   Compare the received file's SHA-256 with the original using the checksum instructions. Interrupt a larger download,
   reconnect and resume; try cancellation. Test a temporary chat and its expiry.
   Expected: only the intended recipient gets private content; resumed files match exactly; cancellation stops transfer;
   expired content leaves the active chat. Saved copies/backups are not guaranteed to be erased.
   [ ] PASS  [ ] FAIL  [ ] NOT TESTED

6. **Voice notes and calls.** Record and play a voice note, then make a two-way audio call. Swap caller and receiver.
   Try a denied microphone permission, then grant it through OS settings and retry.
   Expected: both people hear each other, mute works, hang-up stops microphone use, and denial leaves the app usable.
   Record every device pair separately.
   [ ] PASS  [ ] FAIL  [ ] NOT TESTED

7. **Router-free networking.** With two Android devices, turn off the router and internet, then use the supported
   Wi-Fi Direct/Aware flow. For two iPhones, try the supported peer path separately.
   Expected: actual peer connectivity carries a message and a verified file. Aware requires compatible hardware.
   If the device says unavailable, record that limitation. Macs do not create Wi-Fi hotspots through this app.
   [ ] PASS  [ ] FAIL  [ ] NOT TESTED

8. **Hotspot without internet.** Create the Android hotspot flow, connect Mac/Windows/iPhone to it, and disable
   mobile data. Also repeat the normal Wi-Fi tests with the router's internet disconnected.
   Expected: local discovery, approved joining, messages and file transfers work without internet.
   [ ] PASS  [ ] FAIL  [ ] NOT TESTED

9. **QR invitations and optical files.** Scan a static invitation and check the displayed person/group before accepting.
   For animated QR file transfer, disable Wi-Fi, Bluetooth and mobile data on both devices, then show/scan the frames.
   Try looking away briefly and scanning another transfer. Compare the reconstructed file checksum.
   Expected: consent is required, wrong/private receiver codes cannot decrypt, interrupted scanning resumes, and exact
   bytes arrive with radios off. Start with a small file and good lighting.
   [ ] PASS  [ ] FAIL  [ ] NOT TESTED

10. **Classroom and secure hosting.** Host a disposable classroom, approve members, test chat, files, a whiteboard,
    Notes and Tasks. Hand a phone-owned group to its linked computer, then hand it between computers. Revoke a
    delegation and retry. Restart the old host after handover.
    Expected: data/history survive; only the current authorized host accepts writes; revoked devices cannot regain
    authority. If two hosts can both write after a completed handover, stop using that group and report FAIL.
    [ ] PASS  [ ] FAIL  [ ] NOT TESTED

11. **Background and reconnection.** Minimize the app, lock the phone, wait several minutes, unlock and reopen.
    Interrupt Wi-Fi, reconnect, then switch between Wi-Fi and a hotspot. Send while the other device is offline.
    Expected: pending messages/changes recover without duplicates or missing data. Record notifications and foreground
    service behavior on Android. iOS may suspend the app; guaranteed continuous background availability is not promised.
    [ ] PASS  [ ] FAIL  [ ] NOT TESTED

12. **Persistence and updates.** Create a note, chat and file. Close/restart the app and reboot the device. Update only
    the same TEST package with the same certificate; preserve the original beta separately. Edit the same synced note
    offline on two devices and choose Keep both after reconnecting.
    Expected: data and identity fingerprints survive; both conflicting versions converge on both devices. This debug
    APK cannot update a differently signed beta. iPhone provisioning expiry can require reinstalling through Xcode.
    [ ] PASS  [ ] FAIL  [ ] NOT TESTED

For a failure, send: test number, device pair, expected result, actual result, and the smallest repeatable steps.
Do not reset the affected profile; preserve it for diagnosis. Stop if identity changes unexpectedly or data disappears.
The developer's fuller coverage lists remain in PHASE_14_3_HARDWARE_TESTS.md and HOSTING_HARDWARE_TESTS_PHASE_14_2.md.
