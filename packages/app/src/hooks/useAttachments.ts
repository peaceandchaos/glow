import { useCallback } from 'react';
import { Alert } from 'react-native';
import { launchImageLibrary, type Asset } from 'react-native-image-picker';
import { loadImage, type Image } from 'react-native-nitro-image';
import { type Attachment } from '../state/chatStore';
import { fitImage } from '../state/images';
import { type ChangeDraft } from './useDraft';

// Resolves to null when the photo cannot be made small enough to send, and
// rejects when it cannot be read.
async function attach(asset: Asset): Promise<Attachment | null> {
  const { uri, base64 } = asset;
  if (!uri || !base64) throw new Error('The picker returned no image data.');
  let image: Promise<Image> | Image | null = null;
  const dataUrl = await fitImage(
    asset.type ?? 'image/jpeg',
    base64,
    async (scale, quality) => {
      image ??= loadImage({ filePath: uri });
      const full = await image;
      const sized =
        scale < 1
          ? await full.resizeAsync(
              Math.round(full.width * scale),
              Math.round(full.height * scale),
            )
          : full;
      return (await sized.toEncodedImageDataAsync('jpg', quality)).buffer;
    },
  );
  return dataUrl ? { uri, dataUrl } : null;
}

export function useAttachments(changeDraft: ChangeDraft): {
  pickImages: () => Promise<void>;
  removeAttachment: (index: number) => void;
} {
  const pickImages = useCallback(async () => {
    const result = await launchImageLibrary({
      mediaType: 'photo',
      includeBase64: true,
      maxWidth: 2048,
      maxHeight: 2048,
      quality: 0.9,
      selectionLimit: 4,
    });
    if (result.didCancel || !result.assets) {
      return;
    }
    const { assets } = result;
    const outcomes = await Promise.allSettled(assets.map(attach));
    const picked: Attachment[] = [];
    const problems: string[] = [];
    outcomes.forEach((outcome, index) => {
      const { fileName } = assets[index];
      const name = fileName ? `"${fileName}"` : `Photo ${index + 1}`;
      if (outcome.status === 'rejected')
        problems.push(`${name} could not be attached.`);
      else if (outcome.value === null)
        problems.push(`${name} is too large to send.`);
      else picked.push(outcome.value);
    });
    if (problems.length > 0)
      Alert.alert('Something went wrong', problems.join('\n'));
    changeDraft(draft => ({
      ...draft,
      attachments: [...draft.attachments, ...picked],
    }));
  }, [changeDraft]);

  const removeAttachment = useCallback(
    (index: number) => {
      changeDraft(draft => ({
        ...draft,
        attachments: draft.attachments.filter((_, i) => i !== index),
      }));
    },
    [changeDraft],
  );

  return { pickImages, removeAttachment };
}
