const { resolve } = require('node:path');
const { git } = require('./verification/snapshot.cjs');

// Lint and format skip every path that .gitignore names, tracked or not. An
// empty core.excludesFile keeps a personal global ignore list out of the result.
function trackedIgnored(directory) {
  return git(directory, [
    '-c',
    'core.excludesFile=',
    'ls-files',
    '--cached',
    '--ignored',
    '--exclude-standard',
  ])
    .split('\n')
    .filter(Boolean);
}

function main() {
  const files = trackedIgnored(resolve(__dirname, '..'));
  for (const file of files)
    console.error(`${file} is tracked under an ignored path.`);
  console.log(
    `Ignored-file policy: ${files.length ? 'FAIL' : 'PASS'}; ${files.length} tracked files match .gitignore.`,
  );
  if (files.length) process.exitCode = 1;
}

module.exports = { trackedIgnored };
if (require.main === module) main();
