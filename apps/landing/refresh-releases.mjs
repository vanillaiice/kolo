/** Explicitly refresh the public release snapshot; ordinary builds need no network. */
import { writeFile } from 'node:fs/promises';
import { selectRelease } from './src/lib/releases.mjs';
const response = await fetch('https://api.github.com/repos/vanillaiice/kolo/releases?per_page=100', {
  headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'kolo-landing' },
  signal: AbortSignal.timeout(20000),
});
if (!response.ok) throw new Error(`GitHub returned ${response.status}; existing snapshot kept.`);
const releases = await response.json();
if (!Array.isArray(releases)) throw new Error('Unexpected release response; existing snapshot kept.');
const snapshot = releases.filter(r => !r.draft).map(r => ({
  tag_name: r.tag_name, draft: r.draft, prerelease: r.prerelease, published_at: r.published_at,
  assets: r.assets.map(a => ({ name: a.name, state: a.state, size: a.size, browser_download_url: a.browser_download_url })),
}));
if (!selectRelease(snapshot)) throw new Error('No published shared release found; existing snapshot kept.');
await writeFile(new URL('./content/releases.json', import.meta.url), `${JSON.stringify(snapshot, null, 2)}\n`);
console.log(`Saved ${snapshot.length} published releases. Rebuild to update downloads.`);
