/** Check translation parity, every built local link, anchor and media file, and that pages stay CSP-safe. */
import assert from 'node:assert/strict';
import { readFile, readdir, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAnalytics } from './src/lib/analytics.mjs';
const root = fileURLToPath(new URL('./', import.meta.url));
const read = path => readFile(resolve(root,path),'utf8');
const base = (process.env.LANDING_BASE_PATH ?? '/').replace(/\/?$/, '/');
/** Resolve a page link to its built file: root-relative links live under the base path. */
function target(url, page) {
  const path = url.split(/[?#]/)[0];
  if (!path.startsWith('/')) return resolve(root, 'dist', page, path);
  assert.ok(path.startsWith(base), `${path} is outside the base path ${base}`);
  return resolve(root, 'dist', path.slice(base.length));
}
const en = JSON.parse(await read('content/en.json'));
const fr = JSON.parse(await read('content/fr.json'));
function compare(a,b,path='content') {
  assert.equal(typeof a,typeof b,`${path}: translation types differ`);
  if (typeof a === 'string') { assert.ok(a.trim() && b.trim(),`${path}: empty translation`); return; }
  assert.deepEqual(Object.keys(a),Object.keys(b),`${path}: translation keys differ`);
  for (const key of Object.keys(a)) compare(a[key],b[key],`${path}.${key}`);
}
compare(en,fr);
/** Built blog posts per language, as routes below the language folder (`blog/<slug>/`). */
const posts = Object.fromEntries(await Promise.all(['en','fr'].map(async lang => [lang, (await readdir(resolve(root,`dist/${lang}/blog`),{withFileTypes:true})).filter(e => e.isDirectory()).map(e => `blog/${e.name}/`)])));
const routes = lang => ['', 'blog/', 'privacy/', 'cookies/', ...posts[lang]];
const pages = ['', ...['en','fr'].flatMap(lang => routes(lang).map(route => `${lang}/${route}`)), '404.html'];
/** Built file of a page: a route folder's index, or a root file such as `404.html`. */
const pageFile = page => `dist/${page.endsWith('.html') ? page : `${page}index.html`}`;
for (const page of pages) {
  const html = await read(pageFile(page));
  // The Caddy CSP allows only same-origin scripts and styles: nothing inline. JSON-LD is data and must parse.
  assert.ok(!/<script(?![^>]*\b(?:src=|type="application\/ld\+json"))[^>]*>/.test(html), `${page}: inline script`);
  for (const [,json] of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) assert.equal(JSON.parse(json)['@context'],'https://schema.org',`${page}: JSON-LD needs the schema.org context`);
  assert.ok(!/<style[\s>]/.test(html) && !/\sstyle="/.test(html), `${page}: inline style`);
  assert.ok(!/\son[a-z]+="/.test(html), `${page}: inline event handler`);
  assert.equal([...html.matchAll(/<h1[ >]/g)].length,1,'One primary heading per page');
  const srcsets = [...html.matchAll(/\bsrcset="([^"]+)"/g)].flatMap(m => m[1].split(',').map(entry => entry.trim().split(/\s+/)[0]));
  for (const url of [...[...html.matchAll(/(?:href|src)="([^"]+)"/g)].map(m => m[1]), ...srcsets]) {
    if (/^https?:|^mailto:|^#/.test(url)) continue;
    const file = target(url, page.endsWith('.html') ? '' : page);
    await access(file.endsWith('/') || !/\.[a-z0-9]+$/i.test(file) ? resolve(file, 'index.html') : file);
  }
}
for (const lang of ['en','fr']) for (const route of routes(lang)) {
  const html = await read(`dist/${lang}/${route}index.html`);
  assert.ok(html.includes(`<html lang="${lang}">`));
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);
  assert.equal(ids.length,new Set(ids).size,'IDs must be unique');
  for (const [,id] of html.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.includes(id),`Missing anchor #${id}`);
  for (const [,tag] of html.matchAll(/(<img\b[^>]*>)/g)) assert.ok(/\balt=/.test(tag) && (!/\bsrc=/.test(tag) || (/\bwidth=/.test(tag) && /\bheight=/.test(tag))),'Images need alt text, and dimensions once they have a source');
  for (const [,picture] of html.matchAll(/<picture>([\s\S]*?)<\/picture>/g)) assert.ok(picture.includes('type="image/avif"') && picture.includes('type="image/webp"') && /\bsizes="/.test(picture),'Screenshots need AVIF and WebP sources with sizes');
  if (!route) for (const name of ['iOS','Google Play','F-Droid']) assert.ok(html.includes(`<strong>${name}</strong>`));
  if (!route) {
    assert.deepEqual([...html.matchAll(/class="download-card" data-platform="([^"]+)"/g)].map(m => m[1]),['windows','linux','android'],'Download cards need their platform for the suggestion');
    for (const attr of ['data-suggested=','data-download-for=','data-platform-note="ios"','data-platform-note="mac"']) assert.ok(html.includes(attr),`Missing ${attr}`);
  }
  assert.ok(html.includes('href=') && html.includes(`${lang}/privacy/`) && html.includes(`${lang}/cookies/`),'Policy footer links missing');
  assert.ok(!html.includes('—'),'Em dashes must stay removed');
  assert.ok(!html.includes('releases/latest'),'Beta downloads must not use latest');
}
const styles = (await readdir(resolve(root,'dist/_astro'))).filter(name => name.endsWith('.css'));
assert.ok(styles.length > 0,'No built stylesheet');
for (const name of styles) for (const [,url] of (await read(`dist/_astro/${name}`)).matchAll(/url\(["']?([^"')]+)["']?\)/g)) {
  if (!url.startsWith('data:')) await access(target(url, '_astro/'));
}
console.log('Translation parity, CSP-safe markup, local links, anchors, media, fonts and future-platform labels passed.');

const sitemap = await read('dist/sitemap.xml');
const robots = await read('dist/robots.txt');
const locations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
assert.equal(locations.length,9 + posts.en.length + posts.fr.length,'Sitemap must list the root, two landing pages, two blogs, four policies and every post');
for (const lang of ['en','fr']) for (const post of posts[lang]) assert.ok(locations.some(loc => loc.endsWith(`/${lang}/${post}`)),`Sitemap misses ${lang}/${post}`);
for (const loc of locations) {
  const url = new URL(loc.replaceAll('&amp;', '&'));
  assert.ok(['https:', 'http:'].includes(url.protocol));
}
assert.ok(robots.includes('User-agent: *') && robots.includes('Allow: /'));
assert.ok(robots.includes(`Sitemap: ${new URL('sitemap.xml',locations[0]).href}`),'Robots sitemap URL differs');
for (const lang of ['en','fr']) {
  const feed = await read(`dist/${lang}/blog/rss.xml`);
  assert.ok(feed.startsWith('<?xml') && feed.includes('<rss') && feed.includes(`<language>${lang}</language>`),`${lang} RSS feed is malformed`);
  const links = [...feed.matchAll(/<item>[\s\S]*?<link>([^<]+)<\/link>/g)].map(m => m[1]);
  assert.deepEqual(links.map(link => new URL(link).pathname.replace(/^.*?\/(en|fr)\//, '')).sort(), [...posts[lang]].sort(),`${lang} RSS items differ from built posts`);
}
const jsonTypes = page => [...page.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(m => JSON.parse(m[1])['@type']);
for (const lang of ['en','fr']) {
  assert.deepEqual(jsonTypes(await read(`dist/${lang}/index.html`)),['WebSite','SoftwareApplication'],`${lang} home structured data`);
  assert.deepEqual(jsonTypes(await read(`dist/${lang}/blog/index.html`)),['Blog'],`${lang} blog structured data`);
  for (const post of posts[lang]) assert.deepEqual(jsonTypes(await read(`dist/${lang}/${post}index.html`)),['BlogPosting','BreadcrumbList'],`${lang}/${post} structured data`);
}
const missing = await read('dist/404.html');
assert.ok(missing.includes('<meta name="robots" content="noindex">'),'The 404 page must not be indexed');
assert.ok(/handle_errors 404 \{[^}]*rewrite \* \/404\.html/.test(await read('Caddyfile')),'Caddy must serve 404.html for missing paths');
assert.ok(!locations.some(loc => loc.includes('404')),'The sitemap must not list the 404 page');
console.log('Policy pages, blog feeds, structured data, 404 page, sitemap routes and robots directive passed.');

// External video hosting: every media URL sits under mediaBase, and the Caddy CSP allows its origin.
const site = JSON.parse(await read('content/site.json'));
const csp = (await read('Caddyfile')).match(/Content-Security-Policy "([^"]+)"/)[1];
const directive = name => csp.split(';').map(part => part.trim().split(/\s+/)).find(([key]) => key === name)?.slice(1) ?? [];
const mediaOrigin = site.mediaBase ? new URL(site.mediaBase).origin : null;
if (mediaOrigin) for (const name of ['media-src','img-src']) assert.ok(directive(name).includes(mediaOrigin),`Caddyfile CSP ${name} must allow ${mediaOrigin}`);
for (const page of pages) {
  const html = await read(pageFile(page));
  for (const [,url] of html.matchAll(/<(?:video|source|track)\b[^>]*?\b(?:src|poster)="(https?:[^"]+)"/g)) assert.ok(mediaOrigin && url.startsWith(site.mediaBase),`${page}: ${url} is not under site.json mediaBase`);
  if (page.endsWith('privacy/')) assert.equal(html.includes(new URL(site.mediaBase ?? 'https://none.invalid').host),Boolean(mediaOrigin),`${page}: the privacy notice must name the video host exactly when one is set`);
}
console.log('Media host CSP and privacy notice passed.');

// Visit statistics: the script is on every page exactly when configured, the CSP allows only that
// origin, and the policies describe it only when it is on.
const analytics = resolveAnalytics(site.analytics, process.env);
if (analytics) for (const name of ['script-src','connect-src']) assert.ok(directive(name).includes(analytics.origin),`Caddyfile CSP ${name} must allow ${analytics.origin}`);
for (const page of pages) {
  const html = await read(pageFile(page));
  const tags = [...html.matchAll(/<script\b[^>]*data-website-id="([^"]+)"[^>]*>/g)];
  if (analytics) {
    assert.equal(tags.length,1,`${page}: needs one statistics script`);
    assert.ok(tags[0][0].includes(`src="${analytics.script}"`) && tags[0][1] === analytics.websiteId,`${page}: statistics script differs from the configuration`);
  } else assert.equal(tags.length,0,`${page}: statistics are off but the script is present`);
  assert.ok(!/\{(?:operator|host|origin)\}/.test(html),`${page}: unfilled copy placeholder`);
  if (/(privacy|cookies)\/$/.test(page)) assert.equal(html.includes('Umami'),Boolean(analytics),`${page}: policies must mention Umami exactly when statistics are on`);
  if (analytics && page.endsWith('privacy/')) assert.ok(html.includes(analytics.host),`${page}: the privacy policy must name ${analytics.host}`);
}
console.log(`Visit statistics ${analytics ? `(${analytics.host})` : '(off)'}: scripts, CSP and policies passed.`);
