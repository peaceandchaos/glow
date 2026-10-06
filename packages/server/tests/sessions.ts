import type { JWTVerifyGetKey } from 'jose';
import type { SessionToken } from '../../../shared/contracts';
import { SessionStore } from '../src/auth';
import type { Database } from '../src/database';

const noAppleKeys: JWTVerifyGetKey = () =>
  Promise.reject(new Error('This test never signs in with Apple.'));

// Sign-in services for users who already hold these sessions.
export async function signedIn(
  database: Database,
  sessions: [SessionToken, string][],
) {
  const store = new SessionStore(database);
  for (const [token, user] of sessions) await store.create(token, user);
  return {
    allowlist: sessions.map(([, user]) => user).join(','),
    appleKeys: noAppleKeys,
    sessions: () => Promise.resolve(store),
  };
}

// Sign-in services for checks that must finish before any database access.
export function withoutDatabase(allowlist: string) {
  return {
    allowlist,
    appleKeys: noAppleKeys,
    sessions: () => Promise.reject(new Error('Must not load database')),
  };
}
