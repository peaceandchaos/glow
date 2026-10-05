import { registerHooks } from 'node:module';

// The server sources use extensionless relative imports for their bundler.
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (/^[./]/u.test(specifier) && !/\.[cm]?[jt]s$/u.test(specifier))
        return next(`${specifier}.ts`, context);
      throw error;
    }
  },
});
