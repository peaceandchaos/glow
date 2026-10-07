import { useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { dictation } from '../dictation';

export type DictationControl = {
  listening: boolean;
  toggle: (onText: (text: string) => void) => Promise<void>;
};

export function useDictation(): DictationControl | null {
  const [listening, setListening] = useState(false);
  const unsubscribe = useRef<(() => void) | null>(null);

  useEffect(
    () => () => {
      if (!unsubscribe.current) return;
      unsubscribe.current();
      dictation?.stop();
    },
    [],
  );

  const native = dictation;
  if (!native) return null;

  const end = () => {
    unsubscribe.current?.();
    unsubscribe.current = null;
    setListening(false);
  };

  const toggle = async (onText: (text: string) => void) => {
    if (unsubscribe.current) {
      native.stop();
      return;
    }
    unsubscribe.current = native.listen(onText, end);
    setListening(true);
    try {
      await native.start();
    } catch (error) {
      end();
      Alert.alert(
        'Dictation is unavailable',
        error instanceof Error ? error.message : undefined,
      );
    }
  };

  return { listening, toggle };
}
