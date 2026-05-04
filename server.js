const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3010);
const TSN_API_BASE_URL = String(process.env.TSN_API_BASE_URL || '').replace(/\/$/, '');
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

function send(res, statusCode, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer'
  });
  res.end(body);
}

function safeStaticPath(urlPath) {
  const cleanPath = decodeURIComponent(urlPath.split('?')[0]).replace(/^\/+/, '') || 'index.html';
  const resolved = path.resolve(PUBLIC_DIR, cleanPath);
  if (!resolved.startsWith(PUBLIC_DIR)) return null;
  return resolved;
}

const server = http.createServer((req, res) => {
  const urlPath = req.url || '/';

  if (urlPath === '/healthz') {
    return send(res, 200, JSON.stringify({ ok: true, service: 'tsn-stock' }), 'application/json; charset=utf-8');
  }

  if (urlPath === '/config.js') {
    return send(
      res,
      200,
      `window.TSN_STOCK_CONFIG = ${JSON.stringify({ apiBaseUrl: TSN_API_BASE_URL })};`,
      'application/javascript; charset=utf-8'
    );
  }

  let filePath = safeStaticPath(urlPath);
  if (!filePath) return send(res, 403, 'Forbidden');

  fs.stat(filePath, (statError, stats) => {
    if (statError || !stats.isFile()) {
      filePath = path.join(PUBLIC_DIR, 'index.html');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (readError, data) => {
      if (readError) return send(res, 500, 'Server error');
      return send(res, 200, data, contentType);
    });
  });
});

server.listen(PORT, () => {
  console.log(`TSN Stock dependency-free server running on port ${PORT}`);
  if (!TSN_API_BASE_URL) {
    console.warn('Missing TSN_API_BASE_URL. Set it to your original TSN website URL, for example https://your-tsn.onrender.com');
  }
});
