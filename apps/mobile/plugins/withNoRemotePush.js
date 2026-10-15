// Without CLAN_APNS=1 (a team with the Push capability), drop the remote-push entitlement expo-notifications adds:
// the build then has local notifications only and signs with any (including free) provisioning.
const { withEntitlementsPlist } = require('@expo/config-plugins');
module.exports = (config) => withEntitlementsPlist(config, (c) => {
  if (process.env.CLAN_APNS === '1') c.modResults['aps-environment'] = process.env.CLAN_APNS_ENV ?? 'development';
  else delete c.modResults['aps-environment'];
  return c;
});
