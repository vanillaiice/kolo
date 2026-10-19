# User guides

Guides for people trying kolo for the first time, in English and French.

| Guide | English | Français |
| --- | --- | --- |
| Quick start | [quick-start.en.md](quick-start.en.md) | [quick-start.fr.md](quick-start.fr.md) |
| Presentation (Slidev) | [slides/slides.en.md](slides/slides.en.md) | [slides/slides.fr.md](slides/slides.fr.md) |

Screen labels in **bold** match the app text in `apps/desktop/src/renderer/text.ts`
and `apps/mobile/src/app/strings*.ts`. Update the guides when those labels change.

## Presenting the slides

The deck is a [Slidev](https://sli.dev) project, kept outside the npm workspace so it
adds nothing to `npm run check`.

```sh
cd docs/guides/slides
npm install
npm run dev:en      # or dev:fr; press P for presenter mode with the trainer notes
npm run export:en   # PDF (first run: npx playwright install chromium)
npm run export:quick-start  # quick-start PDFs
npm run export:landing      # all four PDFs, copied to apps/landing/public/guides
```

Each slide's speaker notes (the HTML comment at its end) hold the trainer script.
Screenshots come from `docs/screenshots` and the logo from `assets/brand`, via the
symlinks in `slides/public`.

For a training session with sample data, generate a demo backup with the CLI
(`npm run kolo -- demo --out demo.kolo-backup`, see [apps/cli](../../apps/cli/README.md))
and restore it with **Import a file** on a spare device.
