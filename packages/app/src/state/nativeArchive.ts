import { createMMKV } from 'react-native-mmkv';
import { secureId } from '../device';
import { ChatArchive, ownerStorage, type ArchiveStorage } from './archive';

function mmkvStorage(id: string): ArchiveStorage {
  const mmkv = createMMKV({ id, recoveryStrategy: 'recover-on-error' });
  return {
    getString: key => mmkv.getString(key),
    getAllKeys: () => mmkv.getAllKeys(),
    set: (key, value) => mmkv.set(key, value),
    remove: key => {
      mmkv.remove(key);
    },
  };
}

export function openArchive(
  appleUserId: string,
  onDirty: () => void,
  now: () => number = Date.now,
): ChatArchive {
  const archive = new ChatArchive(
    ownerStorage(appleUserId, mmkvStorage),
    secureId,
    now,
    onDirty,
  );
  archive.recover();
  return archive;
}
