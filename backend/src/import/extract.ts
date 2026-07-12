/**
 * Pipeline d'import xlsx → modèle métier.
 *
 * 1. extractModel  : lit le classeur (SheetJS) et en tire le référentiel
 *                    (pâtes, produits, commandes, recettes, poids).
 * 2. validateImport: exécute les VRAIES formules du classeur avec le moteur
 *                    (src/lib/engine) et compare aux valeurs en cache d'Excel.
 *                    Si ça diverge, l'import est signalé — ceinture et bretelles.
 *
 * Le xlsx est un format d'injection : après import, PostgreSQL fait foi.
 */

import * as XLSX from 'xlsx';
import { analyzeWorkbook, computeAll, makeKey, type CellMap } from '../engine/engine.js';

/* ---------------- Rapprochement flou des noms ---------------- */

export function normalize(s: string): string {
  return String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // accents
    .replace(/\b(au|aux|de|des|du|le|la|les|a)\b/g, ' ')
    .replace(/[-'’]/g, ' ')
    .replace(/s\b/g, '') // pluriels simples
    .replace(/\s+/g, ' ')
    .trim();
}

export function fuzzyFind<T>(name: string, candidates: T[], keyFn: (c: T) => string): T | null {
  const n = normalize(name);
  let hit = candidates.find((c) => normalize(keyFn(c)) === n);
  if (hit) return hit;
  const tokens = new Set(n.split(' '));
  hit = candidates.find((c) => {
    const t = new Set(normalize(keyFn(c)).split(' '));
    return t.size === tokens.size && [...tokens].every((x) => t.has(x));
  });
  if (hit) return hit;
  hit = candidates.find((c) => {
    const t = new Set(normalize(keyFn(c)).split(' '));
    return [...tokens].every((x) => t.has(x)) || [...t].every((x) => tokens.has(x));
  });
  return hit ?? null;
}

/* ---------------- Modèle extrait ---------------- */

export interface ModelProduit {
  nom: string;
  pate: string | null;
  qte: number[]; // une entrée par jour détecté
  poidsPate: number | null;
  garniture: number;
}

export interface ModelRecette {
  pate: string;
  feuille: string;
  base: number;
  lignes: { ingredient: string; quantite: number; arrondi: number }[];
}

export interface ImportModel {
  jours: string[];
  produits: ModelProduit[];
  recettes: ModelRecette[];
  report: { ok: string[]; warn: string[] };
}

const DAY_WORDS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];

export function arrondiFor(ingredient: string): number {
  const n = normalize(ingredient);
  if (n.includes('sel')) return 20;
  if (n.includes('levure')) return 5;
  return 50;
}

export function sheetToRows(ws: XLSX.WorkSheet): unknown[][] {
  if (!ws || !ws['!ref']) return [];
  const range = XLSX.utils.decode_range(ws['!ref']);
  const rows: unknown[][] = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    const line: unknown[] = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      line.push(cell ? cell.v : null);
    }
    rows.push(line);
  }
  return rows;
}

/* ---------------- Extraction ---------------- */

/** Choix explicite de feuilles, en général confirmés par l'utilisateur après
 *  une classification IA (voir src/ai/classify-workbook.ts) quand la détection
 *  par nom échoue. Prioritaires sur la détection automatique quand fournis. */
export interface ExtractOverrides {
  commandesSheet?: string;
  poidsSheet?: string;
}

export function extractModel(wb: XLSX.WorkBook, overrides?: ExtractOverrides): ImportModel {
  const report = { ok: [] as string[], warn: [] as string[] };
  const sheetNames = wb.SheetNames;

  /* --- Feuille Commandes : jours, sections (pâtes), produits --- */
  const cmdName =
    overrides?.commandesSheet ?? sheetNames.find((s) => normalize(s).includes('commande'));
  if (!cmdName || !sheetNames.includes(cmdName))
    throw new Error('Aucune feuille « Commandes » trouvée dans le classeur.');
  const cmdRows = sheetToRows(wb.Sheets[cmdName]);

  let headerIdx = -1;
  let dayCols: { ci: number; jour: string }[] = [];
  for (let i = 0; i < Math.min(cmdRows.length, 10); i++) {
    const cols: typeof dayCols = [];
    cmdRows[i].forEach((v, ci) => {
      if (typeof v === 'string' && DAY_WORDS.includes(normalize(v)))
        cols.push({ ci, jour: normalize(v) });
    });
    if (cols.length >= 3) {
      headerIdx = i;
      dayCols = cols;
      break;
    }
  }
  if (headerIdx < 0)
    throw new Error('Impossible de trouver la ligne des jours dans « Commandes ».');
  dayCols.sort((a, b) => DAY_WORDS.indexOf(a.jour) - DAY_WORDS.indexOf(b.jour));
  const jours = dayCols.map((d) => d.jour.charAt(0).toUpperCase() + d.jour.slice(1));

  const produits: ModelProduit[] = [];
  const sections: string[] = [];
  let currentPate: string | null = null;
  for (let i = headerIdx + 1; i < cmdRows.length; i++) {
    const row = cmdRows[i];
    const label = row[0];
    if (typeof label !== 'string' || !label.trim()) continue;
    const nums = dayCols.map((d) => row[d.ci]);
    if (!nums.some((v) => typeof v === 'number')) {
      currentPate = label.trim();
      sections.push(currentPate);
    } else {
      produits.push({
        nom: label.trim(),
        pate: currentPate,
        qte: nums.map((v) => (typeof v === 'number' ? v : 0)),
        poidsPate: null,
        garniture: 0,
      });
    }
  }
  report.ok.push(`${produits.length} produits, ${sections.length} pâtes (${sections.join(', ')})`);

  /* --- Feuille des poids unitaires --- */
  const poidsName = overrides?.poidsSheet ?? sheetNames.find((s) => normalize(s).includes('poid'));
  const poidsRows =
    poidsName && sheetNames.includes(poidsName) ? sheetToRows(wb.Sheets[poidsName]) : [];
  const poidsList: { nom: string; pate: number; garniture: number }[] = [];
  for (const row of poidsRows) {
    if (typeof row[0] === 'string' && typeof row[1] === 'number') {
      poidsList.push({
        nom: row[0].trim(),
        pate: typeof row[2] === 'number' ? row[2] : row[1], // "gr ss ing" sinon "gr à l'unité"
        garniture: typeof row[3] === 'number' ? row[3] : 0,
      });
    }
  }
  if (poidsList.length) report.ok.push(`${poidsList.length} poids unitaires`);
  else report.warn.push('Feuille des poids introuvable ou vide');

  /* --- Feuilles recettes : une par section --- */
  const recettes: ModelRecette[] = [];
  for (const pate of sections) {
    const sheet = fuzzyFind(pate, sheetNames, (s) => s);
    if (!sheet) {
      report.warn.push(`Recette « ${pate} » : aucune feuille correspondante`);
      continue;
    }
    const rows = sheetToRows(wb.Sheets[sheet]);
    const lignes: ModelRecette['lignes'] = [];
    let base: number | null = null;
    for (const row of rows) {
      const label = row[0],
        val = row[1];
      if (typeof label !== 'string' || typeof val !== 'number') {
        if (lignes.length > 0 && base !== null) break;
        continue;
      }
      if (normalize(label) === 'total') {
        base = val;
        break;
      }
      lignes.push({ ingredient: label.trim(), quantite: val, arrondi: arrondiFor(label) });
    }
    if (lignes.length === 0) {
      report.warn.push(`Recette « ${pate} » (feuille ${sheet.trim()}) : aucune ligne lue`);
      continue;
    }
    recettes.push({
      pate,
      feuille: sheet.trim(),
      base: base ?? lignes.reduce((a, l) => a + l.quantite, 0),
      lignes,
    });
  }
  report.ok.push(`${recettes.length} recettes extraites`);

  /* --- Rapprochement produits ↔ poids --- */
  let unmatched = 0;
  for (const p of produits) {
    const w = fuzzyFind(p.nom, poidsList, (x) => x.nom);
    if (w) {
      p.poidsPate = w.pate;
      p.garniture = w.garniture;
    } else {
      unmatched++;
      report.warn.push(`Poids introuvable pour « ${p.nom} »`);
    }
  }
  if (unmatched === 0 && poidsList.length)
    report.ok.push('Tous les produits rapprochés de leur poids');

  return { jours, produits, recettes, report };
}

/* ---------------- Validation croisée (moteur vs Excel) ---------------- */

export interface ValidationResult {
  totalFormulas: number;
  evaluated: number;
  matches: number;
  mismatches: { key: string; excel: unknown; engine: unknown }[];
  parseErrors: number;
}

/**
 * Rejoue toutes les formules du classeur avec notre moteur et compare
 * aux valeurs en cache calculées par Excel. Un import sain doit donner
 * ~100 % de correspondance sur les formules numériques.
 */
export function validateImport(wb: XLSX.WorkBook, tolerance = 0.01): ValidationResult {
  const cells: CellMap = {};
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws || !ws['!ref']) continue;
    const range = XLSX.utils.decode_range(ws['!ref']);
    for (let r = range.s.r; r <= range.e.r; r++) {
      for (let c = range.s.c; c <= range.e.c; c++) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })];
        if (cell && (cell.v !== undefined || cell.f)) {
          cells[makeKey(name, XLSX.utils.encode_cell({ r, c }))] = { v: cell.v, f: cell.f };
        }
      }
    }
  }

  const analysis = analyzeWorkbook(cells, wb.SheetNames);
  const { results } = computeAll(cells, analysis.formulas);

  const mismatches: ValidationResult['mismatches'] = [];
  let matches = 0,
    evaluated = 0;
  for (const [key, val] of Object.entries(results)) {
    const excel = cells[key]?.v;
    if (typeof excel !== 'number') continue; // on ne valide que le numérique
    evaluated++;
    if (typeof val === 'number' && Math.abs(val - excel) <= tolerance) matches++;
    else mismatches.push({ key, excel, engine: val });
  }

  return {
    totalFormulas: Object.keys(analysis.formulas).length,
    evaluated,
    matches,
    mismatches: mismatches.slice(0, 50), // on plafonne le rapport
    parseErrors: Object.keys(analysis.errors).length,
  };
}
