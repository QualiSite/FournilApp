/**
 * Tests de auth/session.ts avec un faux Prisma en mémoire.
 * Point central à vérifier : le token brut retourné au client n'est jamais
 * ce qui est stocké en base (voir la tâche "hasher les tokens de session").
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash } from 'node:crypto';

/* eslint-disable @typescript-eslint/no-explicit-any */

const { store, users } = vi.hoisted(() => {
  const store = new Map<string, { id: string; userId: number; expiresAt: Date }>();
  const users = new Map<number, { id: number; email: string; nom: string }>([
    [1, { id: 1, email: 'boulanger@fournil.test', nom: 'Ana' }],
  ]);
  return { store, users };
});

vi.mock('../db.js', () => ({
  prisma: {
    session: {
      create: async ({ data }: any) => {
        store.set(data.id, { id: data.id, userId: data.userId, expiresAt: data.expiresAt });
        return data;
      },
      findUnique: async ({ where: { id } }: any) => {
        const s = store.get(id);
        if (!s) return null;
        return { ...s, user: users.get(s.userId) ?? null };
      },
      delete: async ({ where: { id } }: any) => {
        if (!store.has(id)) throw new Error('Session introuvable');
        store.delete(id);
      },
    },
  },
}));

import { createSession, validateSession, deleteSession } from './session.js';

beforeEach(() => {
  store.clear();
});

function hashOf(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

describe('createSession', () => {
  it('ne stocke jamais le token brut en base, seulement son empreinte', async () => {
    const { id: token } = await createSession(1);
    expect(store.has(token)).toBe(false); // le token brut n'est pas une clé en base
    expect(store.has(hashOf(token))).toBe(true); // seul son hash y est
  });

  it("renvoie une date d'expiration future", async () => {
    const { expiresAt } = await createSession(1);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});

describe('validateSession', () => {
  it('retrouve la session et l’utilisateur pour un token valide', async () => {
    const { id: token } = await createSession(1);
    const session = await validateSession(token);
    expect(session).not.toBeNull();
    expect(session!.user.email).toBe('boulanger@fournil.test');
  });

  it('renvoie null pour un token inconnu', async () => {
    await createSession(1);
    expect(await validateSession('un-token-invente')).toBeNull();
  });

  it('renvoie null et purge une session expirée', async () => {
    const { id: token } = await createSession(1);
    // Manipule directement le faux store pour simuler l'expiration.
    store.set(hashOf(token), { id: hashOf(token), userId: 1, expiresAt: new Date(Date.now() - 1000) });

    expect(await validateSession(token)).toBeNull();
    expect(store.has(hashOf(token))).toBe(false); // purgée
  });
});

describe('deleteSession', () => {
  it('invalide un token existant', async () => {
    const { id: token } = await createSession(1);
    await deleteSession(token);
    expect(await validateSession(token)).toBeNull();
  });

  it("n'échoue pas silencieusement sur un token déjà absent", async () => {
    await expect(deleteSession('token-jamais-cree')).resolves.not.toThrow();
  });
});
