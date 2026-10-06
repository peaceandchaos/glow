import { createContext } from 'react';

// The signed-in app's sign-out action. Outside the app (a screen rendered on
// its own) there is no account, so the default does nothing.
export const SignOutContext = createContext<() => void>(() => undefined);
