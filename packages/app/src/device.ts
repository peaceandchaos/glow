import { TurboModuleRegistry, type TurboModule } from 'react-native';
import * as Keychain from 'react-native-keychain';

interface NativeRandom extends TurboModule {
  getRandomBase64(byteLength: number): string;
}
const alphabet =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const service = 'personal-chat.device-id.v1';

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

export async function loadDeviceId(): Promise<string> {
  const stored = await Keychain.getGenericPassword({ service });
  if (stored) {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(stored.password))
      throw new Error(
        'The saved device identity is invalid. It was preserved.',
      );
    return stored.password;
  }
  const id = randomBase64(32)
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/u, '');
  const saved = await Keychain.setGenericPassword('device', id, {
    service,
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  if (!saved) throw new Error('Secure storage is unavailable.');
  return id;
}
