// Serves packages/app/harness/appProbe.tsx in place of the app entry.
const config = require('../../packages/app/metro.config.js');

module.exports = {
  ...config,
  server: {
    ...config.server,
    rewriteRequestUrl: url =>
      url.replace(/^\/index\.(bundle|map)/u, '/harness/appProbe.$1'),
  },
};
