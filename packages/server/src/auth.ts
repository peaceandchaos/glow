import { createHash, timingSafeEqual } from 'node:crypto';

const devicePattern = /^[A-Za-z0-9_-]{43,128}$/u;

export function deviceOwner(headers: Headers, allowlist: string): string {
  const device = headers.get('X-Device-Id');
  if (!device || !devicePattern.test(device)) {
    throw new Response('Unauthorized', { status: 401 });
  }
  const candidate = createHash('sha256').update(device).digest();
  const allowed = allowlist
    .split(',')
    .map(value => value.trim())
    .some(value => {
      if (!devicePattern.test(value)) return false;
      const expected = createHash('sha256').update(value).digest();
      return timingSafeEqual(candidate, expected);
    });
  if (!allowed) throw new Response('Unauthorized', { status: 401 });
  return candidate.toString('hex');
}
