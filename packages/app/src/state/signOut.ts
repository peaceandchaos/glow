import { createContext } from 'react';

export const SignOutContext = createContext<() => void>(() => undefined);
