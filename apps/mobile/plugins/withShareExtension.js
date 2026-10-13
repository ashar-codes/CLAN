// Expo config plugin: adds the "CLAN" iOS Share Extension target (ios-extension/*) to the generated Xcode project,
// embeds it in the app, and gives app + extension the same App Group (the hand-off folder). Signing needs an Apple team.
const { withDangerousMod, withEntitlementsPlist, withXcodeProject } = require('@expo/config-plugins');
const fs = require('node:fs');
const path = require('node:path');

const NAME = 'CLANShare';
const GROUP = 'group.app.classroomlan.student';
const groupFor = (c) => c.ios?.infoPlist?.CLANShareGroup ?? GROUP;
const FILES = ['ShareViewController.swift', 'Info.plist', `${NAME}.entitlements`];

const withFiles = (config) => withDangerousMod(config, ['ios', (c) => {
  const dest = path.join(c.modRequest.platformProjectRoot, NAME);
  fs.mkdirSync(dest, { recursive: true });
  for (const f of FILES) {
    let text = fs.readFileSync(path.join(c.modRequest.projectRoot, 'ios-extension', f), 'utf8');
    if (f.endsWith('.entitlements')) text = text.replaceAll(GROUP, groupFor(c));
    if (f === 'Info.plist') text = text.replace('<dict>', `<dict><key>CLANShareGroup</key><string>${groupFor(c)}</string>`);
    fs.writeFileSync(path.join(dest, f), text);
  }
  return c;
}]);

const withTarget = (config) => withXcodeProject(config, (c) => {
  const p = c.modResults;
  const bundleId = `${c.ios?.bundleIdentifier ?? config.ios.bundleIdentifier}.share`;
  if (!p.pbxTargetByName(NAME)) {
    const target = p.addTarget(NAME, 'app_extension', NAME, bundleId);
    const group = p.addPbxGroup(FILES, NAME, NAME);
    p.addToPbxGroup(group.uuid, p.getFirstProject().firstProject.mainGroup);
    p.addBuildPhase(['ShareViewController.swift'], 'PBXSourcesBuildPhase', 'Sources', target.uuid);
    p.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', target.uuid);
    p.addBuildPhase(['UniformTypeIdentifiers.framework'], 'PBXFrameworksBuildPhase', 'Frameworks', target.uuid);
  }
  const configs = p.pbxXCBuildConfigurationSection();
  for (const key of Object.keys(configs)) {
    const b = configs[key].buildSettings;
    if (!b || b.PRODUCT_NAME !== `"${NAME}"`) continue;
    Object.assign(b, {
      INFOPLIST_FILE: `${NAME}/Info.plist`, CODE_SIGN_ENTITLEMENTS: `${NAME}/${NAME}.entitlements`, PRODUCT_BUNDLE_IDENTIFIER: bundleId,
      SWIFT_VERSION: '5.0', IPHONEOS_DEPLOYMENT_TARGET: '15.1', TARGETED_DEVICE_FAMILY: '"1,2"', MARKETING_VERSION: config.version, CURRENT_PROJECT_VERSION: config.ios?.buildNumber ?? '1', // must equal the app's
      ...(config.ios?.appleTeamId ? { DEVELOPMENT_TEAM: config.ios.appleTeamId } : {}),
      SKIP_INSTALL: 'YES', CODE_SIGN_STYLE: 'Automatic', GENERATE_INFOPLIST_FILE: 'NO',
    });
  }
  return c;
});

const withGroup = (config) => withEntitlementsPlist(config, (c) => {
  const k = 'com.apple.security.application-groups';
  c.modResults[k] = [...new Set([...(c.modResults[k] ?? []).filter(g => g !== GROUP || groupFor(c) === GROUP), groupFor(c)])];
  return c;
});

module.exports = (config) => withGroup(withTarget(withFiles(config)));
