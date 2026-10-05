import { createRef, useState } from 'react';
import { Alert } from 'react-native';
import { launchImageLibrary, type Asset } from 'react-native-image-picker';
import { act, create } from 'react-test-renderer';
import { imageSchema } from '../../../shared/contracts';
import { useAttachments } from '../src/hooks/useAttachments';
import type { ChangeDraft, Draft } from '../src/hooks/useDraft';

jest.mock('react-native-image-picker', () => ({
  launchImageLibrary: jest.fn(),
}));

// A JPEG encoder whose output shrinks with pixel count and quality, like the
// real one. At full size and quality 90 it is over the contract's limit.
const mockEncoded: { format: string; quality: number; width: number }[] = [];
let mockBytesPerPixel = 0.85;
let mockLastJpeg = new Uint8Array();
function mockImage(width: number, height: number) {
  return {
    width,
    height,
    resizeAsync: async (w: number, h: number) => mockImage(w, h),
    toEncodedImageDataAsync: async (format: string, quality: number) => {
      mockEncoded.push({ format, quality, width });
      const size = Math.round(
        width * height * mockBytesPerPixel * (quality / 100),
      );
      const bytes = new Uint8Array(size).map((_, i) => i % 251);
      mockLastJpeg = bytes;
      return {
        buffer: bytes.buffer,
        width,
        height,
        imageFormat: format,
      };
    },
  };
}
// The library's own Images and loadImage run, so its file uri handling is under
// test. Only the native image factory is replaced, and it opens only the files a
// test puts in mockFiles.
const mockFiles = new Set<string>();
async function mockLoadFromFile(path: string) {
  if (!mockFiles.has(path)) throw new Error(`No file at ${path}`);
  return mockImage(2048, 1536);
}
jest.mock('react-native-nitro-modules', () => ({
  NitroModules: {
    createHybridObject: () => ({
      loadFromFileAsync: (path: string) => mockLoadFromFile(path),
    }),
  },
}));
jest.mock('react-native-nitro-image', () => ({
  ...jest.requireActual('react-native-nitro-image/lib/commonjs/Images'),
  ...jest.requireActual('react-native-nitro-image/lib/commonjs/loadImage'),
}));

const prefix = 'data:image/jpeg;base64,';

function decodeBase64(text: string): Uint8Array {
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of text.replace(/=+$/u, '')) {
    value = ((value << 6) | alphabet.indexOf(char)) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 255);
    }
  }
  return Uint8Array.from(bytes);
}

async function pick(assets: Asset[]) {
  jest.mocked(launchImageLibrary).mockResolvedValue({ assets });
  const seenHook = createRef<ReturnType<typeof useAttachments>>();
  const seenDraft = createRef<Draft>();
  function Probe() {
    const [current, setDraft] = useState<Draft>({ text: '', attachments: [] });
    const changeDraft: ChangeDraft = setDraft;
    seenDraft.current = current;
    seenHook.current = useAttachments(changeDraft);
    return null;
  }
  act(() => {
    create(<Probe />);
  });
  const hook = seenHook.current;
  if (!hook) throw new Error('The probe did not render.');
  await act(async () => {
    await hook.pickImages();
  });
  const draft = seenDraft.current;
  if (!draft) throw new Error('The probe did not render.');
  return draft.attachments.map(attachment => attachment.dataUrl);
}

// The app runs with React Native's URL, not Node's.
const nodeUrl = globalThis.URL;
beforeAll(() => {
  Object.defineProperty(globalThis, 'URL', {
    value: jest.requireActual('react-native/Libraries/Blob/URL').URL,
    configurable: true,
    writable: true,
  });
});
afterAll(() => {
  Object.defineProperty(globalThis, 'URL', {
    value: nodeUrl,
    configurable: true,
    writable: true,
  });
});

beforeEach(() => {
  mockFiles.clear();
  mockEncoded.length = 0;
  mockBytesPerPixel = 0.85;
  jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
});

test('a picked JPEG that fits is sent as it is, under the type the contract names', async () => {
  const [dataUrl] = await pick([
    { uri: 'file:///tmp/a.jpg', type: 'image/jpg', base64: 'AAAA' },
  ]);
  expect(dataUrl).toBe(`${prefix}AAAA`);
  expect(mockEncoded).toEqual([]);
});

test('a photo one character over the limit is re-encoded as a JPEG that fits', async () => {
  const base64 = 'A'.repeat(3_000_001 - prefix.length);
  expect(`${prefix}${base64}`).toHaveLength(3_000_001);
  mockFiles.add('/tmp/My Photos/big.jpg');
  const [dataUrl] = await pick([
    { uri: 'file:///tmp/My%20Photos/big.jpg', type: 'image/jpeg', base64 },
  ]);
  expect(imageSchema.safeParse(dataUrl).success).toBe(true);
  expect(dataUrl.startsWith(prefix)).toBe(true);
  expect(mockEncoded.every(step => step.format === 'jpg')).toBe(true);
  const sent = decodeBase64(dataUrl.slice(prefix.length));
  expect(sent).toHaveLength(mockLastJpeg.length);
  expect(sent.every((byte, i) => byte === mockLastJpeg[i])).toBe(true);
  expect(Alert.alert).not.toHaveBeenCalled();
});

test('a photo of a type the contract does not accept is re-encoded as JPEG', async () => {
  mockFiles.add('/tmp/b.heic');
  const [dataUrl] = await pick([
    { uri: 'file:///tmp/b.heic', type: 'image/heic', base64: 'AAAA' },
  ]);
  expect(imageSchema.safeParse(dataUrl).success).toBe(true);
  expect(dataUrl.startsWith(prefix)).toBe(true);
});

test('a photo that cannot fit is left out with a message naming it, and the others attach', async () => {
  mockBytesPerPixel = 13;
  mockFiles.add('/tmp/huge.heic');
  const attached = await pick([
    { uri: 'file:///tmp/fine.jpg', type: 'image/jpeg', base64: 'AAAA' },
    {
      uri: 'file:///tmp/huge.heic',
      fileName: 'huge.heic',
      type: 'image/heic',
      base64: 'AAAA',
    },
  ]);
  expect(attached).toEqual([`${prefix}AAAA`]);
  expect(Alert.alert).toHaveBeenCalledWith(
    'Something went wrong',
    '"huge.heic" is too large to send.',
  );
});

test('a photo that cannot be read is named in a message, and the others attach', async () => {
  mockFiles.add('/tmp/second.heic');
  const attached = await pick([
    {
      uri: 'file:///tmp/missing.heic',
      fileName: 'missing.heic',
      type: 'image/heic',
      base64: 'AAAA',
    },
    { uri: 'file:///tmp/second.heic', type: 'image/heic', base64: 'AAAA' },
    { uri: 'file:///tmp/third.jpg', type: 'image/jpg', base64: 'AAAA' },
  ]);
  expect(attached).toHaveLength(2);
  expect(imageSchema.safeParse(attached[0]).success).toBe(true);
  expect(attached[1]).toBe(`${prefix}AAAA`);
  expect(Alert.alert).toHaveBeenCalledWith(
    'Something went wrong',
    '"missing.heic" could not be attached.',
  );
});
