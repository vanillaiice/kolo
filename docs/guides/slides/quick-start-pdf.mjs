// Prints the quick-start guides (../quick-start.{en,fr}.md) to A4 PDFs in dist/.
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';
import { chromium } from 'playwright-chromium';

const here = new URL('.', import.meta.url);
const markdown = new MarkdownIt({ html: false, linkify: true, typographer: false });
const icon = await readFile(new URL('../../../assets/brand/kolo-icon.svg', import.meta.url), 'utf8');

// Same colours as the landing page and style.css.
const css = `
  @page { size: A4; margin: 13mm 15mm 14mm; }
  body { font-family: Inter, 'Segoe UI', system-ui, sans-serif; color: #142b21; font-size: 9.7pt; line-height: 1.33; }
  header { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
  header svg { width: 34px; height: 34px; }
  h1 { color: #006c43; font-size: 22pt; margin: 0; }
  h2 { color: #006c43; font-size: 13.5pt; margin: 11px 0 4px; padding-bottom: 3px; border-bottom: 2px solid #edf4ef; break-after: avoid; }
  strong { color: #0c3426; }
  a { color: #006c43; }
  code { font-size: 9pt; background: #edf4ef; padding: 0 3px; border-radius: 3px; }
  table { border-collapse: collapse; width: 100%; font-size: 9.5pt; margin: 6px 0; }
  th, td { text-align: left; padding: 4px 7px; border-bottom: 1px solid #cedbd2; vertical-align: top; }
  th { background: #edf4ef; }
  blockquote { margin: 8px 0; padding: 6px 12px; background: #edf4ef; border-left: 5px solid #e8475c; border-radius: 4px; }
  blockquote p { margin: 0; }
  ul, ol { padding-left: 20px; } li { margin: 2px 0; }
  li, table, blockquote { break-inside: avoid; }
  hr { border: 0; border-top: 1px solid #cedbd2; margin: 18px 0 8px; }
  hr ~ p { color: #465d50; font-size: 9pt; }
`;

await mkdir(new URL('dist/', here), { recursive: true });
const browser = await chromium.launch();
try {
  for (const language of ['en', 'fr']) {
    const source = await readFile(new URL(`../quick-start.${language}.md`, here), 'utf8');
    // The link to the other language points at a .md file, which means nothing in a PDF.
    const body = markdown.render(source.replace(/ ?\*\[[^\]]+\]\(quick-start\.\w+\.md\)\*/, ''))
      .replace(/<h1>(.*?)<\/h1>/, `<header>${icon}<h1>$1</h1></header>`);
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><html lang="${language}"><head><meta charset="utf-8"><style>${css}</style></head><body>${body}</body></html>`);
    const output = fileURLToPath(new URL(`dist/kolo-quick-start-${language}.pdf`, here));
    await page.pdf({ path: output, format: 'A4', printBackground: true, preferCSSPageSize: true });
    await page.close();
    console.log(`exported ${output}`);
  }
} finally {
  await browser.close();
}
