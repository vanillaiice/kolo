/** Generate two complete static pages, with no production framework or backend. */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { selectRelease, releasesURL } from './releases.mjs';
const root = new URL('./', import.meta.url);
const repo = new URL('../../', root);
const dist = new URL('dist/', root);
const readJSON = async path => JSON.parse(await readFile(new URL(path, root), 'utf8'));
const translations = { en: await readJSON('content/en.json'), fr: await readJSON('content/fr.json') };
const release = selectRelease(await readJSON('content/releases.json'));
const media = await readJSON('content/media.json');
const site = await readJSON('content/site.json');
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
let siteURL = process.env.LANDING_SITE_URL ?? site.url;
if (siteURL) {
  const parsed = new URL(siteURL);
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.search || parsed.hash || parsed.username || parsed.password) throw new Error('LANDING_SITE_URL must be an HTTP(S) base URL without a query or fragment.');
  siteURL = parsed.href.replace(/\/?$/, '/');
}
if (media.video) {
  for (const key of ['src', 'poster', 'captionsEn', 'captionsFr']) {
    if (!/^media\/[\w./-]+$/.test(media.video[key]) || media.video[key].includes('..')) throw new Error(`Invalid video ${key}`);
    await readFile(new URL(`public/${media.video[key]}`, root));
  }
}
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(new URL('public/', root), dist, { recursive: true });
await mkdir(new URL('assets/', dist), { recursive: true });
await mkdir(new URL('kit/', dist));
await cp(new URL('../../assets/brand/kolo-icon.svg', root), new URL('assets/kolo-icon.svg', dist));
await cp(new URL('styles.css', root), new URL('assets/styles.css', dist));
// The page CSP allows only same-origin scripts, so the tested detector is inlined into the one script file.
const detector = (await readFile(new URL('platform.mjs', root), 'utf8')).replace(/^export /m, '');
await writeFile(new URL('assets/site.js', dist), `${detector}\n${await readFile(new URL('site.js', root), 'utf8')}`);
for (const script of ['latin', 'latin-ext']) await cp(new URL(`node_modules/@fontsource-variable/inter/files/inter-${script}-wght-normal.woff2`, repo), new URL(`assets/inter-${script}.woff2`, dist));
await cp(new URL('node_modules/@fontsource-variable/inter/LICENSE', repo), new URL('assets/inter-LICENSE.txt', dist));
await cp(new URL('assets/brand/', repo), new URL('kit/logos/', dist), { recursive: true });
await cp(new URL('docs/screenshots/', repo), new URL('kit/screenshots/', dist), { recursive: true });
await writeFile(new URL('kit/descriptions.txt', dist), `KOLO: ENGLISH\n\n${translations.en.promoDescription}\n\nKOLO: FRANÇAIS\n\n${translations.fr.promoDescription}\n\n${releasesURL}\n`);
const icon = (name) => {
  const paths = {
    sell: '<path d="M4 5h16v14H4zM4 9h16M8 13h3m-3 3h6"/>',
    stock: '<path d="m12 3 9 5v9l-9 5-9-5V8l9-5Zm0 9v10M3 8l9 4 9-4M7.5 5.5l9 5"/>',
    report: '<path d="M4 3v18h17M8 16v-5m5 5V6m5 10v-8"/>',
    windows: '<path d="m3 5 8-1v7H3V5Zm10-1 8-1v8h-8V4ZM3 13h8v7l-8-1v-6Zm10 0h8v8l-8-1v-7Z"/>',
    linux: '<path d="M4 4h16v13H4zM2 21h20M8 8l3 3-3 3m5 0h3"/>',
    android: '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M10 5h4m-3 14h2"/>',
    arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
    guide: '<path d="M6 3h9l4 4v14H6zM15 3v4h4M9 12h7m-7 4h5"/>',
    slides: '<path d="M3 4h18v12H3zM12 16v4m-4 0h8M7 12l3-3 2 2 4-4"/>',
  };
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
};
const analytics = '<script defer src="https://stats.hblabs.xyz/script.js" data-website-id="9e1c1208-ee0e-4ac5-83db-2631a1db803d"></script>';
const brand = '<a class="brand" href="#top" aria-label="KOLO"><img src="../assets/kolo-icon.svg" width="34" height="34" alt=""><span>KOLO<span class="brand-dot">.</span></span></a>';
function head(lang, title, description, slug = '', prefix = '../') {
  const route = `${lang}/${slug}`;
  const absolute = path => siteURL ? `${escape(siteURL)}${path}` : `${prefix}${path}`;
  return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title><meta name="description" content="${escape(description)}"><meta name="theme-color" content="#0c3426">
<meta property="og:type" content="website"><meta property="og:title" content="${escape(title)}"><meta property="og:description" content="${escape(description)}">
<meta property="og:locale" content="${lang === 'fr' ? 'fr_FR' : 'en_GB'}"><meta property="og:locale:alternate" content="${lang === 'fr' ? 'en_GB' : 'fr_FR'}"><meta name="twitter:card" content="summary_large_image">
${siteURL ? `<link rel="canonical" href="${absolute(route)}"><meta property="og:url" content="${absolute(route)}"><meta property="og:image" content="${absolute('assets/share.png')}">` : ''}
<link rel="alternate" hreflang="en" href="${absolute(`en/${slug}`)}"><link rel="alternate" hreflang="fr" href="${absolute(`fr/${slug}`)}"><link rel="alternate" hreflang="x-default" href="${absolute(slug ? `en/${slug}` : '')}">
<link rel="icon" href="${prefix}assets/kolo-icon.svg" type="image/svg+xml"><link rel="stylesheet" href="${prefix}assets/styles.css"><script src="${prefix}assets/site.js" defer></script>${analytics}</head>`;
}

function footerCredit(t) {
  return `<p class="footer-credit">${escape(t.footerMadeBy)} <a href="https://hblabs.xyz">hblabs</a></p>`;
}

function policyFooter(lang, t, prefix = '../') {
  return `<a href="${prefix}${lang}/privacy/">${escape(t.policies.privacyLink)}</a><a href="${prefix}${lang}/cookies/">${escape(t.policies.cookiesLink)}</a>`;
}

function renderPolicy(lang, t, kind) {
  const p = t.policies;
  const policy = p[kind];
  const prefix = '../../';
  const links = policyFooter(lang, t, prefix);
  const contact = site.privacyEmail
    ? `<p>${escape(site.operator)} · <a href="mailto:${escape(site.privacyEmail)}">${escape(site.privacyEmail)}</a></p>`
    : `<p>${escape(p.contactFallback)}</p>`;
  const storage = kind === 'cookies' ? `<section><h2>${escape(p.storageHeading)}</h2><dl class="storage-details">${p.storageColumns.map((label,i) => `<div><dt>${escape(label)}</dt><dd>${escape(p.storageValues[i])}</dd></div>`).join('')}</dl><button class="button secondary" type="button" data-reset-language data-success="${escape(p.resetDone)}" data-error="${escape(p.resetFailed)}" hidden>${escape(p.reset)}</button><p class="hint" data-storage-status role="status"></p></section>` : '';
  const hosting = kind === 'privacy' && site.hostingLogRetention[lang]
    ? `<section><h2>${escape(p.hostingHeading)}</h2><p>${escape(p.hostingProvider)} · ${escape(p.hostingRetention)}: ${escape(site.hostingLogRetention[lang])}</p></section>` : '';
  return `${head(lang, `${policy.title} | KOLO`, policy.description, `${kind}/`, prefix)}
<body id="top"><a class="skip-link" href="#main">${escape(t.skip)}</a>
<header class="header wrap">${brand.replace('href="#top"', `href="../"`).replaceAll('../assets/', '../../assets/')}<nav aria-label="${escape(t.menu)}"><a href="../">${escape(p.home)}</a></nav><div class="languages" aria-label="${escape(t.language)}">${['en','fr'].map(code => `<a href="../../${code}/${kind}/" lang="${code}" hreflang="${code}" ${code === lang ? 'aria-current="page"' : ''}>${code.toUpperCase()}</a>`).join('')}</div></header>
<main id="main" class="section wrap policy-page"><div class="section-heading"><span class="eyebrow">${escape(p.updated)}</span><h1>${escape(policy.title)}</h1><p>${escape(policy.intro)}</p></div>
${policy.sections.map((section,i) => `<section><h2>${escape(section.title)}</h2>${section.paragraphs.map(text => `<p>${escape(text)}</p>`).join('')}</section>${kind === 'cookies' && i === 1 ? storage : ''}`).join('')}
${hosting}<section><h2>${escape(p.contactHeading)}</h2>${contact}</section></main>
<footer class="footer"><div class="wrap"><a href="../">${escape(p.home)}</a><nav aria-label="${escape(t.footerDocs)}">${links}<a href="https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement">GitHub ${escape(p.privacyLink)}</a></nav>${footerCredit(t)}</div></footer></body></html>`;
}

function render(lang, t) {
  const other = lang === 'en' ? 'fr' : 'en';
  const url = release?.url ?? releasesURL;
  const link = (key, label, cls = '') => `<a class="${cls}" href="${escape(release?.assets[key]?.url ?? releasesURL)}">${escape(release?.assets[key] ? label : t.unavailable)}${cls.includes('button') ? icon('arrow') : ''}</a>`;
  const screenshot = (name, alt, eager = false) => `<img src="../media/${name}.webp" alt="${escape(alt)}" width="${name.startsWith('mobile') ? 640 : 1600}" height="${name.startsWith('mobile') ? 1425 : 1028}" ${eager ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async">`;
  const cards = ['windows','linux','android'].map((platform, i) => {
    const second = platform === 'android' ? `<details class="apk-options"><summary>${escape(t.androidSecondary)}</summary><p>${escape(t.androidHelp)}</p><div class="inline-links">${link('arm64','ARM64')} ${link('armv7','ARMv7')}</div></details>` : link(platform === 'windows' ? 'portable' : 'deb', t[`${platform}Secondary`], 'secondary-download');
    return `<article class="download-card" data-platform="${platform}">${icon(platform)}<h3>${['Windows','Linux','Android'][i]}</h3><p>${escape(t[`${platform}Body`])}</p><small>${escape(t.version)} ${escape(release?.assets[platform]?.version ?? 'N/A')}</small>${link(platform,t[`${platform}Primary`],'button primary')}${second}</article>`;
  }).join('');
  const guide = (file, language) => `../guides/kolo-${file}-${language}.pdf`;
  const sources = { 'quick-start': `https://github.com/vanillaiice/kolo/blob/master/docs/guides/quick-start.${lang}.md`, slides: 'https://github.com/vanillaiice/kolo/tree/master/docs/guides/slides' };
  const resources = t.resources.map((r, i) => {
    const file = ['quick-start', 'slides'][i];
    return `<article class="download-card">${icon(['guide','slides'][i])}<h3>${escape(r.title)}</h3><p>${escape(r.body)}</p><small>${escape(r.meta)}</small><a class="button primary" href="${guide(file, lang)}" download>${escape(t.resourcesDownload)}${icon('arrow')}</a><div class="inline-links"><a href="${guide(file, other)}" lang="${other}" hreflang="${other}" download>${escape(t.resourcesOtherLanguage)} ↓</a><a href="${sources[file]}">${escape(r.source)} ↗</a></div></article>`;
  }).join('');
  const gallery = t.gallery.map(([name, title, caption], i) => `<figure class="shot ${name.startsWith('mobile') ? 'mobile-shot' : ''}"><a class="screenshot-link" href="../media/${name}.webp" data-caption="${escape(title)}: ${escape(caption)}">${screenshot(name,title)}</a><figcaption><span class="eyebrow">${escape(i < 3 ? t.desktop : t.android)}</span><h3>${escape(title)}</h3><p>${escape(caption)}</p></figcaption></figure>`).join('');
  const video = media.video ? `<div class="demo-video"><h3>${escape(t.videoTitle)}</h3><video controls preload="none" poster="../${escape(media.video.poster)}"><source src="../${escape(media.video.src)}" type="video/mp4"><track kind="captions" src="../${escape(media.video.captionsEn)}" srclang="en" label="English" ${lang === 'en' ? 'default' : ''}><track kind="captions" src="../${escape(media.video.captionsFr)}" srclang="fr" label="Français" ${lang === 'fr' ? 'default' : ''}><a href="../${escape(media.video.src)}">${escape(t.videoFallback)}</a></video></div>` : '';
  return `${head(lang, t.title, t.description)}
<body id="top"><a class="skip-link" href="#main">${escape(t.skip)}</a><header class="header wrap">${brand}<nav aria-label="${escape(t.menu)}">${t.nav.map((label,i)=>`<a href="#${['features','screenshots','downloads','resources','developers'][i]}">${escape(label)}</a>`).join('')}</nav><div class="languages" aria-label="${escape(t.language)}"><a href="../en/" lang="en" hreflang="en" ${lang==='en'?'aria-current="page"':''}>EN</a><a href="../fr/" lang="fr" hreflang="fr" ${lang==='fr'?'aria-current="page"':''}>FR</a></div></header>
<main id="main"><section class="hero wrap" aria-labelledby="hero-title"><div class="hero-copy"><span class="eyebrow">${escape(t.eyebrow)}</span><h1 id="hero-title">${t.headline.split('\n').map(escape).join('<br>')}</h1><p class="lead">${escape(t.lead)}</p><div class="actions"><a class="button primary" href="#downloads" data-download-for="${escape(t.downloadFor)}">${escape(t.download)}${icon('arrow')}</a><a class="button secondary" href="#features">${escape(t.explore)}</a></div><p class="hero-note"><span class="status-dot"></span>${escape(t.beta)}<span class="note-divider">/</span>${escape(t.heroNote)}</p></div><div class="hero-visual"><div class="desktop-frame"><div class="frame-bar"><span></span><span></span><span></span><b>KOLO · ${escape(t.desktop)}</b></div><a class="screenshot-link" href="../media/desktop-till.webp" data-caption="${escape(t.gallery[0][1])}">${screenshot('desktop-till',t.gallery[0][1],true)}</a></div><div class="phone-frame"><a class="screenshot-link" href="../media/mobile-sell-cart.webp" data-caption="${escape(t.gallery[3][1])}">${screenshot('mobile-sell-cart',t.gallery[3][1],true)}</a></div><p class="demo-note">${escape(t.demo)}</p></div></section>
<div class="benefit-strip"><div class="wrap">${t.strip.map(x=>`<span><span class="check" aria-hidden="true">✓</span>${escape(x)}</span>`).join('')}</div></div>
<section class="section wrap" id="features"><div class="section-heading"><span class="eyebrow">${escape(t.featuresEyebrow)}</span><h2>${escape(t.featuresTitle)}</h2><p>${escape(t.featuresLead)}</p></div><div class="features">${t.features.map((f,i)=>`<article><div class="feature-top">${icon(['sell','stock','report'][i])}<span>${f.number}</span></div><h3>${escape(f.title)}</h3><p>${escape(f.body)}</p><p class="feature-detail">${escape(f.detail)}</p></article>`).join('')}</div></section>
<section class="gallery-section" id="screenshots"><div class="wrap section"><div class="section-heading"><span class="eyebrow">${escape(t.galleryEyebrow)}</span><h2>${escape(t.galleryTitle)}</h2><p>${escape(t.galleryLead)}</p></div><div class="gallery">${gallery}</div><p class="demo-note">${escape(t.demo)}</p>${video}</div></section>
<section class="offline-section"><div class="wrap section offline-layout"><div><span class="eyebrow">${escape(t.offlineEyebrow)}</span><h2>${escape(t.offlineTitle)}</h2><p class="lead">${escape(t.offlineBody)}</p><span class="offline-mark" aria-hidden="true">KOLO<span>.</span></span></div><div class="offline-items">${t.offlineItems.map(([title,body],i)=>`<article><span class="offline-number">0${i+1}</span><div><h3>${escape(title)}</h3><p>${escape(body)}</p></div></article>`).join('')}</div></div></section>
<section class="section wrap" id="downloads"><div class="section-heading"><span class="eyebrow">${escape(t.downloadsEyebrow)}</span><h2>${escape(t.downloadsTitle)}</h2><p>${escape(t.downloadsLead)}</p><p class="release-line">${release ? `${escape(t.release)} <strong>${escape(release.tag)}</strong> · ${release.beta ? escape(t.beta) : ''}` : escape(t.releaseFallback)} <a href="${escape(url)}">${escape(t.releaseNotes)} ↗</a></p></div>${['ios','mac'].map(platform => `<p class="platform-note" data-platform-note="${platform}" role="status" hidden>${escape(t[`${platform}Note`])}</p>`).join('')}<div class="download-grid" data-suggested="${escape(t.suggestedBadge)}">${cards}</div><p class="install-note">${escape(t.installerNote)}</p><div class="coming-soon">${t.stores.map(x=>`<span><strong>${escape(x)}</strong><span>${escape(t.coming)}</span></span>`).join('')}</div></section>
<section class="section wrap" id="resources"><div class="section-heading"><span class="eyebrow">${escape(t.resourcesEyebrow)}</span><h2>${escape(t.resourcesTitle)}</h2><p>${escape(t.resourcesLead)}</p></div><div class="download-grid resource-grid">${resources}</div></section>
<section class="developer-section" id="developers"><div class="wrap section developer-layout"><div><span class="eyebrow">${escape(t.developersEyebrow)}</span><h2>${escape(t.developersTitle)}</h2><p>${escape(t.developersBody)}</p><div class="actions"><a class="button primary" href="https://github.com/vanillaiice/kolo/blob/master/docs/implementation/selfhost.md">${escape(t.selfhost)}${icon('arrow')}</a><a class="button secondary" href="https://github.com/vanillaiice/kolo">${escape(t.source)} ↗</a></div></div><ul class="tech-list">${t.developersDetails.map(x=>`<li>${escape(x)}</li>`).join('')}</ul></div></section>
<section class="section wrap promoters" id="promoters"><div><span class="eyebrow">${escape(t.promotersEyebrow)}</span><h2>${escape(t.promotersTitle)}</h2><p>${escape(t.promotersBody)}</p><p class="hint">${escape(t.promotersNote)}</p></div><div class="kit"><img src="../assets/kolo-icon.svg" alt="KOLO" width="80" height="80"><a href="../kit/logos/kolo-icon.svg" download>${escape(t.logos)} ↓</a><a href="../kit/descriptions.txt" download>${escape(t.copy)} ↓</a><details><summary>${escape(t.screenshots)}</summary><ul>${t.gallery.map(([name,title])=>`<li><a href="../kit/screenshots/${name}.png" download>${escape(title)} ↓</a></li>`).join('')}</ul></details></div></section>
<section class="section wrap faq"><h2>${escape(t.faqTitle)}</h2><div>${t.faq.map(([q,a])=>`<details><summary>${escape(q)}</summary><p>${escape(a)}</p></details>`).join('')}</div></section></main>
<footer class="footer"><div class="wrap">${brand}<p>${escape(t.footerLine)}</p><nav aria-label="${escape(t.footerDocs)}"><a href="https://github.com/vanillaiice/kolo/blob/master/docs/README.md">${escape(t.footerDocs)}</a><a href="https://github.com/vanillaiice/kolo/blob/master/LICENSE">${escape(t.footerLicense)}</a><a href="#promoters">${escape(t.promotersEyebrow)}</a><a href="#top">${escape(t.top)} ↑</a>${policyFooter(lang, t)}</nav>${footerCredit(t)}</div></footer>
<dialog class="lightbox" aria-label="${escape(t.galleryTitle)}"><button type="button" aria-label="${escape(t.close)}">×</button><img alt=""><p></p></dialog></body></html>`;
}
for (const [lang, t] of Object.entries(translations)) {
  await mkdir(new URL(`${lang}/`, dist));
  await writeFile(new URL(`${lang}/index.html`, dist), render(lang,t));
  for (const kind of ['privacy', 'cookies']) {
    await mkdir(new URL(`${lang}/${kind}/`, dist));
    await writeFile(new URL(`${lang}/${kind}/index.html`, dist), renderPolicy(lang,t,kind));
  }
}
await writeFile(new URL('index.html', dist), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>KOLO: English / Français</title><meta name="description" content="KOLO: offline shop management / Gestion de boutique hors ligne"><link rel="icon" href="assets/kolo-icon.svg"><link rel="stylesheet" href="assets/styles.css"><script src="assets/site.js" defer></script>${analytics}</head><body class="language-page" data-language-entry><main><img src="assets/kolo-icon.svg" width="80" height="80" alt="KOLO"><h1>KOLO<span class="brand-dot">.</span></h1><p>Choose your language / <span lang="fr">Choisissez votre langue</span></p><div class="actions"><a class="button primary" href="en/" lang="en">English</a><a class="button secondary" href="fr/" lang="fr">Français</a></div></main></body></html>`);
const crawlBase = siteURL ?? 'http://localhost:4173/';
const routes = ['', ...['en','fr'].flatMap(lang => [`${lang}/`, `${lang}/privacy/`, `${lang}/cookies/`])];
const sitemap = routes.map(route => {
  const slug = route.split('/').slice(1).join('/');
  const alternates = route ? ['en','fr'].map(lang => `<xhtml:link rel="alternate" hreflang="${lang}" href="${escape(crawlBase)}${lang}/${slug}"/>`).join('') : '';
  return `<url><loc>${escape(crawlBase)}${route}</loc>${alternates}</url>`;
}).join('\n');
await writeFile(new URL('sitemap.xml', dist), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${sitemap}
</urlset>\n`);
await writeFile(new URL('robots.txt', dist), `User-agent: *\nAllow: /\n\nSitemap: ${crawlBase}sitemap.xml\n`);

console.log(`Built English and French pages in ${fileURLToPath(dist)} (${release?.tag ?? 'release-page fallback'}).`);
