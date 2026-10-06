import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import BootSplash from 'react-native-bootsplash';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { signInWithApple, type Account } from '../account';
import { Icon } from '../components/Icon';
import { theme } from '../theme';

type Phase =
  | { kind: 'ready' }
  | { kind: 'requesting' }
  | { kind: 'failed'; message: string };

type SignInScreenProps = { onSignedIn: (account: Account) => void };

// A black capsule with Apple's logo and the title in white.
const appleBlack = '#000000';
const appleWhite = '#FFFFFF';
const HEIGHT = 44;

export function SignInScreen({ onSignedIn }: SignInScreenProps) {
  const insets = useSafeAreaInsets();
  const [phase, setPhase] = useState<Phase>({ kind: 'ready' });
  const requesting = phase.kind === 'requesting';

  const signIn = async () => {
    setPhase({ kind: 'requesting' });
    const result = await signInWithApple();
    switch (result.kind) {
      case 'signedIn':
        onSignedIn(result.account);
        return;
      case 'cancelled':
        setPhase({ kind: 'ready' });
        return;
      case 'failed':
        setPhase({ kind: 'failed', message: result.message });
        return;
      default: {
        const unhandled: never = result;
        return unhandled;
      }
    }
  };

  return (
    <View style={[styles.container, { paddingBottom: insets.bottom + 8 }]}>
      <BootSplash.HideOnDraw fade />
      <View style={styles.errorLine}>
        {phase.kind === 'failed' ? (
          <Text style={styles.error} numberOfLines={1}>
            {phase.message}
          </Text>
        ) : null}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Sign in with Apple"
        accessibilityState={{ disabled: requesting, busy: requesting }}
        disabled={requesting}
        onPress={() => void signIn()}
        style={({ pressed }) => [
          styles.button,
          (pressed || requesting) && styles.dimmed,
        ]}
      >
        <Icon name="applelogo" size={17} color={appleWhite} />
        <Text style={styles.label}>Sign in with Apple</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'flex-end',
    paddingHorizontal: 16,
    backgroundColor: theme.background,
  },
  errorLine: {
    minHeight: 20,
    marginBottom: 12,
    alignItems: 'center',
  },
  error: {
    color: theme.textSecondary,
    fontSize: 15,
  },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    minHeight: HEIGHT,
    borderRadius: HEIGHT / 2,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: appleBlack,
  },
  dimmed: {
    opacity: 0.6,
  },
  label: {
    color: appleWhite,
    fontSize: 17,
    fontWeight: '600',
  },
});
