// Serves packages/app/harness/nativeTransport.tsx in place of the app entry.
const config = require('../../packages/app/metro.config.js');

module.exports = {
  ...config,
  server: {
    ...config.server,
    rewriteRequestUrl: url =>
      url.replace(/^\/index\.(bundle|map)/u, '/harness/nativeTransport.$1'),
  },
};
