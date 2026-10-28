/** schema.org structured data for search engines, built per page from the shared copy and release. */
import { release, releasesURL, repoURL, site, translations, type Lang } from './content';

/** Turns a site-relative path into an absolute URL (or a base-relative one when no site URL is set). */
export type Absolute = (path: string) => string;

const organization = { '@type': 'Organization', name: site.operator, url: 'https://hblabs.xyz' };

/** The website and the app it presents, for a language home page. */
export function homeSchema(lang: Lang, absolute: Absolute) {
  const t = translations[lang];
  return [
    { '@context': 'https://schema.org', '@type': 'WebSite', name: 'KOLO', url: absolute(`${lang}/`), inLanguage: lang, publisher: organization },
    {
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: 'KOLO',
      description: t.description,
      url: absolute(`${lang}/`),
      applicationCategory: 'BusinessApplication',
      operatingSystem: 'Windows, Linux, Android',
      inLanguage: ['en', 'fr'],
      ...(release && { softwareVersion: release.tag.replace(/^v/, '') }),
      downloadUrl: release?.url ?? releasesURL,
      license: `${repoURL}/blob/master/LICENSE`,
      image: absolute('assets/share.png'),
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'XAF' },
      author: organization,
    },
  ];
}

/** A blog index. */
export const blogSchema = (lang: Lang, absolute: Absolute) => [{ '@context': 'https://schema.org', '@type': 'Blog', name: translations[lang].blog.title, description: translations[lang].blog.description, url: absolute(`${lang}/blog/`), inLanguage: lang, publisher: organization }];

/** A blog post and its breadcrumb trail (home, blog, post). */
export function postSchema(lang: Lang, slug: string, data: { title: string; description: string; date: Date; updated?: Date }, absolute: Absolute) {
  const t = translations[lang];
  const url = absolute(`${lang}/blog/${slug}/`);
  return [
    {
      '@context': 'https://schema.org',
      '@type': 'BlogPosting',
      headline: data.title,
      description: data.description,
      datePublished: data.date.toISOString(),
      dateModified: (data.updated ?? data.date).toISOString(),
      inLanguage: lang,
      url,
      mainEntityOfPage: url,
      image: absolute('assets/share.png'),
      author: organization,
      publisher: organization,
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [['KOLO', `${lang}/`], [t.blog.title, `${lang}/blog/`], [data.title, `${lang}/blog/${slug}/`]].map(([name, path], i) => ({ '@type': 'ListItem', position: i + 1, name, item: absolute(path) })),
    },
  ];
}
