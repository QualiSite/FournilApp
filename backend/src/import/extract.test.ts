/**
 * Tests du pipeline d'extraction (backend/src/import/extract.ts).
 *
 * - normalize / fuzzyFind : rapprochement flou des noms (accents, articles, pluriels).
 * - arrondiFor : heuristique de pas de pesée par ingrédient.
 * - sheetToRows : conversion SheetJS → tableau de tableaux.
 * - extractModel : extraction du classeur (Commandes / Poids / Recettes) sur un
 *   classeur minimal construit en mémoire, sans dépendre d'un fichier .xlsx réel.
 */
import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { normalize, fuzzyFind, arrondiFor, sheetToRows, extractModel } from './extract.js';

describe('normalize', () => {
  it('met en minuscules et retire les accents', () => {
    expect(normalize('Maïs')).toBe('mais');
    expect(normalize('Pâté')).toBe('pate');
  });

  it('retire les articles isolés', () => {
    expect(normalize('Baguette au Levain')).toBe('baguette levain');
    expect(normalize('Tarte aux Pommes')).toBe('tarte pomme');
  });

  it('retire les pluriels simples', () => {
    expect(normalize('Croissants')).toBe('croissant');
  });

  it('gère les espaces multiples et en bout de chaîne', () => {
    expect(normalize('Maïs ')).toBe('mais');
    expect(normalize('Pain   complet')).toBe('pain complet');
  });
});

describe('fuzzyFind', () => {
  const candidates = ['Baguette levain', 'Pain Campagne', 'Gros Campagne'];

  it('trouve une correspondance exacte après normalisation', () => {
    expect(fuzzyFind('Baguette au Levain', candidates, (c) => c)).toBe('Baguette levain');
  });

  it("gère les variations d'articles et pluriels", () => {
    expect(fuzzyFind('Pains Campagnes', candidates, (c) => c)).toBe('Pain Campagne');
  });

  it('retourne null si rien ne correspond', () => {
    expect(fuzzyFind('Brioche', candidates, (c) => c)).toBeNull();
  });
});

describe('arrondiFor', () => {
  it('20g pour le sel', () => {
    expect(arrondiFor('Sel fin')).toBe(20);
  });

  it('5g pour la levure', () => {
    expect(arrondiFor('Levure fraîche')).toBe(5);
  });

  it('50g par défaut pour les autres ingrédients', () => {
    expect(arrondiFor('Farine T65')).toBe(50);
    expect(arrondiFor('Eau')).toBe(50);
  });

  it('est insensible à la casse et aux accents', () => {
    expect(arrondiFor('LEVURE')).toBe(5);
    expect(arrondiFor('Levûre')).toBe(5);
  });
});

describe('sheetToRows', () => {
  it('renvoie [] pour une feuille vide ou sans !ref', () => {
    expect(sheetToRows(undefined as unknown as XLSX.WorkSheet)).toEqual([]);
    expect(sheetToRows({} as XLSX.WorkSheet)).toEqual([]);
  });

  it('convertit une feuille en tableau de lignes', () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['Nom', 'Valeur'],
      ['Farine', 100],
    ]);
    expect(sheetToRows(ws)).toEqual([
      ['Nom', 'Valeur'],
      ['Farine', 100],
    ]);
  });
});

/* ---------------- extractModel sur un classeur minimal ---------------- */

function buildWorkbook() {
  const wb = XLSX.utils.book_new();

  const commandes = XLSX.utils.aoa_to_sheet([
    ['', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'],
    ['Levain'],
    ['Baguette au Levain', 10, 12, 0, 8, 15, 20, 5],
    ['Campagne'],
    ['Pain Campagne', 5, 5, 5, 5, 5, 5, 5],
  ]);
  XLSX.utils.book_append_sheet(wb, commandes, 'Commandes');

  const poids = XLSX.utils.aoa_to_sheet([
    ['Nom', "gr à l'unité", 'gr ss ing', 'garniture'],
    ['Baguette levain', 300, 280, 0],
    ['Pain Campagne', 400, 380, 20],
  ]);
  XLSX.utils.book_append_sheet(wb, poids, 'Poids');

  const levain = XLSX.utils.aoa_to_sheet([
    ['Farine', 1000],
    ['Eau', 650],
    ['Sel', 20],
    ['Levure', 10],
    ['Total', 1680],
  ]);
  XLSX.utils.book_append_sheet(wb, levain, 'Levain');

  const campagne = XLSX.utils.aoa_to_sheet([
    ['Farine', 800],
    ['Eau', 500],
    ['Sel', 16],
    ['Total', 1316],
  ]);
  XLSX.utils.book_append_sheet(wb, campagne, 'Campagne');

  return wb;
}

describe('extractModel', () => {
  it('détecte les jours et extrait sections + produits', () => {
    const model = extractModel(buildWorkbook());
    expect(model.jours).toEqual([
      'Lundi',
      'Mardi',
      'Mercredi',
      'Jeudi',
      'Vendredi',
      'Samedi',
      'Dimanche',
    ]);
    expect(model.produits).toHaveLength(2);
    expect(model.produits[0]).toMatchObject({
      nom: 'Baguette au Levain',
      pate: 'Levain',
      qte: [10, 12, 0, 8, 15, 20, 5],
    });
    expect(model.produits[1]).toMatchObject({ nom: 'Pain Campagne', pate: 'Campagne' });
  });

  it('extrait les recettes avec leur base et leurs lignes (arrondi inclus)', () => {
    const model = extractModel(buildWorkbook());
    expect(model.recettes).toHaveLength(2);

    const levain = model.recettes.find((r) => r.pate === 'Levain')!;
    expect(levain.base).toBe(1680);
    expect(levain.lignes).toEqual([
      { ingredient: 'Farine', quantite: 1000, arrondi: 50 },
      { ingredient: 'Eau', quantite: 650, arrondi: 50 },
      { ingredient: 'Sel', quantite: 20, arrondi: 20 },
      { ingredient: 'Levure', quantite: 10, arrondi: 5 },
    ]);

    const campagne = model.recettes.find((r) => r.pate === 'Campagne')!;
    expect(campagne.base).toBe(1316);
    expect(campagne.lignes).toHaveLength(3);
  });

  it('rapproche les produits de leurs poids malgré les variations de nom', () => {
    const model = extractModel(buildWorkbook());
    const baguette = model.produits.find((p) => p.nom === 'Baguette au Levain')!;
    expect(baguette.poidsPate).toBe(280); // "gr ss ing" préférée à "gr à l'unité"
    expect(baguette.garniture).toBe(0);

    const pain = model.produits.find((p) => p.nom === 'Pain Campagne')!;
    expect(pain.poidsPate).toBe(380);
    expect(pain.garniture).toBe(20);

    expect(model.report.ok).toContain('Tous les produits rapprochés de leur poids');
  });

  it('respecte les overrides explicites de feuilles (commandesSheet/poidsSheet)', () => {
    const wb = buildWorkbook();
    XLSX.utils.book_append_sheet(wb, wb.Sheets['Commandes'], 'CommandesBis');
    const model = extractModel(wb, { commandesSheet: 'CommandesBis' });
    expect(model.produits).toHaveLength(2);
  });

  it("lève une erreur si aucune feuille « Commandes » n'est trouvée", () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['rien']]), 'Autre');
    expect(() => extractModel(wb)).toThrow(/Commandes/);
  });

  it("signale en avertissement une feuille des poids introuvable", () => {
    const wb = buildWorkbook();
    delete wb.Sheets['Poids'];
    wb.SheetNames = wb.SheetNames.filter((n) => n !== 'Poids');
    const model = extractModel(wb);
    expect(model.report.warn).toContain('Feuille des poids introuvable ou vide');
    expect(model.produits.every((p) => p.poidsPate === null)).toBe(true);
  });

  it('signale en avertissement une recette sans feuille correspondante', () => {
    const wb = buildWorkbook();
    // Renomme la feuille "Campagne" pour casser le rapprochement flou avec la section
    const sheet = wb.Sheets['Campagne'];
    delete wb.Sheets['Campagne'];
    wb.Sheets['Sans rapport'] = sheet;
    wb.SheetNames = wb.SheetNames.map((n) => (n === 'Campagne' ? 'Sans rapport' : n));
    const model = extractModel(wb);
    expect(model.report.warn.some((w) => w.includes('Campagne') && w.includes('aucune feuille'))).toBe(
      true
    );
    expect(model.recettes.find((r) => r.pate === 'Campagne')).toBeUndefined();
  });
});
