import { Alert } from 'react-native';

// Several controls in this demo (Camera, Files, chat history, settings) are UI
// only. Rather than a silent no-op, tell the user the feature isn't built so
// taps aren't mistaken for a bug
export function showNotImplemented() {
  Alert.alert(
    'Demo app',
    "This is a demo app and this feature wasn't implemented.",
  );
}
