// Local visual QA only. Serves the production UI with an in-memory IPC fixture.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../ui');
const fixture = fs.readFileSync(path.join(__dirname, 'preview-fixture.js'), 'utf8');
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript; charset=utf-8'); res.end(fixture); return; }
  const file = path.resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  try {
    let data = fs.readFileSync(file);
    if (file.endsWith('index.html')) data = data.toString().replace('<script type="module" src="js/main.js">', '<script src="/fixture.js"></script><script type="module" src="js/main.js">');
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' })[path.extname(file)] + '; charset=utf-8');
    res.end(data);
  } catch { res.writeHead(404).end(); }
}).listen(4173, '127.0.0.1', () => console.log('HeartWrite UI preview: http://127.0.0.1:4173'));
