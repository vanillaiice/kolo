/** Product screenshots, resized at build time from the originals in `docs/screenshots`. */
import type { ImageMetadata } from 'astro';
import { getImage } from 'astro:assets';

const originals = import.meta.glob<{ default: ImageMetadata }>('../../../../docs/screenshots/*.png');

/** Widths per frame: phone shots never show wider than about 160 CSS px, desktop ones about 660. */
const widths = { desktop: [480, 800, 1200, 1600, 2048], mobile: [320, 480] };

export interface Screenshot {
  width: number;
  height: number;
  /** Largest WebP, for the lightbox and the no-JavaScript link. */
  full: string;
  /** `<img src>` for browsers that ignore `<source>`. */
  fallback: string;
  sources: { type: string; srcset: string }[];
}

/** Resized AVIF and WebP variants of `docs/screenshots/<name>.png`; unknown names fail the build. */
export async function screenshot(name: string): Promise<Screenshot> {
  const load = originals[`../../../../docs/screenshots/${name}.png`];
  if (!load) throw new Error(`No docs/screenshots/${name}.png`);
  const image = (await load()).default;
  const sizes = widths[name.startsWith('mobile') ? 'mobile' : 'desktop'].filter(width => width < image.width);
  const variants = async (format: 'avif' | 'webp') => Promise.all(sizes.map(async width => `${(await getImage({ src: image, width, format })).src} ${width}w`));
  const [avif, webp, full] = await Promise.all([variants('avif'), variants('webp'), getImage({ src: image, format: 'webp', width: Math.min(image.width, 2048) })]);
  // Browsers without <picture> get a mid-size WebP rather than the largest file.
  const fallback = webp.filter((_, i) => sizes[i] <= 1200).at(-1)!.split(' ')[0];
  return { width: image.width, height: image.height, full: full.src, fallback, sources: [{ type: 'image/avif', srcset: avif.join(', ') }, { type: 'image/webp', srcset: webp.join(', ') }] };
}
