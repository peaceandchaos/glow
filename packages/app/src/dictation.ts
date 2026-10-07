import {
  NativeEventEmitter,
  TurboModuleRegistry,
  type TurboModule,
} from 'react-native';

interface NativeDictation extends TurboModule {
  start(): Promise<void>;
  stop(): void;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export type Dictation = {
  // Rejects when permission is denied or the recognizer is unavailable.
  start(): Promise<void>;
  stop(): void;
  // `onText` gets the whole transcript so far; `onEnd` fires once per start.
  listen(onText: (text: string) => void, onEnd: () => void): () => void;
};

function bind(module: NativeDictation): Dictation {
  const events = new NativeEventEmitter(module);
  return {
    start: () => module.start(),
    stop: () => module.stop(),
    listen: (onText, onEnd) => {
      const subscriptions = [
        events.addListener('dictationText', onText),
        events.addListener('dictationEnd', onEnd),
      ];
      return () => subscriptions.forEach(subscription => subscription.remove());
    },
  };
}

const native = TurboModuleRegistry.get<NativeDictation>('Dictation');

// Null where the app has no native module, such as on Android.
export const dictation = native ? bind(native) : null;
