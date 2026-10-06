import { appleAuth } from '@invertase/react-native-apple-authentication';
import * as Keychain from 'react-native-keychain';
import type { z } from 'zod';
import {
  decodeJson,
  sessionResponseSchema,
  type sessionRequestSchema,
} from '../../../shared/contracts';
import { PROXY_BASE_URL } from './config';
import { secureNonce } from './device';
import { validateServerAddress } from './network/client';
import { nativeDrivers } from './network/nativeDrivers';
import { TransportError } from './network/transport';

// One Keychain item: the Apple user ID as its account, the server's session
// token as its password.
const service = 'personal-chat.session.v1';
const requestTimeoutMs = 15_000;
const notAllowed = 'This Apple account is not allowed.';
const retry = 'Sign-in failed. Try again.';

export type Account = { appleUserId: string; token: string };

type SignInResult =
  | { kind: 'signedIn'; account: Account }
  | { kind: 'cancelled' }
  | { kind: 'failed'; message: string };

function hasCode(error: unknown): error is { code: unknown } {
  return typeof error === 'object' && error !== null && 'code' in error;
}

async function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

function sessionUrl(): string {
  return `${validateServerAddress(PROXY_BASE_URL, __DEV__)}/v1/session`;
}

async function openServerSession(
  identityToken: string,
  rawNonce: string,
): Promise<string> {
  const text = await withTimeout(async signal => {
    const response = await nativeDrivers.fetch(sessionUrl(), {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identityToken,
        rawNonce,
      } satisfies z.input<typeof sessionRequestSchema>),
    });
    if (!response.ok)
      throw new TransportError(response.status, 'Sign-in was refused.');
    return response.text();
  });
  return decodeJson(sessionResponseSchema, text).token;
}

// Pass Apple the raw nonce: the library sends Apple its SHA-256, and the
// server compares that hash in the identity token with the raw nonce.
export async function signInWithApple(): Promise<SignInResult> {
  try {
    const nonce = secureNonce();
    const credential = await appleAuth.performRequest({
      requestedOperation: appleAuth.Operation.LOGIN,
      requestedScopes: [],
      nonce,
    });
    if (!credential.identityToken) return { kind: 'failed', message: retry };
    const account = {
      appleUserId: credential.user,
      token: await openServerSession(credential.identityToken, nonce),
    };
    const saved = await Keychain.setGenericPassword(
      account.appleUserId,
      account.token,
      {
        service,
        accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      },
    );
    if (!saved) return { kind: 'failed', message: retry };
    return { kind: 'signedIn', account };
  } catch (error) {
    if (hasCode(error) && error.code === appleAuth.Error.CANCELED)
      return { kind: 'cancelled' };
    const refused = error instanceof TransportError && error.status === 403;
    return { kind: 'failed', message: refused ? notAllowed : retry };
  }
}

// Apple's own check that the user still allows this app. An unanswered check
// keeps the session, because the server checks its allowlist on every request.
async function revokedByApple(appleUserId: string): Promise<boolean> {
  try {
    const state = await appleAuth.getCredentialStateForUser(appleUserId);
    return (
      state === appleAuth.State.REVOKED || state === appleAuth.State.NOT_FOUND
    );
  } catch {
    return false;
  }
}

export async function restoreAccount(): Promise<Account | null> {
  const saved = await Keychain.getGenericPassword({ service });
  if (!saved) return null;
  if (await revokedByApple(saved.username)) {
    await Keychain.resetGenericPassword({ service });
    return null;
  }
  return { appleUserId: saved.username, token: saved.password };
}

export async function signOut(account: Account): Promise<void> {
  try {
    await withTimeout(signal =>
      nativeDrivers.fetch(sessionUrl(), {
        method: 'DELETE',
        redirect: 'error',
        signal,
        headers: { Authorization: `Bearer ${account.token}` },
      }),
    );
  } catch {
    // The phone forgets the token either way; an unreached server keeps an
    // unused session row.
  }
  await Keychain.resetGenericPassword({ service });
}
