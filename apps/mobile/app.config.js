// Packaging-only identity override; the ordinary beta configuration remains unchanged.
module.exports = ({ config }) => {
  if (process.env.CLAN_BTC2R_QA !== '1') return config;
  return { ...config, version: '0.1.1', ios: { ...config.ios,
    bundleIdentifier: 'app.classroomlan.student.btc2r', buildNumber: '3',
    infoPlist: { ...config.ios.infoPlist, CFBundleDisplayName: 'CLAN BTC2R QA',
      CLANShareGroup: 'group.app.classroomlan.student.btc2r', CLANSourceCommit: process.env.CLAN_SOURCE_SHA ?? 'UNVERIFIED' },
  } };
};
