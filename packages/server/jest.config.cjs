module.exports = {
  testEnvironment: 'node',
  modulePathIgnorePatterns: [
    '<rootDir>/.output/',
    '<rootDir>/.vercel/',
    '<rootDir>/.nitro/',
  ],
  testMatch: ['<rootDir>/tests/**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': [
      'babel-jest',
      {
        babelrc: false,
        configFile: false,
        presets: [
          [
            '@babel/preset-env',
            {
              targets: { node: 'current' },
              exclude: ['transform-dynamic-import'],
            },
          ],
        ],
        plugins: ['@babel/plugin-transform-typescript'],
      },
    ],
  },
};
