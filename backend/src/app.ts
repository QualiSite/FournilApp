/**
 * API Fournil — Express + Node.js.
 *
 * Ce module construit et exporte l'application Express, sans démarrer le
 * serveur HTTP (voir index.ts). Séparé ainsi pour permettre aux tests
 * d'intégration (supertest) d'importer `app` directement, sans écouter de
 * port réel.
 *
 * Routes :
 *   GET  /health                    — sonde de vie (Coolify)
 *   POST /api/auth/login            — { email, password } → { token, expiresAt, user }
 *   POST /api/auth/logout           — invalide le token (Authorization: Bearer ...)
 *   GET  /api/auth/me               — utilisateur courant (protégé)
 *   POST /api/import                — injection d'un classeur xlsx (multipart, champ "file",
 *                                      champs optionnels "commandesSheet"/"poidsSheet") — protégé
 *   POST /api/import/analyze        — classification IA des feuilles d'un classeur non
 *                                      reconnu (multipart, champ "file") — protégé, à la demande
 *   GET  /api/imports               — historique des injections (rapports) — protégé
 *   POST /api/admin/reset-data      — { confirm: "SUPPRIMER" } → vide Pate/Recette/RecetteLigne/
 *                                      Produit/Commande (jamais User/Session/Import) — protégé
 *   GET  /api/commandes             — pâtes → produits → quantités par jour — protégé
 *   PUT  /api/commandes             — { produitId, jour, quantite } — protégé
 *   GET  /api/production/:jour      — fiches du jour (regroupées par pâte, pesées arrondies) — protégé
 *   GET  /api/recettes              — recettes en lecture seule — protégé
 *   GET  /api/poids                 — poids unitaires + produits non rapprochés — protégé
 *
 * Toutes les routes /api/* sauf /api/auth/login exigent un token de session
 * (Authorization: Bearer <token>), obtenu via /api/auth/login. Voir requireAuth.
 */

import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import * as XLSX from 'xlsx';
import { prisma } from './db.js';
import { extractModel, validateImport } from './import/extract.js';
import { applyImport } from './services/importer.js';
import { fichesDuJour } from './domain/production.js';
import { verifyPassword, DUMMY_PASSWORD_HASH } from './auth/password.js';
import { createSession, deleteSession } from './auth/session.js';
import { requireAuth } from './middleware/require-auth.js';
import { classifyWorkbook } from './ai/classify-workbook.js';

const JOURS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];

export const app = express();

// API pure sans pages HTML servies : CSP par défaut désactivée (pas de contenu
// à protéger contre l'injection), mais on garde les autres en-têtes de sécurité
// (X-Content-Type-Options, X-Frame-Options, etc.). CORP en cross-origin, sinon
// le frontend (autre origine) ne pourrait plus consommer l'API.
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);

// CORS fermé par défaut : sans CORS_ORIGIN explicite, aucune origine n'est autorisée
// (mieux vaut un déploiement mal configuré qui bloque tout qu'un qui accepte tout).
const corsOrigins = process.env.CORS_ORIGIN?.split(',')
  .map((o) => o.trim())
  .filter(Boolean);
if (!corsOrigins?.length) {
  console.warn('CORS_ORIGIN non défini : aucune origine cross-origin ne sera autorisée.');
}
app.use(cors({ origin: corsOrigins?.length ? corsOrigins : false }));
app.use(express.json());

// multer en mémoire : le xlsx est lu directement depuis le buffer, jamais écrit sur disque
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// Anti brute-force sur le login : 10 tentatives / 15 min par IP, tous statuts confondus.
// Compte aussi les succès (standard pour ce type de garde-fou) pour rester simple à auditer.
// Désactivé en test (NODE_ENV=test, positionné automatiquement par Vitest) : sinon les
// nombreux appels de connexion des tests d'intégration finiraient par se faire bloquer
// entre eux, puisque le compteur est partagé pour toute la durée du fichier de test.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  message: { error: 'Trop de tentatives de connexion. Réessaie dans quelques minutes.' },
});

/** Enveloppe les handlers async pour propager les erreurs au middleware d'erreur
 *  (Express 4 ne le fait pas tout seul, contrairement à Express 5). */
const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

/* ---------------- Santé ---------------- */

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

/* ---------------- Auth ---------------- */

app.post(
  '/api/auth/login',
  loginLimiter,
  wrap(async (req, res) => {
    const { email, password } = (req.body ?? {}) as { email?: unknown; password?: unknown };
    if (typeof email !== 'string' || typeof password !== 'string') {
      res.status(400).json({ error: 'email et password requis' });
      return;
    }

    const user = await prisma.user.findUnique({ where: { email } });
    // On appelle toujours verifyPassword, même si l'utilisateur n'existe pas
    // (contre un hash leurre), pour que le temps de réponse ne révèle pas
    // quels emails ont un compte (voir DUMMY_PASSWORD_HASH).
    const ok = await verifyPassword(user?.password ?? DUMMY_PASSWORD_HASH, password);
    if (!user || !ok) {
      res.status(401).json({ error: 'Identifiants invalides' });
      return;
    }

    const { id, expiresAt } = await createSession(user.id);
    res.json({
      token: id,
      expiresAt,
      user: { id: user.id, email: user.email, nom: user.nom },
    });
  })
);

// Tout ce qui suit sous /api/* exige une session valide.
app.use('/api', requireAuth);

app.post(
  '/api/auth/logout',
  wrap(async (req, res) => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (token) await deleteSession(token);
    res.json({ ok: true });
  })
);

app.get('/api/auth/me', (req, res) => {
  res.json(req.user);
});

/* ---------------- Import ---------------- */

app.post(
  '/api/import',
  upload.single('file'),
  wrap(async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: 'Fichier manquant (champ "file")' });
      return;
    }

    const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellFormula: true });

    const { commandesSheet, poidsSheet } = (req.body ?? {}) as {
      commandesSheet?: string;
      poidsSheet?: string;
    };

    let model;
    try {
      model = extractModel(wb, { commandesSheet, poidsSheet });
    } catch (e) {
      // Échec de reconnaissance structurelle (feuille introuvable, etc.) :
      // on le signale distinctement pour que le front propose l'analyse IA.
      res.status(422).json({
        error: e instanceof Error ? e.message : 'Structure du classeur non reconnue.',
        needsAiHelp: true,
      });
      return;
    }
    const validation = validateImport(wb);

    // garde-fou : si le moteur ne reproduit pas les valeurs Excel, on refuse
    const ratio = validation.evaluated ? validation.matches / validation.evaluated : 1;
    if (ratio < 0.95) {
      res.status(422).json({
        error: `Validation échouée : ${validation.matches}/${validation.evaluated} formules reproduites. Classeur inattendu ?`,
        validation,
      });
      return;
    }

    const imported = await applyImport(model, req.file.originalname, validation, req.user!.id);
    res.json({ importId: imported.id, report: model.report, validation });
  })
);

app.post(
  '/api/import/analyze',
  upload.single('file'),
  wrap(async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: 'Fichier manquant (champ "file")' });
      return;
    }
    const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellFormula: true });
    try {
      const sheets = await classifyWorkbook(wb);
      res.json({ sheets });
    } catch (e) {
      res.status(502).json({
        error: e instanceof Error ? e.message : "Échec de l'analyse IA.",
      });
    }
  })
);

app.get(
  '/api/imports',
  wrap(async (_req, res) => {
    res.json(
      await prisma.import.findMany({
        orderBy: { importedAt: 'desc' },
        take: 20,
        include: { importedBy: { select: { id: true, nom: true, email: true } } },
      })
    );
  })
);

/* ---------------- Administration ---------------- */

// Vide le référentiel (pâtes, recettes, produits, commandes) — jamais les
// comptes ni l'historique des imports. Exige une confirmation explicite dans
// le corps de la requête en plus de l'authentification, pour éviter qu'un
// appel accidentel (ou un script) ne déclenche la purge sans intention claire.
app.post(
  '/api/admin/reset-data',
  wrap(async (req, res) => {
    const { confirm } = (req.body ?? {}) as { confirm?: unknown };
    if (confirm !== 'SUPPRIMER') {
      res.status(400).json({ error: 'Confirmation manquante ou incorrecte.' });
      return;
    }

    const deleted = await prisma.$transaction(async (tx) => {
      const commandes = await tx.commande.deleteMany();
      const ligneRecettes = await tx.recetteLigne.deleteMany();
      const recettes = await tx.recette.deleteMany();
      const produits = await tx.produit.deleteMany();
      const pates = await tx.pate.deleteMany();
      return {
        commandes: commandes.count,
        ligneRecettes: ligneRecettes.count,
        recettes: recettes.count,
        produits: produits.count,
        pates: pates.count,
      };
    });

    res.json({ ok: true, deleted });
  })
);

/* ---------------- Commandes ---------------- */

app.get(
  '/api/commandes',
  wrap(async (_req, res) => {
    res.json(
      await prisma.pate.findMany({
        orderBy: { ordre: 'asc' },
        include: {
          produits: { orderBy: { ordre: 'asc' }, include: { commandes: true } },
        },
      })
    );
  })
);

app.put(
  '/api/commandes',
  wrap(async (req, res) => {
    const { produitId, jour, quantite } = (req.body ?? {}) as {
      produitId?: unknown;
      jour?: unknown;
      quantite?: unknown;
    };
    if (
      !Number.isInteger(produitId) ||
      !Number.isInteger(jour) ||
      (jour as number) < 0 ||
      (jour as number) > 6 ||
      typeof quantite !== 'number' ||
      quantite < 0
    ) {
      res.status(400).json({ error: 'produitId, jour (0-6) et quantite (≥0) requis' });
      return;
    }
    res.json(
      await prisma.commande.upsert({
        where: { produitId_jour: { produitId: produitId as number, jour: jour as number } },
        update: { quantite },
        create: { produitId: produitId as number, jour: jour as number, quantite },
      })
    );
  })
);

/* ---------------- Production ---------------- */

app.get(
  '/api/production/:jour',
  wrap(async (req, res) => {
    const jour = JOURS.indexOf(String(req.params.jour).toLowerCase());
    if (jour < 0) {
      res.status(404).json({ error: 'Jour inconnu' });
      return;
    }

    const produits = await prisma.produit.findMany({
      include: { pate: true, commandes: { where: { jour } } },
    });
    const recettes = await prisma.recette.findMany({
      include: { pate: true, lignes: { orderBy: { ordre: 'asc' } } },
    });

    const fiches = fichesDuJour(
      produits.map((p) => ({
        id: p.id,
        nom: p.nom,
        pate: p.pate.nom,
        quantite: p.commandes[0]?.quantite ?? 0,
        poidsPate: p.poidsPate ?? 0,
      })),
      new Map(recettes.map((r) => [r.pate.nom, { base: r.base, lignes: r.lignes }]))
    );

    res.json({ jour: req.params.jour, jours: JOURS, fiches });
  })
);

/* ---------------- Référentiels lecture seule ---------------- */

app.get(
  '/api/recettes',
  wrap(async (_req, res) => {
    res.json(
      await prisma.recette.findMany({
        include: { pate: true, lignes: { orderBy: { ordre: 'asc' } } },
        orderBy: { pate: { ordre: 'asc' } },
      })
    );
  })
);

app.get(
  '/api/poids',
  wrap(async (_req, res) => {
    res.json(await prisma.produit.findMany({ orderBy: { ordre: 'asc' }, include: { pate: true } }));
  })
);

/* ---------------- Gestion d'erreurs ---------------- */

// 404 par défaut
app.use((_req, res) => {
  res.status(404).json({ error: 'Route inconnue' });
});

// erreurs non attrapées (y compris celles remontées par wrap et multer)
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Erreur interne' });
});
