import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(eslint.configs.recommended, ...tseslint.configs.recommended, {
  rules: {
    // Express identifie un middleware d'erreur à son arité de 4 paramètres :
    // `_next` doit rester présent même inutilisé. Convention `_`-préfixe déjà
    // utilisée dans ce projet (_req, _next).
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
  },
});
