import React, { useEffect, useState } from 'react';
import { Alert, StatusBar } from 'react-native';
import BootSplash from 'react-native-bootsplash';
import {
  SafeAreaProvider,
  initialWindowMetrics,
} from 'react-native-safe-area-context';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { restoreAccount, signOut, type Account } from './src/account';
import { RootDrawer } from './src/screens/RootDrawer';
import { SignInScreen } from './src/screens/SignInScreen';
import { startAppSession, stopAppSession } from './src/state/appSession';
import { ChatStoreContext } from './src/state/chatStore';
import type { ChatStore } from './src/state/chatView';
import { SignOutContext } from './src/state/signOut';

// No chat session exists until an account is signed in.
type Gate =
  | { kind: 'starting' }
  | { kind: 'signedOut' }
  | { kind: 'signedIn'; account: Account; store: ChatStore };

type SetGate = (gate: Gate) => void;

// Opens the chats of a new sign-in, or else of the saved account if Apple
// still allows it.
function open(setGate: SetGate, signedIn?: Account): void {
  (signedIn ? Promise.resolve(signedIn) : restoreAccount())
    .then(async account => {
      if (!account) {
        setGate({ kind: 'signedOut' });
        return;
      }
      const store = await startAppSession(account.token);
      setGate({ kind: 'signedIn', account, store });
    })
    .catch(() => {
      void BootSplash.hide({ fade: true });
      Alert.alert('Something went wrong', 'Your chats could not be opened.', [
        { text: 'Retry', onPress: () => open(setGate, signedIn) },
      ]);
    });
}

function leave(setGate: SetGate, account: Account): void {
  signOut(account)
    .then(async () => {
      await stopAppSession();
      setGate({ kind: 'signedOut' });
    })
    .catch(() =>
      Alert.alert('Something went wrong', 'You could not be signed out.'),
    );
}

function App() {
  const [gate, setGate] = useState<Gate>({ kind: 'starting' });
  useEffect(() => open(setGate), []);

  return (
    <SafeAreaProvider initialMetrics={initialWindowMetrics}>
      <KeyboardProvider>
        <StatusBar barStyle="light-content" backgroundColor="transparent" />
        {gate.kind === 'signedIn' ? (
          <SignOutContext value={() => leave(setGate, gate.account)}>
            <ChatStoreContext value={gate.store}>
              <RootDrawer />
            </ChatStoreContext>
          </SignOutContext>
        ) : gate.kind === 'signedOut' ? (
          <SignInScreen onSignedIn={account => open(setGate, account)} />
        ) : null}
      </KeyboardProvider>
    </SafeAreaProvider>
  );
}

export default App;
