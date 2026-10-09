// CLAN shows local notifications only; there is no push server (no cloud). expo-notifications adds the remote-push
// entitlement by default, which would need a Push capability in the provisioning profile — remove it.
const { withEntitlementsPlist } = require('@expo/config-plugins');
module.exports = (config) => withEntitlementsPlist(config, (c) => { delete c.modResults['aps-environment']; return c; });
