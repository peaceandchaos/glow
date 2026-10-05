import React, { useEffect, useState } from 'react';
import { Alert, StatusBar } from 'react-native';
import BootSplash from 'react-native-bootsplash';
import {
  SafeAreaProvider,
  initialWindowMetrics,
} from 'react-native-safe-area-context';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { RootDrawer } from './src/screens/RootDrawer';
import { startAppSession } from './src/state/appSession';
import { ChatStoreContext } from './src/state/chatStore';
import type { ChatStore } from './src/state/chatView';

function App() {
  const [store, setStore] = useState<ChatStore | null>(null);
  useEffect(() => {
    const start = (): void => {
      startAppSession().then(setStore, () => {
        void BootSplash.hide({ fade: true });
        Alert.alert('Something went wrong', 'Your chats could not be opened.', [
          { text: 'Retry', onPress: start },
        ]);
      });
    };
    start();
  }, []);

  return (
    <SafeAreaProvider initialMetrics={initialWindowMetrics}>
      <KeyboardProvider>
        <StatusBar barStyle="light-content" backgroundColor="transparent" />
        {store ? (
          <ChatStoreContext value={store}>
            <RootDrawer />
          </ChatStoreContext>
        ) : null}
      </KeyboardProvider>
    </SafeAreaProvider>
  );
}

export default App;
