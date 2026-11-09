import { PasswordService } from './password.service.js';

describe('PasswordService', () => {
  const service = new PasswordService();

  beforeAll(() => service.onModuleInit());

  it('hashes with argon2id using the configured parameters, with a unique salt each time', async () => {
    const [a, b] = await Promise.all([service.hash('correct horse'), service.hash('correct horse')]);

    expect(a).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(a).not.toBe(b);
  });

  it('verifies the right password and rejects a wrong one', async () => {
    const hash = await service.hash('correct horse');

    await expect(service.verify(hash, 'correct horse')).resolves.toBe(true);
    await expect(service.verify(hash, 'wrong horse')).resolves.toBe(false);
  });

  it('always fails when there is no account, and when the stored hash is malformed', async () => {
    await expect(service.verify(null, 'anything')).resolves.toBe(false);
    await expect(service.verify('not-a-hash', 'anything')).resolves.toBe(false);
  });
});
