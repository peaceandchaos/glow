import { imageSchema } from '../../../../shared/contracts';

// Encodes the picked image as JPEG bytes at `scale` of its size and `quality`
// from 0 to 100.
type EncodeJpeg = (scale: number, quality: number) => Promise<ArrayBuffer>;

const jpegSteps = [
  { scale: 1, quality: 80 },
  { scale: 1, quality: 60 },
  { scale: 0.75, quality: 60 },
  { scale: 0.5, quality: 60 },
  { scale: 0.35, quality: 50 },
];

const alphabet =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunks: string[] = [];
  const chunkBytes = 3 * 4096;
  for (let start = 0; start < bytes.length; start += chunkBytes) {
    const end = Math.min(start + chunkBytes, bytes.length);
    let chunk = '';
    for (let i = start; i < end; i += 3) {
      const n =
        (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
      chunk +=
        alphabet[n >> 18] +
        alphabet[(n >> 12) & 63] +
        (i + 1 < end ? alphabet[(n >> 6) & 63] : '=') +
        (i + 2 < end ? alphabet[n & 63] : '=');
    }
    chunks.push(chunk);
  }
  return chunks.join('');
}

// Returns a data URL the contract accepts, or null when even the smallest
// JPEG is too large. The picker labels JPEG data "image/jpg"; anything else
// that does not fit, such as HEIC or an oversized photo, is re-encoded as
// JPEG at lower quality and then smaller sizes.
export async function fitImage(
  type: string,
  base64: string,
  encode: EncodeJpeg,
): Promise<string | null> {
  const picked = `data:${type === 'image/jpg' ? 'image/jpeg' : type};base64,${base64}`;
  if (imageSchema.safeParse(picked).success) return picked;
  const prefix = 'data:image/jpeg;base64,';
  const maxChars = imageSchema.maxLength ?? Infinity;
  for (const { scale, quality } of jpegSteps) {
    const bytes = await encode(scale, quality);
    if (prefix.length + Math.ceil(bytes.byteLength / 3) * 4 <= maxChars)
      return prefix + toBase64(bytes);
  }
  return null;
}
