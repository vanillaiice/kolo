# KOLO landing page

Static English/French website built with HTML, CSS, JavaScript and Node's standard
library. Both language pages work without JavaScript. From the repository root:

```sh
npm run dev:landing              # build and preview at http://127.0.0.1:4173
npm run check:landing            # build, content/link checks and release tests
npm run refresh:landing-releases # fetch GitHub releases and rebuild
npm run build:landing            # offline build from the saved snapshot
```

Deploy `apps/landing/dist` to any static host. The public URL comes from
`content/site.json`; override it with `LANDING_SITE_URL`. For subpath previews,
set `LANDING_BASE_PATH` (for example `/kolo/`). Builds emit bilingual policy pages,
social metadata, `sitemap.xml` and `robots.txt`.

## Deployment

The Kamal service uses Caddy behind kamal-proxy. Configure the server, SSH user
and domain in `config/deploy.yml`, point DNS at the server, and set the public URL.
Requires Kamal 2.12, compatible Ruby, Node.js, Docker/Buildx and SSH access.
Use `KAMAL_BIN` to override the `kamal` executable. From the repository root:

```sh
apps/landing/bin/deploy config
apps/landing/bin/deploy setup # first publication
apps/landing/bin/deploy       # updates
apps/landing/bin/deploy logs
apps/landing/bin/deploy rollback <version>
```

Setup and deployment rebuild and validate before publishing. Images use the
local `localhost:5555` registry forwarded over SSH. kamal-proxy handles HTTPS;
Caddy serves the site and `/up`. Verify both languages, policy pages, assets,
`/up`, missing-path 404s and other sites sharing the proxy after deployment.

## Editing

| Path | Purpose |
| --- | --- |
| `content/site.json` | Public URL, operator/contact details and hosting notices |
| `content/en.json`, `content/fr.json` | Visitor copy; keep keys and array lengths aligned |
| `content/releases.json` | Saved GitHub release snapshot; refresh after publishing |
| `build.mjs`, `styles.css` | Layout, metadata and styles |
| `public/media` | Optimized screenshots from `docs/screenshots` |
| `public/guides` | Quick-start and slide PDFs; regenerate with `npm run export:landing` in `docs/guides/slides` |
| `public/assets/share.svg`, `share.png` | Social image; regenerate PNG after SVG edits |

Downloads use uploaded, nonempty assets from the newest shared `vX.Y.Z` release,
including prereleases. Missing assets link to GitHub Releases. Builds require no
GitHub access. Logos come from `assets/brand`; the promoter kit is generated.

Regenerate screenshot derivatives with ImageMagick:

```sh
magick docs/screenshots/desktop-till.png -resize 1600x -quality 86 apps/landing/public/media/desktop-till.webp
magick docs/screenshots/mobile-cart.png -resize 640x -quality 86 apps/landing/public/media/mobile-cart.webp
```

For a demo video, add an MP4, poster and English/French WebVTT captions to
`public/media`, then replace `video: null` in `content/media.json`:

```json
{"video": {
  "src": "media/demo.mp4",
  "poster": "media/demo-poster.webp",
  "captionsEn": "media/demo-en.vtt",
  "captionsFr": "media/demo-fr.vtt"
}}
```

## Privacy

Policy pages describe this website's local assets, language preference, server
logs and GitHub links. The script stores `kolo-landing-language` only after an
explicit language choice; the cookie page can remove it. No analytics or embedded
trackers are included. Set log retention in both languages once confirmed from
the host. Update notices when hosting, cookies, forms, media or storage change.

Licensed under [GPL-3.0-only](LICENSE).
