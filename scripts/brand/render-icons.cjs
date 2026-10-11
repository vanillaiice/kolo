/**
 * Electron entry that renders the brand SVGs to 1024 px PNGs with Chromium, so no SVG
 * rasterizer is needed. Run through scripts/render-icons.mjs, which supplies a display.
 * Arguments: pairs of `input.svg output.png`.
 */
const { app, BrowserWindow } = require("electron");
const { readFileSync, writeFileSync } = require("node:fs");
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1024, height: 1024, show: false, frame: false, transparent: true, useContentSize: true,
    webPreferences: { offscreen: true } });
  const pairs = process.argv.slice(process.argv.indexOf("--") + 1);
  for (let index = 0; index < pairs.length; index += 2) {
    const svg = readFileSync(pairs[index], "utf8");
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block}</style>${svg}`)}`);
    await new Promise(resolve => setTimeout(resolve, 200));
    const image = await window.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
    writeFileSync(pairs[index + 1], image.resize({ width: 1024, height: 1024, quality: "best" }).toPNG());
  }
  app.quit();
}).catch(error => { process.stderr.write(`${error.stack}\n`); app.exit(1); });
