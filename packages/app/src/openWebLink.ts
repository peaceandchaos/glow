import { Linking } from 'react-native';

const allowedSchemes = ['http:', 'https:'];

export async function openWebLink(raw: string): Promise<boolean> {
  if (/[\s\\\u0000-\u001f\u007f]/u.test(raw)) return false;
  const candidate = raw.replace(/^https?:/iu, scheme => scheme.toLowerCase());
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }
  if (
    !allowedSchemes.includes(url.protocol) ||
    !candidate.startsWith(`${url.protocol}//`) ||
    !url.hostname
  )
    return false;
  try {
    if (!(await Linking.canOpenURL(candidate))) return false;
    await Linking.openURL(candidate);
    return true;
  } catch {
    // The OS can refuse a valid web link; do not expose its URL in logs.
    return false;
  }
}
