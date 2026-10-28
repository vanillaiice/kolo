/** Static English/French site. Output stays CSP-safe: no inline scripts or styles. */
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import { releasesURL } from './src/lib/releases.mjs';

const root = new URL('./', import.meta.url);
const repo = new URL('../../', root);
const readJSON = async path => JSON.parse(await readFile(new URL(path, root), 'utf8'));
const site = await readJSON('content/site.json');

let siteURL = process.env.LANDING_SITE_URL ?? site.url;
if (siteURL) {
  const parsed = new URL(siteURL);
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.search || parsed.hash || parsed.username || parsed.password) throw new Error('LANDING_SITE_URL must be an HTTP(S) base URL without a query or fragment.');
  siteURL = parsed.href.replace(/\/?$/, '/');
}

/** Copy repository brand files, screenshots and the font licence to their public paths (gitignored). */
const repositoryFiles = {
  name: 'kolo-repository-files',
  hooks: {
    'astro:config:setup': async () => {
      const pub = new URL('public/', root);
      const translations = { en: await readJSON('content/en.json'), fr: await readJSON('content/fr.json') };
      await mkdir(new URL('assets/', pub), { recursive: true });
      await mkdir(new URL('kit/', pub), { recursive: true });
      await cp(new URL('assets/brand/kolo-icon.svg', repo), new URL('assets/kolo-icon.svg', pub));
      await cp(new URL('node_modules/@fontsource-variable/inter/LICENSE', repo), new URL('assets/inter-LICENSE.txt', pub));
      await cp(new URL('assets/brand/', repo), new URL('kit/logos/', pub), { recursive: true });
      await cp(new URL('docs/screenshots/', repo), new URL('kit/screenshots/', pub), { recursive: true });
      await writeFile(new URL('kit/descriptions.txt', pub), `KOLO: ENGLISH\n\n${translations.en.promoDescription}\n\nKOLO: FRANÇAIS\n\n${translations.fr.promoDescription}\n\n${releasesURL}\n`);
    },
    /** Screenshot originals are emitted next to their resized variants; ship only files a page references. */
    'astro:build:done': async ({ dir }) => {
      const assets = new URL('_astro/', dir);
      const files = await readdir(dir, { recursive: true });
      const text = (await Promise.all(files.filter(name => /\.(html|css|js|xml)$/.test(name)).map(name => readFile(new URL(name, dir), 'utf8')))).join('\n');
      for (const name of await readdir(assets)) if (name.endsWith('.png') && !text.includes(`_astro/${name}`)) await rm(new URL(name, assets));
    },
  },
};

export default defineConfig({
  site: siteURL,
  base: process.env.LANDING_BASE_PATH ?? '/',
  trailingSlash: 'always',
  output: 'static',
  integrations: [repositoryFiles, mdx()],
  server: { port: 4173, host: '127.0.0.1' },
  devToolbar: { enabled: false },
  build: { format: 'directory', inlineStylesheets: 'never' },
  // Highlighters emit inline style attributes, which the CSP blocks; code blocks use the stylesheet.
  markdown: { syntaxHighlight: false },
  // The page CSP allows only same-origin scripts, styles and fonts: never inline assets.
  vite: { build: { assetsInlineLimit: 0 } },
});
