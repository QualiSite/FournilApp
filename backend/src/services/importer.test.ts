/**
 * Tests de services/importer.ts (applyImport).
 *
 * On simule Prisma avec un faux client en mémoire plutôt que d'ouvrir une
 * vraie base : ce qu'on veut vérifier ici, c'est le câblage (ordre des
 * suppressions, correspondance pâte → recette/produit, repli sur arrondiFor,
 * contenu du rapport d'import), pas le SGBD lui-même.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ImportModel, ValidationResult } from '../import/extract.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const { tx, state, resetState } = vi.hoisted(() => {
  const state = {
    pate: [] as any[],
    recette: [] as any[],
    produit: [] as any[],
    commande: [] as any[],
    importData: null as any,
    deletedInOrder: [] as string[],
  };
  let pateId = 0;
  let recetteId = 0;
  let produitId = 0;

  function resetState() {
    state.pate = [];
    state.recette = [];
    state.produit = [];
    state.commande = [];
    state.importData = null;
    state.deletedInOrder = [];
    pateId = 0;
    recetteId = 0;
    produitId = 0;
  }

  const tx = {
    commande: {
      deleteMany: async () => {
        state.deletedInOrder.push('commande');
        return { count: 0 };
      },
      createMany: async ({ data }: any) => {
        state.commande.push(...data);
        return { count: data.length };
      },
    },
    recetteLigne: {
      deleteMany: async () => {
        state.deletedInOrder.push('recetteLigne');
        return { count: 0 };
      },
    },
    recette: {
      deleteMany: async () => {
        state.deletedInOrder.push('recette');
        return { count: 0 };
      },
      create: async ({ data }: any) => {
        recetteId++;
        state.recette.push(data);
        return { id: recetteId, ...data };
      },
    },
    produit: {
      deleteMany: async () => {
        state.deletedInOrder.push('produit');
        return { count: 0 };
      },
      create: async ({ data }: any) => {
        produitId++;
        const row = { id: produitId, ...data };
        state.produit.push(row);
        return row;
      },
    },
    pate: {
      deleteMany: async () => {
        state.deletedInOrder.push('pate');
        return { count: 0 };
      },
      create: async ({ data }: any) => {
        pateId++;
        const row = { id: pateId, ...data };
        state.pate.push(row);
        return row;
      },
    },
    import: {
      create: async ({ data }: any) => {
        state.importData = data;
        return { id: 1, ...data };
      },
    },
  };

  return { tx, state, resetState };
});

vi.mock('../db.js', () => ({
  prisma: {
    $transaction: (fn: (tx: unknown) => unknown) => fn(tx),
  },
}));

const { applyImport } = await import('./importer.js');

beforeEach(() => {
  resetState();
});

const fakeValidation: ValidationResult = {
  totalFormulas: 10,
  evaluated: 10,
  matches: 10,
  mismatches: [],
  parseErrors: 0,
};

function buildModel(overrides: Partial<ImportModel> = {}): ImportModel {
  return {
    jours: ['Lundi', 'Mardi'],
    produits: [{ nom: 'Baguette', pate: 'Levain', qte: [10, 5], poidsPate: 300, garniture: 0 }],
    recettes: [
      {
        pate: 'Levain',
        feuille: 'Levain',
        base: 1000,
        lignes: [
          { ingredient: 'Farine', quantite: 600, arrondi: 50 },
          { ingredient: 'Sel', quantite: 20, arrondi: 20 },
        ],
      },
    ],
    report: { ok: ['ok'], warn: [] },
    ...overrides,
  };
}

describe('applyImport', () => {
  it('vide le référentiel dans le bon ordre (contraintes de clé étrangère)', async () => {
    await applyImport(buildModel(), 'classeur.xlsx', fakeValidation, 42);
    expect(state.deletedInOrder).toEqual([
      'commande',
      'recetteLigne',
      'recette',
      'produit',
      'pate',
    ]);
  });

  it('crée une pâte par nom unique, puis ses recettes et produits', async () => {
    await applyImport(buildModel(), 'classeur.xlsx', fakeValidation, 42);
    expect(state.pate).toHaveLength(1);
    expect(state.pate[0].nom).toBe('Levain');
    expect(state.recette[0].base).toBe(1000);
    expect(state.recette[0].pateId).toBe(state.pate[0].id);
    expect(state.produit[0].nom).toBe('Baguette');
    expect(state.produit[0].pateId).toBe(state.pate[0].id);
  });

  it('crée une commande par jour pour chaque produit', async () => {
    await applyImport(buildModel(), 'classeur.xlsx', fakeValidation, 42);
    expect(state.commande).toHaveLength(2);
    expect(state.commande.map((c: any) => c.quantite)).toEqual([10, 5]);
    expect(state.commande.every((c: any) => c.produitId === state.produit[0].id)).toBe(true);
  });

  it("utilise arrondiFor comme repli quand une ligne de recette n'a pas d'arrondi explicite", async () => {
    const model = buildModel({
      recettes: [
        {
          pate: 'Levain',
          feuille: 'Levain',
          base: 20,
          lignes: [
            { ingredient: 'Sel', quantite: 20, arrondi: undefined as unknown as number },
            { ingredient: 'Levure', quantite: 10, arrondi: undefined as unknown as number },
          ],
        },
      ],
    });
    await applyImport(model, 'classeur.xlsx', fakeValidation, 1);
    const lignes = state.recette[0].lignes.create;
    expect(lignes.find((l: any) => l.ingredient === 'Sel').arrondi).toBe(20);
    expect(lignes.find((l: any) => l.ingredient === 'Levure').arrondi).toBe(5);
  });

  it('ignore un produit sans pâte assignée (pas de section détectée à l’import)', async () => {
    const model = buildModel({
      produits: [
        { nom: 'Baguette', pate: 'Levain', qte: [10, 5], poidsPate: 300, garniture: 0 },
        { nom: 'Orphelin', pate: null, qte: [1, 1], poidsPate: 100, garniture: 0 },
      ],
    });
    await applyImport(model, 'classeur.xlsx', fakeValidation, 1);
    expect(state.produit).toHaveLength(1);
    expect(state.produit[0].nom).toBe('Baguette');
  });

  it('ignore une recette dont la pâte ne correspond à aucun produit', async () => {
    const model = buildModel({
      recettes: [
        {
          pate: 'Levain',
          feuille: 'Levain',
          base: 1000,
          lignes: [{ ingredient: 'Farine', quantite: 600, arrondi: 50 }],
        },
        {
          pate: 'Fantome',
          feuille: 'Fantome',
          base: 500,
          lignes: [{ ingredient: 'Farine', quantite: 300, arrondi: 50 }],
        },
      ],
    });
    await applyImport(model, 'classeur.xlsx', fakeValidation, 1);
    expect(state.recette).toHaveLength(1);
    expect(state.recette[0].base).toBe(1000);
  });

  it("enregistre l'import avec le rapport, la validation et l'auteur", async () => {
    await applyImport(buildModel(), 'classeur.xlsx', fakeValidation, 42);
    expect(state.importData.fileName).toBe('classeur.xlsx');
    expect(state.importData.importedById).toBe(42);
    expect(state.importData.rapport).toEqual({
      ok: ['ok'],
      warn: [],
      validation: fakeValidation,
    });
  });
});
