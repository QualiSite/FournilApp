export default {
  'backend/**/*.{ts,js}': () => 'npm run lint --prefix backend -- --fix && npm run format --prefix backend',
  'frontend/**/*.{ts,js,svelte}': () => 'npm run lint --prefix frontend -- --fix && npm run format --prefix frontend',
};