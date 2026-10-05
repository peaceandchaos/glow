import { Alert, AppState } from 'react-native';
import { PROXY_BASE_URL } from '../config';
import { loadDeviceId } from '../device';
import { ServerTransport } from '../network/client';
import { nativeDrivers } from '../network/nativeDrivers';
import { createChatView, type ChatStore } from './chatView';
import { openArchive } from './nativeArchive';
import { followAppState } from './nativeSession';
import { ChatSession } from './session';

let started: Promise<ChatStore> | null = null;

export async function startAppSession(): Promise<ChatStore> {
  started ??= (async () => {
    const archive = openArchive();
    const deviceId = await loadDeviceId();
    const transport = new ServerTransport(
      PROXY_BASE_URL,
      deviceId,
      nativeDrivers,
      __DEV__,
    );
    const session = new ChatSession({
      archive,
      transport,
      scheduleFrame: callback => requestAnimationFrame(callback),
    });
    const store = createChatView(archive, session, message =>
      Alert.alert('Something went wrong', message),
    );
    followAppState(session);
    AppState.addEventListener('change', state => {
      if (state !== 'active') store.getState().saveDraftsNow();
    });
    return store;
  })();
  try {
    return await started;
  } catch (error) {
    started = null;
    throw error;
  }
}
