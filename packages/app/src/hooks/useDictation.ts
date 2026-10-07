import { useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { z } from 'zod';
import { dictation } from '../dictation';

type DictationControl = {
  listening: boolean;
  toggle: (onText: (text: string) => void) => Promise<void>;
};

// Dictation.m rejects a missing audio input with this exact sentence.
const noMicrophone = 'No microphone is available right now.';
const nativeRejection = z.object({ code: z.string(), message: z.string() });

function failureMessage(
  rejection: z.infer<typeof nativeRejection> | undefined,
): string {
  if (rejection?.code === 'denied')
    return 'Allow microphone and speech access in Settings.';
  if (rejection?.message === noMicrophone) return noMicrophone;
  return 'Dictation stopped. Try again.';
}

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
        failureMessage(nativeRejection.safeParse(error).data),
      );
    }
  };

  return { listening, toggle };
}
