import { readFileSync } from 'node:fs';
import * as XLSX from 'xlsx';
import { buildSheetSamples } from './src/ai/classify-workbook.js';

const buf = readFileSync(
  '/sessions/bold-friendly-fermi/mnt/uploads/Tableau_commandes_CHABANEL.xlsx'
);
const wb = XLSX.read(buf, { type: 'buffer', cellFormula: true });
const samples = buildSheetSamples(wb);
const json = JSON.stringify(samples);
console.log('sheets:', samples.length);
console.log('json length (chars):', json.length);
console.log('approx tokens:', Math.round(json.length / 4));
console.log(JSON.stringify(samples[0], null, 1).slice(0, 600));
