import type { JWTVerifyGetKey } from 'jose';
import type { SessionToken } from '../../../shared/contracts';
import { SessionStore } from '../src/auth';
import type { Database } from '../src/database';

const noAppleKeys: JWTVerifyGetKey = () =>
  Promise.reject(new Error('This test never signs in with Apple.'));

export async function signedIn(
  database: Database,
  sessions: [SessionToken, string][],
) {
  const store = new SessionStore(database);
  for (const [token, user] of sessions) await store.create(token, user);
  return {
    allowedAppleUserIds: sessions.map(([, user]) => user).join(','),
    appleKeys: noAppleKeys,
    sessions: () => Promise.resolve(store),
  };
}

export function withoutDatabase(allowedAppleUserIds: string) {
  return {
    allowedAppleUserIds,
    appleKeys: noAppleKeys,
    sessions: () => Promise.reject(new Error('Must not load database')),
  };
}
