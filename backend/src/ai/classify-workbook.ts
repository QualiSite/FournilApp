/**
 * Classification IA (optionnelle) des feuilles d'un classeur qui n'a pas été
 * reconnu par la détection par nom (voir import/extract.ts). Déclenchée
 * uniquement à la demande de l'utilisateur (bouton « Essayer l'analyse IA »
 * dans /import), jamais automatiquement — coût et appel réseau explicites.
 *
 * L'IA ne propose qu'une structure ; elle n'écrit jamais en base. Le résultat
 * est présenté à l'utilisateur pour confirmation, puis c'est le parseur
 * déterministe + le validateur de formules (extract.ts) qui font foi.
 */
import Anthropic from '@anthropic-ai/sdk';
import * as XLSX from 'xlsx';
import { sheetToRows } from '../import/extract.js';

const MODEL = 'claude-haiku-4-5-20251001';
const MAX_ROWS = 12;
const MAX_COLS = 10;
const MAX_CELL_LEN = 60;

export type SheetRole = 'commandes' | 'poids' | 'recette' | 'autre';

export interface SheetClassification {
  name: string;
  role: SheetRole;
  confidence: 'haute' | 'moyenne' | 'basse';
  notes?: string;
}

interface SheetSample {
  name: string;
  rows: unknown[][];
}

function truncateCell(v: unknown): unknown {
  if (typeof v === 'string' && v.length > MAX_CELL_LEN) return v.slice(0, MAX_CELL_LEN) + '…';
  if (typeof v === 'number' || typeof v === 'string' || v === null) return v;
  return String(v); // filet de sécurité : jamais d'objet non sérialisable dans le prompt
}

/** Échantillon compact de chaque feuille (nom + premières lignes/colonnes),
 *  pensé pour tenir dans un prompt sans faire exploser le coût du token. */
export function buildSheetSamples(wb: XLSX.WorkBook): SheetSample[] {
  return wb.SheetNames.map((name) => {
    const rows = sheetToRows(wb.Sheets[name])
      .slice(0, MAX_ROWS)
      .map((row) => row.slice(0, MAX_COLS).map(truncateCell));
    return { name, rows };
  });
}

const SYSTEM_PROMPT = `Tu analyses un classeur Excel de gestion de production pour une
boulangerie artisanale. L'application qui l'importe attend normalement trois
types de feuilles :

- "commandes" : UNE SEULE feuille avec une ligne d'en-tête contenant au moins
  3 noms de jours de la semaine (lundi, mardi...) en colonnes, et en dessous,
  des lignes de section (nom de pâte, sans quantité) suivies de lignes produit
  (nom + quantité par jour).
- "poids" : UNE SEULE feuille listant les produits avec leur poids unitaire de
  pâton en grammes (une colonne "gr à l'unité" ou équivalent).
- "recette" : une feuille par pâte, avec une colonne ingrédient et une colonne
  quantité (en grammes), se terminant généralement par une ligne "Total".
- "autre" : tout le reste (fiches techniques, feuilles de calcul annexes,
  feuilles vides, etc.) — pas exploité par l'import.

On te donne un échantillon (nom + premières lignes/colonnes) de chaque feuille
du classeur. Pour chacune, indique le rôle le plus probable, ta confiance, et
une courte justification. Il ne peut y avoir qu'une seule feuille "commandes"
et une seule "poids" recommandées avec une confiance haute — en cas de doute
entre plusieurs candidates, mets confiance "basse" ou "moyenne" et explique
pourquoi dans les notes.`;

const CLASSIFY_TOOL: Anthropic.Tool = {
  name: 'report_classification',
  description: 'Rapporte le rôle probable de chaque feuille du classeur.',
  input_schema: {
    type: 'object',
    properties: {
      sheets: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            role: { type: 'string', enum: ['commandes', 'poids', 'recette', 'autre'] },
            confidence: { type: 'string', enum: ['haute', 'moyenne', 'basse'] },
            notes: { type: 'string' },
          },
          required: ['name', 'role', 'confidence'],
        },
      },
    },
    required: ['sheets'],
  },
};

export async function classifyWorkbook(wb: XLSX.WorkBook): Promise<SheetClassification[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY absente : ajoute-la dans backend/.env pour activer l'analyse IA."
    );
  }

  const samples = buildSheetSamples(wb);
  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    tools: [CLASSIFY_TOOL],
    tool_choice: { type: 'tool', name: 'report_classification' },
    messages: [
      {
        role: 'user',
        content: `Feuilles du classeur (nom + échantillon de lignes/colonnes) :\n\n${JSON.stringify(samples)}`,
      },
    ],
  });

  const toolUse = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
  if (!toolUse) throw new Error('Réponse IA inattendue : pas de classification retournée.');

  const parsed = toolUse.input as { sheets: SheetClassification[] };
  return parsed.sheets;
}
