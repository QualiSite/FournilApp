import { readFileSync } from 'node:fs';
import * as XLSX from 'xlsx';
import { extractModel, validateImport } from './src/import/extract.js';

const buf = readFileSync(
  '/sessions/bold-friendly-fermi/mnt/uploads/Tableau_commandes_CHABANEL.xlsx'
);
const wb = XLSX.read(buf, { type: 'buffer', cellFormula: true });
const model = extractModel(wb);
const validation = validateImport(wb);

console.log('--- report.ok ---');
console.log(model.report.ok.join('\n'));
console.log('--- report.warn ---');
console.log(model.report.warn.join('\n'));
console.log('--- validation ---');
console.log(
  JSON.stringify(
    {
      totalFormulas: validation.totalFormulas,
      evaluated: validation.evaluated,
      matches: validation.matches,
      parseErrors: validation.parseErrors,
    },
    null,
    2
  )
);
const ratio = validation.evaluated ? validation.matches / validation.evaluated : 1;
console.log('ratio', ratio);
if (ratio < 0.95) {
  console.log('--- mismatches (up to 20) ---');
  console.log(JSON.stringify(validation.mismatches.slice(0, 20), null, 2));
}
console.log('--- jours ---', model.jours);
console.log('--- produits count ---', model.produits.length);
console.log(
  '--- recettes ---',
  model.recettes.map(
    (r) => r.pate + ' <- ' + r.feuille + ' (' + r.lignes.length + ' lignes, base ' + r.base + ')'
  )
);
