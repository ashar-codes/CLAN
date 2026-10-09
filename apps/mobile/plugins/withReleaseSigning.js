// Android release builds are signed with the CLAN upload key, never the debug key. The key lives outside the repo; Gradle
// reads its location and passwords from ~/.gradle/gradle.properties (CLAN_UPLOAD_STORE_FILE, CLAN_UPLOAD_STORE_PASSWORD,
// CLAN_UPLOAD_KEY_ALIAS, CLAN_UPLOAD_KEY_PASSWORD). Without them a release build fails instead of falling back.
const { withAppBuildGradle } = require('@expo/config-plugins');

const SIGNING = `
        release {
            if (findProperty('CLAN_UPLOAD_STORE_FILE')) {
                storeFile file(findProperty('CLAN_UPLOAD_STORE_FILE'))
                storePassword findProperty('CLAN_UPLOAD_STORE_PASSWORD')
                keyAlias findProperty('CLAN_UPLOAD_KEY_ALIAS')
                keyPassword findProperty('CLAN_UPLOAD_KEY_PASSWORD')
            }
        }`;
const GUARD = `
// CLAN: refuse to produce a release APK/AAB that isn't signed with the upload key.
gradle.taskGraph.whenReady { graph ->
    if (graph.allTasks.any { it.name.toLowerCase().contains('release') && (it.name.startsWith('assemble') || it.name.startsWith('bundle') || it.name.startsWith('package')) } && !findProperty('CLAN_UPLOAD_STORE_FILE')) {
        throw new GradleException('CLAN release signing: set CLAN_UPLOAD_STORE_FILE / _STORE_PASSWORD / _KEY_ALIAS / _KEY_PASSWORD in ~/.gradle/gradle.properties (see docs/BUILDING.md).')
    }
}
`;

module.exports = (config) => withAppBuildGradle(config, (c) => {
  let g = c.modResults.contents;
  if (!g.includes("findProperty('CLAN_UPLOAD_STORE_FILE')")) {
    g = g.replace(/signingConfigs \{\n(\s+debug \{[\s\S]*?\n\s+\})/, (m) => m + SIGNING);
    g = g.replace(/(release \{\n(?:\s*\/\/.*\n)*\s*)signingConfig signingConfigs\.debug/, '$1signingConfig signingConfigs.release');
    g += GUARD;
    if (!g.includes('signingConfig signingConfigs.release') || !g.includes("storeFile file(findProperty('CLAN_UPLOAD_STORE_FILE'))")) throw new Error('withReleaseSigning: build.gradle layout changed; update the plugin');
  }
  c.modResults.contents = g;
  return c;
});
