import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const paths = [];
const server = http.createServer((req, res) => {
  paths.push(req.url);
  res.writeHead(307, { Location: '/target' }).end();
});
await new Promise(ready => server.listen(0, '127.0.0.1', ready));
const dir = mkdtempSync(join(tmpdir(), 'redirect-handler-'));
let results;
try {
  const binary = join(dir, 'redirect-handler');
  execFileSync('xcrun', [
    'swiftc',
    join(import.meta.dirname, 'redirect-handler.swift'),
    '-o',
    binary,
  ]);
  const { stdout } = await promisify(execFile)(binary, [
    String(server.address().port),
  ]);
  results = stdout
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
} finally {
  server.close();
  rmSync(dir, { recursive: true, force: true });
}

const expected = [
  { mode: 'held', completed: -999, released: false },
  { mode: 'refused', completed: -999, released: true },
];
for (const result of results) console.log(JSON.stringify(result));
console.log(`requests: ${JSON.stringify(paths)}`);
const ok =
  JSON.stringify(results) === JSON.stringify(expected) &&
  paths.every(path => path === '/redirect');
console.log(ok ? 'PASS' : 'FAIL');
process.exitCode = ok ? 0 : 1;
