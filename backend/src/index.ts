/**
 * Point d'entrée : démarre le serveur HTTP sur l'app Express (voir app.ts).
 * Séparé de app.ts pour que les tests d'intégration puissent importer
 * l'app sans ouvrir de port réseau.
 */
import { app } from './app.js';

const port = Number(process.env.PORT) || 3001;
app.listen(port, '0.0.0.0', () => {
  console.log(`API Fournil prête sur :${port}`);
});
