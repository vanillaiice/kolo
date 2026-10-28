/** Sitemap of every page, with each page's language alternates; blog posts list only their published languages. */
import type { APIRoute } from 'astro';
import { getPosts } from '../lib/blog';
import { href, languages, type Lang } from '../lib/content';

const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Absolute base for crawlers; local builds without a site URL use the preview address. */
export const crawlBase = (site: URL | undefined) => site?.href ?? `http://localhost:4173${href()}`;

export const GET: APIRoute = async ({ site }) => {
  const base = crawlBase(site);
  const slugs = ['', 'blog/', 'privacy/', 'cookies/'];
  const entry = (route: string, slug?: string, alternates: readonly Lang[] = languages, modified?: Date) => `<url><loc>${escape(base + route)}</loc>${modified ? `<lastmod>${modified.toISOString().slice(0, 10)}</lastmod>` : ''}${slug === undefined ? '' : alternates.map(lang => `<xhtml:link rel="alternate" hreflang="${lang}" href="${escape(`${base}${lang}/${slug}`)}"/>`).join('')}</url>`;
  const posts = (await getPosts()).map(({ lang, slug, translations, entry: { data } }) => entry(`${lang}/blog/${slug}/`, `blog/${slug}/`, translations, data.updated ?? data.date));
  const urls = [entry(''), ...languages.flatMap(lang => slugs.map(slug => entry(`${lang}/${slug}`, slug))), ...posts];
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urls.join('\n')}
</urlset>\n`, { headers: { 'Content-Type': 'application/xml' } });
};
