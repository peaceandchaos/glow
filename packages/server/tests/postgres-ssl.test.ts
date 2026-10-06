import { Client } from 'pg';
import { explicitSslMode, postgresDatabase } from '../src/database';

const unreachable = (sslmode: string) =>
  `postgres://glow:p%40ss%26word@127.0.0.1:1/glow?sslmode=${sslmode}&channel_binding=require`;

test.each(['prefer', 'require', 'verify-ca'])(
  'sslmode=%s is named verify-full and nothing else in the URL changes',
  sslmode => {
    expect(explicitSslMode(unreachable(sslmode))).toBe(
      unreachable('verify-full'),
    );
  },
);

test.each(['disable', 'no-verify', 'verify-full'])(
  'sslmode=%s stays as written',
  sslmode => {
    expect(explicitSslMode(unreachable(sslmode))).toBe(unreachable(sslmode));
  },
);

test('a URL without sslmode stays as written', () => {
  const url = 'postgres://glow@localhost:5432/glow';
  expect(explicitSslMode(url)).toBe(url);
});

test('connecting with sslmode=require prints no SSL-mode warning, which pg prints for the raw URL', async () => {
  const emitWarning = jest
    .spyOn(process, 'emitWarning')
    .mockImplementation(() => undefined);
  try {
    await expect(
      postgresDatabase(unreachable('require')).query('SELECT 1'),
    ).rejects.toHaveProperty('code', 'ECONNREFUSED');
    expect(emitWarning).not.toHaveBeenCalled();

    new Client({ connectionString: unreachable('require') });
    expect(emitWarning.mock.calls).toEqual([
      [expect.stringContaining("The SSL modes 'prefer', 'require'")],
    ]);
  } finally {
    emitWarning.mockRestore();
  }
});
