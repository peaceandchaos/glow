import { AppState } from 'react-native';
import type { ChatSession } from './session';

// Inactive saves partial replies; background also detaches readers without
// cancelling server work; active reconnects every unsettled reply.
export function followAppState(session: ChatSession): void {
  session.setLifecycle(AppState.currentState);
  AppState.addEventListener('change', state => session.setLifecycle(state));
}
