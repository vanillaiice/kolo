# KOLO landing page

Static English and French pages. Plain HTML/CSS, a little progressive JavaScript,
Node's standard library, and the app's existing Inter font. No new dependencies,
backend, accounts or client-side framework.

From the repository root:

```sh
npm run dev:landing              # build and preview at http://127.0.0.1:4173
npm run check:landing            # build, content/link checks, release-selection tests
npm run refresh:landing-releases # fetch public GitHub releases, then rebuild
npm run build:landing            # offline build from the saved snapshot
```

Deploy the contents of `apps/landing/dist` to any static host. Both `/en/` and `/fr/`
are complete pages and work without JavaScript. The root offers language links;
with JavaScript it uses a saved language or browser preference. URLs are relative
so deployment under a subdirectory also works. The preview binds to loopback.

The public base URL is configured as `https://kolo.hblabs.xyz/` in
`content/site.json`. Every build emits `sitemap.xml` and `robots.txt`, including
the English/French landing, privacy and cookie pages. Canonical URLs, bilingual
alternates and social preview metadata use that base URL. Override it for another
deployment (include a subpath if needed):

```sh
LANDING_SITE_URL=https://example.com/kolo/ npm run build:landing
LANDING_BASE_PATH=/kolo/ npm run dev:landing # optional subpath preview
```

## Editing

- `content/site.json`: public URL, hblabs operator identity, privacy contact
  (`contact@hblabs.xyz`) and self-hosting details. Set the real access-log retention
  text in English/French when it is confirmed from the server configuration.
- `content/en.json` and `content/fr.json`: all visitor-facing copy. Keep their
  keys and array lengths aligned; the check command verifies this.
- `build.mjs`: shared page layout, metadata and assets. `styles.css`: brand tokens
  copied from the desktop app, responsive layout and print styles.
- `content/releases.json`: a public release snapshot. Refresh after publishing a
  release and rebuild the site. Builds deliberately never need GitHub or a token.
  The newest published shared `vX.Y.Z` release is used, including prereleases;
  only uploaded, nonempty assets from that exact release become download links.
  Missing assets fall back to the releases page. Desktop and Android versions can
  differ. Google Play, F-Droid and iOS remain text labels until actually available.
- `public/media`: optimized WebP screenshots, derived from `docs/screenshots`.
  Captures currently have English UI; all page descriptions and image captions
  are bilingual. Refresh captures when the app UI changes. PNG originals are
  copied into the downloadable promoter kit during the build.
- `public/assets/share.png`: social sharing image, generated from `share.svg`.
  Regenerate the sharing PNG from the SVG with a browser capture or SVG renderer.
  The app logo comes directly from `assets/brand`. Promoter descriptions are
  generated from `promoDescription` in each language, not maintained separately.

To regenerate screenshot derivatives with ImageMagick (maintainer tool only):

```sh
magick docs/screenshots/desktop-till.png -resize 1600x -quality 86 apps/landing/public/media/desktop-till.webp
magick docs/screenshots/mobile-cart.png -resize 640x -quality 86 apps/landing/public/media/mobile-cart.webp
```

## Optional demonstration video

No fabricated video or placeholder player is shown. Add a real MP4, poster and
English/French WebVTT captions to `public/media`, then replace `video: null` in
`content/media.json` with:

```json
{
  "video": {
    "src": "media/demo.mp4",
    "poster": "media/demo-poster.webp",
    "captionsEn": "media/demo-en.vtt",
    "captionsFr": "media/demo-fr.vtt"
  }
}
```

The build checks all files exist. The player has controls, captions, no autoplay
and `preload="none"`. Prefer a short, compressed MP4 over a large GIF.

## Privacy and browser storage

The footer links to `/en/privacy/`, `/en/cookies/` and their French equivalents.
These notices cover this website, not the desktop/mobile apps or a sync service.
They describe local assets, the absence of application-added HTTP cookies,
analytics and embedded trackers, browser-only language preferences, server
requests/logging and links to GitHub. The public website is self-hosted by hblabs;
log retention has not yet been supplied, so no retention duration is invented.

The script stores `kolo-landing-language` only after an explicit EN/FR choice.
The cookie page offers a button to remove it; navigating another page does not
silently recreate it. Browser-settings instructions remain visible without
JavaScript. No third-party consent library is added for this preference.

Before changing hosting, adding analytics, forms, embedded media or storage,
update the notices to match the deployed behavior and add any applicable consent
controls. Host-added cookies or security systems must also be documented.
Drafting references: [CNIL cookie guidance](https://www.cnil.fr/fr/cookies-et-autres-traceurs/que-dit-la-loi)
and [privacy information guidance](https://www.cnil.fr/fr/conformite-rgpd-information-des-personnes-et-transparence).
