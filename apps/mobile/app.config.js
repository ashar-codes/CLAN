// Packaging-only overrides; the ordinary configuration in app.json stays the protected beta identity.
//   CLAN_FINAL_QA=1          separate "CLAN QA" identity (installs beside existing CLAN apps; never replaces their data)
//   CLAN_GOOGLE_SERVICES=…   path to google-services.json → Android FCM wake-ups (docs/FINAL_ANDROID_FCM.md)
//   CLAN_APNS=1              iOS push + PushKit/CallKit (needs a paid team with the Push capability; docs/FINAL_IOS_PUSH_CALLKIT.md)
//   CLAN_BTC2R_QA=1          the earlier BTC-2R QA identity (kept for reproducibility)
module.exports = ({ config }) => {
  let c = config;
  if (process.env.CLAN_BTC2R_QA === '1') c = { ...c, version: '0.1.1', ios: { ...c.ios,
    bundleIdentifier: 'app.classroomlan.student.btc2r', buildNumber: '3',
    infoPlist: { ...c.ios.infoPlist, CFBundleDisplayName: 'CLAN BTC2R QA', CLANShareGroup: 'group.app.classroomlan.student.btc2r', CLANSourceCommit: process.env.CLAN_SOURCE_SHA ?? 'UNVERIFIED' } } };
  if (process.env.CLAN_FINAL_QA === '1') c = { ...c, name: 'CLAN QA', version: '0.2.0', ios: { ...c.ios,
    bundleIdentifier: process.env.CLAN_IOS_BUNDLE_ID ?? 'app.classroomlan.student.finalqa', buildNumber: '4',
    infoPlist: { ...c.ios.infoPlist, CFBundleDisplayName: 'CLAN QA', CLANShareGroup: process.env.CLAN_IOS_SHARE_GROUP ?? '', CLANSourceCommit: process.env.CLAN_SOURCE_SHA ?? 'UNVERIFIED' } } };
  // Personal (free) Apple teams cannot sign Hotspot Configuration: hotspot joining then falls back to Settings.
  if (process.env.CLAN_FREE_TEAM === '1') { const { 'com.apple.developer.networking.HotspotConfiguration': _h, ...entitlements } = c.ios.entitlements ?? {}; c = { ...c, ios: { ...c.ios, entitlements } }; }
  if (process.env.CLAN_GOOGLE_SERVICES) c = { ...c, android: { ...c.android, googleServicesFile: process.env.CLAN_GOOGLE_SERVICES } };
  if (process.env.CLAN_APNS === '1') c = { ...c, ios: { ...c.ios, infoPlist: { ...c.ios.infoPlist, CLANVoIPPush: true,
    UIBackgroundModes: [...new Set([...(c.ios.infoPlist.UIBackgroundModes ?? []), 'voip', 'remote-notification'])] } } };
  return c;
};
