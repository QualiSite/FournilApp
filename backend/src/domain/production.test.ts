/**
 * Tests de la logique métier de production (backend/src/domain/production.ts).
 * fichesDuJour est une fonction pure : regroupement par pâte, coefficient
 * (totalPate / base recette), pesées arrondies.
 */
import { describe, it, expect } from 'vitest';
import { fichesDuJour, type ProduitJour, type LigneRecette } from './production.js';
import { ceilTo } from '../engine/engine.js';

function recette(base: number, lignes: LigneRecette[]) {
  return { base, lignes };
}

describe('fichesDuJour', () => {
  it('regroupe les produits par pâte et calcule le total de pâte', () => {
    const produits: ProduitJour[] = [
      { id: 1, nom: 'Baguette', pate: 'Levain', quantite: 2, poidsPate: 300 },
      { id: 2, nom: 'Pain', pate: 'Levain', quantite: 1, poidsPate: 400 },
    ];
    const recettes = new Map([['Levain', recette(1000, [])]]);

    const fiches = fichesDuJour(produits, recettes);
    expect(fiches).toHaveLength(1);
    expect(fiches[0].pate).toBe('Levain');
    expect(fiches[0].totalPate).toBe(1000); // 2*300 + 1*400
    expect(fiches[0].coef).toBe(1); // 1000 / base(1000)
    expect(fiches[0].detail).toEqual([
      { nom: 'Baguette', quantite: 2, totalPate: 600 },
      { nom: 'Pain', quantite: 1, totalPate: 400 },
    ]);
  });

  it('ignore les produits sans commande (quantite = 0)', () => {
    const produits: ProduitJour[] = [
      { id: 1, nom: 'Baguette', pate: 'Levain', quantite: 0, poidsPate: 300 },
    ];
    const fiches = fichesDuJour(produits, new Map());
    expect(fiches).toHaveLength(0);
  });

  it('ignore les produits sans poids unitaire rapproché (poidsPate = 0)', () => {
    const produits: ProduitJour[] = [
      { id: 1, nom: 'Baguette', pate: 'Levain', quantite: 5, poidsPate: 0 },
    ];
    const fiches = fichesDuJour(produits, new Map());
    expect(fiches).toHaveLength(0);
  });

  it("renvoie un coefficient et une pesée nuls si aucune recette n'est associée à la pâte", () => {
    const produits: ProduitJour[] = [
      { id: 1, nom: 'Baguette', pate: 'Inconnue', quantite: 2, poidsPate: 300 },
    ];
    const fiches = fichesDuJour(produits, new Map());
    expect(fiches[0].coef).toBeNull();
    expect(fiches[0].pesee).toEqual([]);
    expect(fiches[0].totalPate).toBe(600);
  });

  it('met les quantités de la recette à l’échelle et arrondit chaque ingrédient à son pas', () => {
    const produits: ProduitJour[] = [
      { id: 1, nom: 'Baguette', pate: 'Levain', quantite: 1, poidsPate: 650 },
    ];
    const lignes: LigneRecette[] = [
      { ingredient: 'Farine', quantite: 600, arrondi: 50 },
      { ingredient: 'Sel', quantite: 20, arrondi: 20 },
    ];
    const recettes = new Map([['Levain', recette(1000, lignes)]]);

    const fiches = fichesDuJour(produits, recettes);
    const coef = 650 / 1000; // 0.65
    expect(fiches[0].coef).toBe(coef);
    expect(fiches[0].pesee).toEqual([
      { ingredient: 'Farine', grammes: ceilTo(600 * coef, 50) }, // 390 → 400
      { ingredient: 'Sel', grammes: ceilTo(20 * coef, 20) }, // 13 → 20
    ]);
    expect(fiches[0].pesee[0].grammes).toBe(400);
    expect(fiches[0].pesee[1].grammes).toBe(20);
  });

  it('traite plusieurs pâtes indépendamment', () => {
    const produits: ProduitJour[] = [
      { id: 1, nom: 'Baguette', pate: 'Levain', quantite: 2, poidsPate: 300 },
      { id: 2, nom: 'Pain Campagne', pate: 'Campagne', quantite: 3, poidsPate: 400 },
    ];
    const recettes = new Map([
      ['Levain', recette(600, [])],
      ['Campagne', recette(1200, [])],
    ]);

    const fiches = fichesDuJour(produits, recettes);
    expect(fiches).toHaveLength(2);
    const levain = fiches.find((f) => f.pate === 'Levain')!;
    const campagne = fiches.find((f) => f.pate === 'Campagne')!;
    expect(levain.totalPate).toBe(600);
    expect(levain.coef).toBe(1);
    expect(campagne.totalPate).toBe(1200);
    expect(campagne.coef).toBe(1);
  });
});
