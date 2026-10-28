/** RSS feed per language: titles, summaries and dates of the posts in that language. */
import rss from '@astrojs/rss';
import type { APIRoute } from 'astro';
import { getPosts } from '../../../lib/blog';
import { languages, translations, type Lang } from '../../../lib/content';
import { crawlBase } from '../../sitemap.xml';

export const getStaticPaths = () => languages.map(lang => ({ params: { lang } }));

export const GET: APIRoute = async ({ params, site }) => {
  const lang = params.lang as Lang;
  const t = translations[lang].blog;
  const base = crawlBase(site);
  const posts = (await getPosts()).filter(post => post.lang === lang);
  return rss({
    title: t.title,
    description: t.description,
    site: `${base}${lang}/blog/`,
    customData: `<language>${lang}</language>`,
    items: posts.map(({ entry, slug }) => ({
      title: entry.data.title,
      description: entry.data.description,
      pubDate: entry.data.date,
      link: `${base}${lang}/blog/${slug}/`,
    })),
  });
};
