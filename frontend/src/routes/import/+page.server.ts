import { fail } from '@sveltejs/kit';
import { api, API_BASE } from '$lib/api';
import type { Actions, PageServerLoad } from './$types';

interface ImportRapport {
  id: number;
  fileName: string;
  importedAt: string;
  rapport: {
    ok?: string[];
    warn?: string[];
    validation?: { evaluated: number; matches: number };
  };
  importedBy: { id: number; nom: string; email: string } | null;
}

export interface SheetClassification {
  name: string;
  role: 'commandes' | 'poids' | 'recette' | 'autre';
  confidence: 'haute' | 'moyenne' | 'basse';
  notes?: string;
}

export const load: PageServerLoad = async ({ cookies }) => {
  let imports: ImportRapport[] = [];
  try {
    imports = await api<ImportRapport[]>('/api/imports', undefined, cookies.get('session'));
  } catch {
    // historique indisponible : pas bloquant pour la page
  }
  return { imports };
};

function getFile(form: FormData): File | null {
  const file = form.get('file');
  return file instanceof File && file.size ? file : null;
}

export const actions: Actions = {
  import: async ({ request, cookies }) => {
    const form = await request.formData();
    const file = getFile(form);

    if (!file) {
      return fail(400, { error: "Choisis un fichier .xlsx avant d'importer." });
    }
    if (!file.name.toLowerCase().endsWith('.xlsx')) {
      return fail(400, { error: 'Le fichier doit être un classeur .xlsx.' });
    }

    const upstream = new FormData();
    upstream.append('file', file, file.name);
    const commandesSheet = form.get('commandesSheet');
    const poidsSheet = form.get('poidsSheet');
    if (typeof commandesSheet === 'string' && commandesSheet) {
      upstream.append('commandesSheet', commandesSheet);
    }
    if (typeof poidsSheet === 'string' && poidsSheet) {
      upstream.append('poidsSheet', poidsSheet);
    }

    const token = cookies.get('session');
    let res: Response;
    try {
      res = await fetch(`${API_BASE}/api/import`, {
        method: 'POST',
        body: upstream,
        headers: token ? { authorization: `Bearer ${token}` } : undefined,
      });
    } catch {
      return fail(502, { error: 'API indisponible.' });
    }

    const json = await res.json().catch(() => null);

    if (!res.ok) {
      return fail(res.status, {
        error: json?.error ?? `Échec de l'import (${res.status}).`,
        validation: json?.validation,
        needsAiHelp: json?.needsAiHelp === true,
      });
    }

    return {
      success: true as const,
      importId: json.importId,
      report: json.report as { ok: string[]; warn: string[] },
      validation: json.validation as { evaluated: number; matches: number },
    };
  },

  // Déclenché uniquement par le bouton "Essayer l'analyse IA", jamais automatiquement.
  analyze: async ({ request, cookies }) => {
    const form = await request.formData();
    const file = getFile(form);

    if (!file) {
      return fail(400, { error: "Choisis un fichier .xlsx avant d'analyser." });
    }

    const upstream = new FormData();
    upstream.append('file', file, file.name);

    const token = cookies.get('session');
    let res: Response;
    try {
      res = await fetch(`${API_BASE}/api/import/analyze`, {
        method: 'POST',
        body: upstream,
        headers: token ? { authorization: `Bearer ${token}` } : undefined,
      });
    } catch {
      return fail(502, { error: 'Analyse IA indisponible (API injoignable).' });
    }

    const json = await res.json().catch(() => null);

    if (!res.ok) {
      return fail(res.status, { error: json?.error ?? "Échec de l'analyse IA." });
    }

    return {
      classification: json.sheets as SheetClassification[],
    };
  },

  // Zone de danger : vide Pate/Recette/RecetteLigne/Produit/Commande.
  // Ne touche jamais aux comptes ni à l'historique des imports. Le champ
  // "confirm" doit valoir exactement "SUPPRIMER" (revérifié aussi côté API).
  resetData: async ({ request, cookies }) => {
    const form = await request.formData();
    const confirm = form.get('confirm');

    if (confirm !== 'SUPPRIMER') {
      return fail(400, { resetError: 'Tape exactement SUPPRIMER pour confirmer.' });
    }

    const token = cookies.get('session');
    let res: Response;
    try {
      res = await fetch(`${API_BASE}/api/admin/reset-data`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ confirm }),
      });
    } catch {
      return fail(502, { resetError: 'API indisponible.' });
    }

    const json = await res.json().catch(() => null);

    if (!res.ok) {
      return fail(res.status, { resetError: json?.error ?? 'Échec de la purge.' });
    }

    return {
      resetDone: true as const,
      deleted: json.deleted as {
        commandes: number;
        ligneRecettes: number;
        recettes: number;
        produits: number;
        pates: number;
      },
    };
  },
};
