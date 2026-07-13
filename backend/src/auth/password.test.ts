import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, DUMMY_PASSWORD_HASH } from './password.js';

describe('hashPassword / verifyPassword', () => {
  it('un mot de passe haché se vérifie correctement', async () => {
    const hash = await hashPassword('mon-mot-de-passe-long');
    await expect(verifyPassword(hash, 'mon-mot-de-passe-long')).resolves.toBe(true);
  });

  it('rejette un mauvais mot de passe', async () => {
    const hash = await hashPassword('mon-mot-de-passe-long');
    await expect(verifyPassword(hash, 'un-autre-mot-de-passe')).resolves.toBe(false);
  });

  it('produit un hash différent à chaque appel (sel aléatoire)', async () => {
    const a = await hashPassword('même-mot-de-passe');
    const b = await hashPassword('même-mot-de-passe');
    expect(a).not.toBe(b);
  });

  it('produit un hash argon2id', async () => {
    const hash = await hashPassword('x');
    expect(hash.startsWith('$argon2id$')).toBe(true);
  });
});

describe('DUMMY_PASSWORD_HASH', () => {
  it('est un hash argon2id valide (utilisable par verifyPassword sans lever d’exception)', async () => {
    expect(DUMMY_PASSWORD_HASH.startsWith('$argon2id$')).toBe(true);
    await expect(verifyPassword(DUMMY_PASSWORD_HASH, 'nimporte-quoi')).resolves.toBe(false);
  });
});
