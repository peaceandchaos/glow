module.exports = {
  rootDir: '..',
  testEnvironment: 'node',
  modulePathIgnorePatterns: [
    '<rootDir>/packages/server/.output/',
    '<rootDir>/packages/server/.vercel/',
    '<rootDir>/packages/server/.nitro/',
  ],
  testMatch: ['<rootDir>/tools/__tests__/**/*.test.js'],
};
