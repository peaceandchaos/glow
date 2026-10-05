const { resolve } = require('node:path');
const { checkAppConfig } = require('../../tools/check-app-config.cjs');

// Every JavaScript bundle loads this file first: the Xcode bundle phase,
// `npm run ios`, `npm start`, and `npm run build:ios-js`.
const problems = checkAppConfig(resolve(__dirname, '../..'));
if (problems.length > 0) throw new Error(problems.join('\n'));

const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const config = { watchFolders: [resolve(__dirname, '../..')] };

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
