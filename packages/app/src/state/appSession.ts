import { Alert, AppState } from 'react-native';
import { bakedCatalog } from '../../../../shared/catalog';
import { PROXY_BASE_URL } from '../config';
import { ServerTransport } from '../network/client';
import { nativeDrivers } from '../network/nativeDrivers';
import { createChatView, type ChatStore } from './chatView';
import { openArchive } from './nativeArchive';
import { followAppState } from './nativeSession';
import { ChatSession } from './session';

type Running = { store: ChatStore; stop: () => void };

let started: Promise<Running> | null = null;

export async function startAppSession(token: string): Promise<ChatStore> {
  started ??= (async () => {
    const archive = openArchive();
    const transport = new ServerTransport(
      PROXY_BASE_URL,
      token,
      nativeDrivers,
      () => bakedCatalog,
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
    const lifecycle = followAppState(session);
    const drafts = AppState.addEventListener('change', state => {
      if (state !== 'active') store.getState().saveDraftsNow();
    });
    const stop = () => {
      lifecycle.remove();
      drafts.remove();
      store.getState().saveDraftsNow();
      session.setLifecycle('background');
    };
    return { store, stop };
  })();
  try {
    return (await started).store;
  } catch (error) {
    started = null;
    throw error;
  }
}

export async function stopAppSession(): Promise<void> {
  const running = started;
  started = null;
  (await running)?.stop();
}
