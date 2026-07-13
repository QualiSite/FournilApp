/**
 * Tests d'intégration des routes Express (backend/src/app.ts), via supertest.
 *
 * Prisma est entièrement simulé en mémoire (voir vi.mock('./db.js', ...)) :
 * on ne teste pas ici le SGBD, mais le câblage HTTP réel — auth requise,
 * codes de statut, validations d'entrée — en passant par le vrai pipeline
 * Express (helmet, cors, requireAuth, etc.), pas des mocks de handlers.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

/* eslint-disable @typescript-eslint/no-explicit-any */

const { db, resetDb } = vi.hoisted(() => {
  const db = {
    users: [] as any[],
    sessions: new Map<string, { id: string; userId: number; expiresAt: Date }>(),
    pates: [] as any[],
    produits: [] as any[],
    recettes: [] as any[],
  };
  function resetDb() {
    db.users = [];
    db.sessions.clear();
    db.pates = [];
    db.produits = [];
    db.recettes = [];
  }
  return { db, resetDb };
});

vi.mock('./db.js', () => ({
  prisma: {
    user: {
      findUnique: async ({ where: { email } }: any) =>
        db.users.find((u) => u.email === email) ?? null,
    },
    session: {
      create: async ({ data }: any) => {
        db.sessions.set(data.id, { id: data.id, userId: data.userId, expiresAt: data.expiresAt });
        return data;
      },
      findUnique: async ({ where: { id } }: any) => {
        const s = db.sessions.get(id);
        if (!s) return null;
        return { ...s, user: db.users.find((u) => u.id === s.userId) ?? null };
      },
      delete: async ({ where: { id } }: any) => {
        db.sessions.delete(id);
      },
    },
    pate: {
      findMany: async () => db.pates,
    },
    produit: {
      findMany: async () => db.produits,
    },
    recette: {
      findMany: async () => db.recettes,
    },
    commande: {
      upsert: async ({ create }: any) => ({ id: 1, ...create }),
    },
    import: {
      findMany: async () => [],
    },
    $transaction: async (fn: (tx: unknown) => unknown) => {
      const tx = {
        commande: { deleteMany: async () => ({ count: 0 }) },
        recetteLigne: { deleteMany: async () => ({ count: 0 }) },
        recette: { deleteMany: async () => ({ count: db.recettes.length }) },
        produit: { deleteMany: async () => ({ count: db.produits.length }) },
        pate: { deleteMany: async () => ({ count: db.pates.length }) },
      };
      return fn(tx);
    },
  },
}));

const { app } = await import('./app.js');
const { hashPassword } = await import('./auth/password.js');

const EMAIL = 'boulanger@fournil.test';
const PASSWORD = 'mot-de-passe-de-test-suffisamment-long';

async function login() {
  const res = await request(app).post('/api/auth/login').send({ email: EMAIL, password: PASSWORD });
  return res.body.token as string;
}

beforeEach(async () => {
  resetDb();
  db.users.push({ id: 1, email: EMAIL, password: await hashPassword(PASSWORD), nom: 'Ana' });
});

describe('GET /health', () => {
  it("répond 200 sans authentification", async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

describe('POST /api/auth/login', () => {
  it('refuse un corps incomplet (400)', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: EMAIL });
    expect(res.status).toBe(400);
  });

  it('refuse un mauvais mot de passe (401)', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: EMAIL, password: 'mauvais-mot-de-passe' });
    expect(res.status).toBe(401);
  });

  it('refuse un email inconnu (401, même message que mot de passe incorrect)', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'inconnu@fournil.test', password: PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Identifiants invalides');
  });

  it('renvoie un token pour des identifiants valides', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: EMAIL, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
    expect(res.body.user).toMatchObject({ email: EMAIL, nom: 'Ana' });
  });
});

describe('routes protégées', () => {
  it('GET /api/auth/me sans token → 401', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('GET /api/auth/me avec un token invalide → 401', async () => {
    const res = await request(app).get('/api/auth/me').set('Authorization', 'Bearer nimportequoi');
    expect(res.status).toBe(401);
  });

  it('GET /api/auth/me avec un token valide → 200 + utilisateur courant', async () => {
    const token = await login();
    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.email).toBe(EMAIL);
  });

  it('GET /api/commandes sans token → 401', async () => {
    const res = await request(app).get('/api/commandes');
    expect(res.status).toBe(401);
  });

  it('GET /api/commandes avec token → 200', async () => {
    const token = await login();
    const res = await request(app).get('/api/commandes').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('POST /api/auth/logout invalide le token (accès suivant refusé)', async () => {
    const token = await login();
    await request(app).post('/api/auth/logout').set('Authorization', `Bearer ${token}`).expect(200);
    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });
});

describe('PUT /api/commandes', () => {
  it('rejette un corps invalide (400)', async () => {
    const token = await login();
    const res = await request(app)
      .put('/api/commandes')
      .set('Authorization', `Bearer ${token}`)
      .send({ produitId: 1, jour: 9, quantite: 5 }); // jour hors 0-6
    expect(res.status).toBe(400);
  });

  it('accepte un corps valide (200)', async () => {
    const token = await login();
    const res = await request(app)
      .put('/api/commandes')
      .set('Authorization', `Bearer ${token}`)
      .send({ produitId: 1, jour: 2, quantite: 5 });
    expect(res.status).toBe(200);
  });
});

describe('GET /api/production/:jour', () => {
  it('404 sur un jour inconnu', async () => {
    const token = await login();
    const res = await request(app)
      .get('/api/production/samedimanche')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it('200 sur un jour valide', async () => {
    const token = await login();
    const res = await request(app)
      .get('/api/production/lundi')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.jour).toBe('lundi');
  });
});

describe('POST /api/admin/reset-data', () => {
  it('refuse sans confirmation exacte (400)', async () => {
    const token = await login();
    const res = await request(app)
      .post('/api/admin/reset-data')
      .set('Authorization', `Bearer ${token}`)
      .send({ confirm: 'oui' });
    expect(res.status).toBe(400);
  });

  it('purge le référentiel avec la confirmation exacte', async () => {
    const token = await login();
    const res = await request(app)
      .post('/api/admin/reset-data')
      .set('Authorization', `Bearer ${token}`)
      .send({ confirm: 'SUPPRIMER' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('route inconnue', () => {
  it("404 avec un message dédié (hors /api, pour ne pas passer par requireAuth d'abord)", async () => {
    const res = await request(app).get('/cette-route-n-existe-pas');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Route inconnue');
  });

  it("une route /api/* inconnue exige quand même l'authentification en premier (401)", async () => {
    const res = await request(app).get('/api/route-qui-n-existe-pas');
    expect(res.status).toBe(401);
  });
});
