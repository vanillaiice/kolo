/** Blog posts by language, with their translation in the other language when one exists. */
import { getCollection, type CollectionEntry } from 'astro:content';
import { languages, type Lang } from './content';

export interface Post {
  entry: CollectionEntry<'blog'>;
  lang: Lang;
  /** File name without extension; shared by a post and its translation. */
  slug: string;
  /** Languages this post is published in, including its own. */
  translations: Lang[];
}

/** Every published post (drafts too on the dev server), newest first. */
export async function getPosts(): Promise<Post[]> {
  const entries = await getCollection('blog', entry => import.meta.env.DEV || !entry.data.draft);
  const parsed = entries.map(entry => {
    const [lang, slug] = entry.id.split('/') as [Lang, string];
    if (!languages.includes(lang) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error(`Blog post ${entry.id} needs a lowercase-hyphenated name under en/ or fr/`);
    return { entry, lang, slug };
  });
  return parsed
    .map(post => ({ ...post, translations: languages.filter(lang => parsed.some(other => other.slug === post.slug && other.lang === lang)) }))
    .sort((a, b) => b.entry.data.date.getTime() - a.entry.data.date.getTime() || a.slug.localeCompare(b.slug));
}

/** Format a post date in the page language, in UTC so builds are reproducible. */
export const formatDate = (date: Date, lang: Lang) => date.toLocaleDateString(lang === 'fr' ? 'fr-FR' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
