/**
 * Zero-dependency static server for the on-device harness.
 *
 * Android Chrome only grants the Geolocation API in a "secure context":
 * https, or http://localhost. We serve harness/ on localhost and use
 *   adb reverse tcp:<port> tcp:<port>
 * so the phone's http://localhost:<port> tunnels over USB to this server.
 * Load the page while USB is connected, press Start, then UNPLUG and let the
 * arm run on battery (the page needs no network after load).
 *
 * Usage:
 *   node serve.mjs            # port 8099
 *   node serve.mjs 9000       # custom port
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, 'harness');
const PORT = parseInt(process.argv[2] || '8099', 10);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent((req.url || '/').split('?')[0]);
    if (p === '/' || p === '') p = '/index.html';
    const file = normalize(join(ROOT, p));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[serve] harness at http://localhost:${PORT}/`);
  console.log(`[serve] on the PHONE (USB connected) run once:  adb reverse tcp:${PORT} tcp:${PORT}`);
  console.log('[serve] then open in the phone\'s Chrome:');
  for (const arm of ['continuous', 'naive', 'gated']) {
    console.log(`          http://localhost:${PORT}/index.html?arm=${arm}&autostart=1`);
  }
  console.log('[serve] load the page, press Start, UNPLUG usb, let it run. Ctrl+C to stop the server.');
});
