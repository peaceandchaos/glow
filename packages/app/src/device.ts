import { TurboModuleRegistry, type TurboModule } from 'react-native';

interface NativeRandom extends TurboModule {
  getRandomBase64(byteLength: number): string;
}
const alphabet =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function randomBase64(bytes: number): string {
  // Call the native CSPRNG directly. The package's JS debug fallback can use Math.random.
  const result =
    TurboModuleRegistry.getEnforcing<NativeRandom>(
      'RNGetRandomValues',
    ).getRandomBase64(bytes);
  if (
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(result) ||
    result.length !== Math.ceil(bytes / 3) * 4
  )
    throw new Error('Secure random generation is unavailable.');
  return result;
}

export function secureId(): string {
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of randomBase64(16).replace(/=+$/u, '')) {
    value = (value << 6) | alphabet.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 255);
    }
  }
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// A Sign in with Apple nonce: 32 random bytes as base64url.
export function secureNonce(): string {
  return randomBase64(32)
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/u, '');
}
