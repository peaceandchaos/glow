import { Alert, AppState } from 'react-native';
import type { Account } from '../account';
import { PROXY_BASE_URL } from '../config';
import { ServerTransport } from '../network/client';
import { nativeDrivers } from '../network/nativeDrivers';
import { createChatView, type ChatStore } from './chatView';
import { openArchive } from './nativeArchive';
import { followAppState } from './nativeSession';
import { ChatSession } from './session';
import { ChatSync } from './sync';

type Running = { store: ChatStore; stop: () => void };

let started: Promise<Running> | null = null;

export async function startAppSession(account: Account): Promise<ChatStore> {
  started ??= (async () => {
    let sync: ChatSync | null = null;
    const archive = openArchive(account.appleUserId, () => void sync?.run());
    const transport = new ServerTransport(
      PROXY_BASE_URL,
      account.token,
      nativeDrivers,
      () => archive.catalog(),
      __DEV__,
    );
    const session = new ChatSession({
      archive,
      transport,
      scheduleFrame: callback => requestAnimationFrame(callback),
    });
    const store = createChatView(
      archive,
      session,
      message => Alert.alert('Something went wrong', message),
      (query, signal) => transport.search(query, signal),
    );
    sync = new ChatSync(archive, transport, change =>
      store.getState().synced(change),
    );
    const lifecycle = followAppState(session);
    let catalogRequest: AbortController | null = null;
    const refreshCatalog = () => {
      if (catalogRequest) return;
      const request = new AbortController();
      catalogRequest = request;
      transport
        .models(request.signal)
        .then(body => store.getState().receiveCatalog(body))
        .catch(() => undefined)
        .finally(() => {
          catalogRequest = null;
        });
    };
    refreshCatalog();
    void sync.run();
    const appState = AppState.addEventListener('change', state => {
      if (state === 'active') {
        refreshCatalog();
        void sync?.run();
      } else store.getState().saveDraftsNow();
      if (state === 'background') sync?.stop();
    });
    const stop = () => {
      sync?.stop();
      catalogRequest?.abort();
      lifecycle.remove();
      appState.remove();
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
