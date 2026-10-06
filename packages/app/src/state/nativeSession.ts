import { AppState, type NativeEventSubscription } from 'react-native';
import type { ChatSession } from './session';

// Inactive saves partial replies; background also detaches readers without
// cancelling server work; active reconnects every unsettled reply.
export function followAppState(session: ChatSession): NativeEventSubscription {
  session.setLifecycle(AppState.currentState);
  return AppState.addEventListener('change', state =>
    session.setLifecycle(state),
  );
}
