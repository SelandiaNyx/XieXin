// 本地视觉验收用：在浏览器里跑真实界面，但 IPC 换成一整套内存示例数据。
// 只读、无磁盘访问，不会碰到真实稿件。
//
//   node tests/preview-server.cjs                 # http://127.0.0.1:4173
//   PREVIEW_PORT=4180 node tests/preview-server.cjs
//
// 也作为模块被 tests/mobile-ui.test.mjs 直接复用（同进程起服务，不用起子进程）。

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../ui');
const fixture = fs.readFileSync(path.join(__dirname, 'preview-fixture.js'), 'utf8');

function createPreviewServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/fixture.js') {
      res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      res.end(fixture);
      return;
    }
    const file = path.resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    try {
      let data = fs.readFileSync(file);
      if (file.endsWith('index.html')) {
        data = data.toString().replace('<script type="module" src="js/main.js">',
          '<script src="/fixture.js"></script><script type="module" src="js/main.js">');
      }
      const type = ({ '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' })[path.extname(file)];
      res.setHeader('Content-Type', `${type}; charset=utf-8`);
      res.end(data);
    } catch { res.writeHead(404).end(); }
  });
}

/** 起服务并返回 server；port 传 0 让系统分配空闲端口，用 server.address().port 取真实端口。 */
function startPreviewServer(port = Number(process.env.PREVIEW_PORT) || 4173, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = createPreviewServer();
    server.once('error', (e) => {
      reject(e.code === 'EADDRINUSE'
        ? new Error(`端口 ${port} 已被占用（可以用 PREVIEW_PORT 换一个）`)
        : e);
    });
    server.listen(port, host, () => resolve(server));
  });
}

module.exports = { createPreviewServer, startPreviewServer };

if (require.main === module) {
  startPreviewServer()
    .then((server) => {
      console.log(`HeartWrite UI preview: http://127.0.0.1:${server.address().port}`);
    })
    .catch((e) => {
      console.error(String(e.message || e));
      process.exit(1);
    });
}
