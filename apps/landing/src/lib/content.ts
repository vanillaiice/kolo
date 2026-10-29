/** Build-time content shared by every page: copy, release snapshot, media and site settings. */
import en from '../../content/en.json';
import fr from '../../content/fr.json';
import releases from '../../content/releases.json';
import media from '../../content/media.json';
import site from '../../content/site.json';
import { selectRelease, releasesURL } from './releases.mjs';
import { resolveAnalytics } from './analytics.mjs';

export const languages = ['en', 'fr'] as const;
export type Lang = (typeof languages)[number];
export const translations: Record<Lang, typeof en> = { en, fr };
export const release = selectRelease(releases);
export { media, site, releasesURL };

export const repoURL = 'https://github.com/vanillaiice/kolo';
/** Umami visit statistics from `site.json` or `LANDING_UMAMI_*`, or null when off (see analytics.mjs). */
export const analytics = resolveAnalytics(site.analytics, process.env);

const base = import.meta.env.BASE_URL.replace(/\/?$/, '/');
/** A site-relative path (no leading slash) under the configured base path. */
export const href = (path = '') => `${base}${path}`;

/** The other language, for language switches and alternate downloads. */
export const other = (lang: Lang): Lang => (lang === 'en' ? 'fr' : 'en');

/**
 * Base URL of the external media host, or null while every video is served from `public/media`.
 * Its origin must also be in the Caddy CSP `media-src` and `img-src`, and the privacy notice
 * names it automatically; `check.mjs` enforces the CSP.
 */
export const mediaBase = (site.mediaBase as string | null) ?? null;
if (mediaBase) {
  const parsed = new URL(mediaBase);
  if (parsed.protocol !== 'https:' || parsed.search || parsed.hash || parsed.username || parsed.password || !mediaBase.endsWith('/')) throw new Error('mediaBase must be an HTTPS base URL ending in / without a query or fragment.');
}
export const mediaOrigin = mediaBase ? new URL(mediaBase).origin : null;

/**
 * Resolve a video, poster or caption reference: `media/…` paths are served by this site,
 * absolute URLs must sit under `mediaBase`. Anything else fails the build.
 */
export function mediaURL(path: string): string {
  if (/^https?:/.test(path)) {
    if (!mediaBase || !path.startsWith(mediaBase) || path.includes('..')) throw new Error(`Media URL ${path} is not under site.json mediaBase`);
    return path;
  }
  if (!/^media\/[\w./-]+$/.test(path) || path.includes('..')) throw new Error(`Invalid media path ${path}`);
  return href(path);
}

if (media.video) for (const key of ['src', 'poster', 'captionsEn', 'captionsFr'] as const) mediaURL(media.video[key]);

export const walkthroughPlatforms = ['desktop', 'android'] as const;
export type WalkthroughPlatform = (typeof walkthroughPlatforms)[number];
const walkthroughIds = media.walkthroughs as Record<Lang, Record<WalkthroughPlatform, string | null>>;
for (const lang of languages) for (const platform of walkthroughPlatforms) {
  const id = walkthroughIds[lang][platform];
  if (id !== null && !/^[\w-]{11}$/.test(id)) throw new Error(`Invalid YouTube ID for the ${lang} ${platform} walkthrough: ${id}`);
}

/** Origin of the embedded walkthrough player; the Caddy CSP `frame-src` must allow it. */
export const youtubeEmbedOrigin = 'https://www.youtube-nocookie.com';
/** Whether any walkthrough is configured, so the policies describe the YouTube player. */
export const walkthroughsOn = languages.some(lang => walkthroughPlatforms.some(platform => walkthroughIds[lang][platform]));

/**
 * The YouTube walkthrough for a page language and platform, falling back to the other language's
 * video until this one is uploaded; null when neither exists. `embed` is the player address the
 * page loads only when the visitor presses play.
 */
export function walkthrough(lang: Lang, platform: WalkthroughPlatform): { url: string; embed: string; lang: Lang } | null {
  for (const videoLang of [lang, other(lang)]) {
    const id = walkthroughIds[videoLang][platform];
    if (id) return { url: `https://www.youtube.com/watch?v=${id}`, embed: `${youtubeEmbedOrigin}/embed/${id}?autoplay=1&rel=0&hl=${lang}&cc_lang_pref=${lang}`, lang: videoLang };
  }
  return null;
}
