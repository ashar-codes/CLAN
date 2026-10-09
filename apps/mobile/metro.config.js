// The phone runs @clan/core (the same modules and PersonalSync as the desktop). Core's few Node built-ins map to the
// phone implementations in src/node; PDF.js is not bundled (see src/node/pdf.ts).
const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const config = getDefaultConfig(__dirname);
const shim = (f) => path.join(__dirname, 'src/node', f);
const ALIAS = {
  'node:crypto': shim('crypto.ts'),
  'node:fs': shim('fs.ts'),
  'node:fs/promises': shim('fs.ts'),
  'node:path': shim('path.ts'),
  'pdfjs-dist/legacy/build/pdf.mjs': shim('pdf.ts'),
};
const resolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (ctx, name, platform) =>
  ALIAS[name] ? { type: 'sourceFile', filePath: ALIAS[name] } : (resolve ?? ctx.resolveRequest)(ctx, name, platform);
module.exports = config;
