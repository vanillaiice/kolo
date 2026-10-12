/** Serve only the built site, including under LANDING_BASE_PATH for subpath QA. */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(fileURLToPath(new URL('dist/', import.meta.url))); 
const port = Number(process.env.PORT ?? 4173);
const base = (process.env.LANDING_BASE_PATH ?? '/').replace(/\/?$/, '/');
const types = { '.html':'text/html; charset=utf-8', '.css':'text/css', '.js':'text/javascript', '.svg':'image/svg+xml', '.png':'image/png', '.webp':'image/webp', '.woff2':'font/woff2', '.txt':'text/plain; charset=utf-8', '.xml':'application/xml', '.mp4':'video/mp4', '.vtt':'text/vtt; charset=utf-8' };
createServer(async (req,res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (!path.startsWith(base)) { res.writeHead(404).end(); return; }
    let file = resolve(root, `.${sep}${path.slice(base.length)}`);
    if (file !== root && !file.startsWith(`${root}${sep}`)) { res.writeHead(403).end(); return; }
    if ((await stat(file)).isDirectory()) {
      if (!path.endsWith('/')) { res.writeHead(302,{ Location:`${path}/` }).end(); return; }
      file = resolve(file,'index.html');
    }
    const data = await readFile(file);
    res.writeHead(200,{ 'Content-Type':types[extname(file)] ?? 'application/octet-stream', 'X-Content-Type-Options':'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch { res.writeHead(404).end('Not found'); }
}).listen(port,'127.0.0.1',()=>console.log(`KOLO landing: http://127.0.0.1:${port}${base}`));
