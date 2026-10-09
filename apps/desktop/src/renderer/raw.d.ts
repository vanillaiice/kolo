/** Vite inlines `?raw` imports as text at build time. */
declare module "*?raw" { const text: string; export default text; }
