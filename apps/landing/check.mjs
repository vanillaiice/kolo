/** Check translation parity and every generated local link, anchor and media file. */
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('./', import.meta.url));
const read = path => readFile(resolve(root,path),'utf8');
const en = JSON.parse(await read('content/en.json'));
const fr = JSON.parse(await read('content/fr.json'));
function compare(a,b,path='content') {
  assert.equal(typeof a,typeof b,`${path}: translation types differ`);
  if (typeof a === 'string') { assert.ok(a.trim() && b.trim(),`${path}: empty translation`); return; }
  assert.deepEqual(Object.keys(a),Object.keys(b),`${path}: translation keys differ`);
  for (const key of Object.keys(a)) compare(a[key],b[key],`${path}.${key}`);
}
compare(en,fr);
for (const lang of ['en','fr']) for (const route of ['', 'privacy/', 'cookies/']) {
  const html = await read(`dist/${lang}/${route}index.html`);
  assert.ok(html.includes(`<html lang="${lang}">`));
  assert.equal([...html.matchAll(/<h1[ >]/g)].length,1,'One primary heading per page');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);
  assert.equal(ids.length,new Set(ids).size,'IDs must be unique');
  for (const [,url] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    if (/^https?:|^mailto:/.test(url)) continue;
    if (url.startsWith('#')) { assert.ok(ids.includes(url.slice(1)),`Missing anchor ${url}`); continue; }
    const target = resolve(root,'dist',lang,route,url.split('#')[0]);
    await access(target.endsWith('/') ? `${target}index.html` : target);
  }
  for (const [,tag] of html.matchAll(/(<img\b[^>]*>)/g)) assert.ok(/\balt=/.test(tag),'Images need alt text');
  if (!route) for (const name of ['iOS','Google Play','F-Droid']) assert.ok(html.includes(`<strong>${name}</strong>`));
  if (!route) {
    assert.deepEqual([...html.matchAll(/class="download-card" data-platform="([^"]+)"/g)].map(m => m[1]),['windows','linux','android'],'Download cards need their platform for the suggestion');
    for (const attr of ['data-suggested=','data-download-for=','data-platform-note="ios"','data-platform-note="mac"']) assert.ok(html.includes(attr),`Missing ${attr}`);
  }
  assert.ok(html.includes('href=') && html.includes(`${lang}/privacy/`) && html.includes(`${lang}/cookies/`),'Policy footer links missing');
  assert.ok(!html.includes('—'),'Em dashes must stay removed');
  assert.ok(!html.includes('releases/latest'),'Beta downloads must not use latest');
}
for (const [,url] of (await read('dist/assets/styles.css')).matchAll(/url\('([^']+)'\)/g)) await access(resolve(root,'dist/assets',url));
console.log('Translation parity, local links, anchors, media, fonts and future-platform labels passed.');

const sitemap = await read('dist/sitemap.xml');
const robots = await read('dist/robots.txt');
const locations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
assert.equal(locations.length,7,'Sitemap must list the root, two landing pages and four policies');
for (const loc of locations) {
  const url = new URL(loc.replaceAll('&amp;', '&'));
  assert.ok(['https:', 'http:'].includes(url.protocol));
}
assert.ok(robots.includes('User-agent: *') && robots.includes('Allow: /'));
assert.ok(robots.includes(`Sitemap: ${new URL('sitemap.xml',locations[0]).href}`),'Robots sitemap URL differs');
console.log('Policy pages, sitemap routes and robots directive passed.');
