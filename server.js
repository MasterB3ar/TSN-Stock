const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3010);
const TSN_API_BASE_URL = String(process.env.TSN_API_BASE_URL || '').replace(/\/$/, '');
const PUBLIC_DIR = path.join(__dirname, 'public');

// Optional MongoDB Atlas Data API persistence. This keeps the app dependency-free,
// so Render does not have to install the MongoDB npm driver.
const DATA_API_URL = String(process.env.MONGODB_DATA_API_URL || '')
  .replace(/\/$/, '')
  .replace(/\/action\/?$/, '');
const DATA_API_KEY = String(process.env.MONGODB_DATA_API_KEY || '');
const DATA_SOURCE = String(process.env.MONGODB_DATA_SOURCE || 'Cluster0');
const DATABASE = String(process.env.MONGODB_DATABASE || 'tsn_stock');
const COLLECTION = String(process.env.MONGODB_COLLECTION || 'stockSnapshots');
const MAX_HISTORY_POINTS = Number(process.env.TSN_STOCK_MAX_HISTORY || 720);
const REFRESH_INTERVAL_MS = Number(process.env.TSN_STOCK_REFRESH_MS || 20000);

const PERSISTENCE_ENABLED = Boolean(DATA_API_URL && DATA_API_KEY && DATA_SOURCE && DATABASE && COLLECTION);

let cachedPayload = null;
let cachedAt = 0;
let memoryHistory = [];

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

function sendJson(res, statusCode, payload) {
  send(res, statusCode, JSON.stringify(payload, null, 2), 'application/json; charset=utf-8');
}

function safeStaticPath(urlPath) {
  const cleanPath = decodeURIComponent(urlPath.split('?')[0]).replace(/^\/+/, '') || 'index.html';
  const resolved = path.resolve(PUBLIC_DIR, cleanPath);
  if (!resolved.startsWith(PUBLIC_DIR)) return null;
  return resolved;
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status} from ${url}`);
      error.statusCode = response.status;
      error.data = data;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

async function dataApiAction(action, body) {
  if (!PERSISTENCE_ENABLED) throw new Error('MongoDB Data API is not configured');
  return fetchJsonWithTimeout(`${DATA_API_URL}/action/${action}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': DATA_API_KEY
    },
    body: JSON.stringify({
      dataSource: DATA_SOURCE,
      database: DATABASE,
      collection: COLLECTION,
      ...body
    })
  }, 12000);
}

function normalizeSourceStock(data) {
  const stock = data?.stock || data;
  if (!stock || typeof stock !== 'object') throw new Error('Original TSN API did not return stock data');
  const now = new Date().toISOString();
  return {
    price: Number(stock.price) || 100,
    change: Number(stock.change) || 0,
    changePercent: Number(stock.changePercent) || 0,
    trend: stock.trend || 'flat',
    updatedAt: stock.updatedAt || now,
    metrics: {
      onlineUsers: Number(stock.metrics?.onlineUsers) || 0,
      messagesPerHour: Number(stock.metrics?.messagesPerHour) || 0,
      postsPerHour: Number(stock.metrics?.postsPerHour) || 0,
      activityScore: Number(stock.metrics?.activityScore) || 0
    },
    disclaimer: stock.disclaimer || 'Fiktiv TSN-aktivitetspris. Ikke en rigtig aktie.'
  };
}

function makeSnapshot(stock) {
  return {
    price: Number(stock.price) || 100,
    change: Number(stock.change) || 0,
    changePercent: Number(stock.changePercent) || 0,
    trend: stock.trend || 'flat',
    metrics: stock.metrics || {},
    sourceUpdatedAt: stock.updatedAt || new Date().toISOString(),
    createdAt: new Date().toISOString(),
    source: 'tsn-stock-standalone'
  };
}

function cleanHistory(documents) {
  return (documents || [])
    .map((doc) => ({
      price: Number(doc.price) || 0,
      change: Number(doc.change) || 0,
      changePercent: Number(doc.changePercent) || 0,
      trend: doc.trend || 'flat',
      metrics: doc.metrics || {},
      createdAt: doc.createdAt || doc.sourceUpdatedAt || new Date().toISOString()
    }))
    .filter((point) => Number.isFinite(point.price) && point.price > 0)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    .slice(-MAX_HISTORY_POINTS);
}

async function loadHistory() {
  if (!PERSISTENCE_ENABLED) return cleanHistory(memoryHistory);
  const result = await dataApiAction('find', {
    filter: {},
    sort: { createdAt: -1 },
    limit: MAX_HISTORY_POINTS,
    projection: {
      _id: 0,
      price: 1,
      change: 1,
      changePercent: 1,
      trend: 1,
      metrics: 1,
      sourceUpdatedAt: 1,
      createdAt: 1
    }
  });
  return cleanHistory(result.documents || []);
}

async function saveSnapshot(snapshot) {
  if (!PERSISTENCE_ENABLED) {
    memoryHistory.push(snapshot);
    memoryHistory = cleanHistory(memoryHistory);
    return { saved: false, mode: 'memory' };
  }
  await dataApiAction('insertOne', { document: snapshot });
  return { saved: true, mode: 'mongodb-data-api' };
}

async function fetchOriginalStock() {
  if (!TSN_API_BASE_URL) {
    const error = new Error('Missing TSN_API_BASE_URL');
    error.statusCode = 428;
    throw error;
  }
  const data = await fetchJsonWithTimeout(`${TSN_API_BASE_URL}/api/public/stock`, { cache: 'no-store' }, 12000);
  return normalizeSourceStock(data);
}

function buildPayload(stock, history, persistence, source = 'live') {
  const clean = cleanHistory(history);
  const last = clean[clean.length - 1];
  const updatedAt = stock.updatedAt || last?.createdAt || new Date().toISOString();
  const currentPoint = { price: Number(stock.price) || 100, createdAt: updatedAt };

  if (!last || Math.abs(last.price - currentPoint.price) > 0.0001 || last.createdAt !== currentPoint.createdAt) {
    clean.push(currentPoint);
  }

  return {
    ok: true,
    stock: {
      ...stock,
      updatedAt,
      history: clean.slice(-MAX_HISTORY_POINTS).map((point) => ({
        price: Number(point.price) || 0,
        createdAt: point.createdAt
      })),
      persistence: {
        enabled: PERSISTENCE_ENABLED,
        mode: persistence?.mode || (PERSISTENCE_ENABLED ? 'mongodb-data-api' : 'memory'),
        saved: Boolean(persistence?.saved),
        database: PERSISTENCE_ENABLED ? DATABASE : null,
        collection: PERSISTENCE_ENABLED ? COLLECTION : null
      },
      source
    }
  };
}

async function getStockPayload({ force = false } = {}) {
  const now = Date.now();
  if (!force && cachedPayload && now - cachedAt < REFRESH_INTERVAL_MS) return cachedPayload;

  try {
    const stock = await fetchOriginalStock();
    const snapshot = makeSnapshot(stock);
    const persistence = await saveSnapshot(snapshot).catch((error) => {
      console.error('Could not save TSN Stock snapshot:', error.message);
      memoryHistory.push(snapshot);
      memoryHistory = cleanHistory(memoryHistory);
      return { saved: false, mode: 'memory-fallback' };
    });
    const history = await loadHistory().catch((error) => {
      console.error('Could not load TSN Stock history:', error.message);
      return cleanHistory(memoryHistory);
    });
    cachedPayload = buildPayload(stock, history, persistence, 'live');
    cachedAt = now;
    return cachedPayload;
  } catch (error) {
    const history = await loadHistory().catch(() => cleanHistory(memoryHistory));
    const last = history[history.length - 1];
    if (last) {
      cachedPayload = buildPayload({
        price: last.price,
        change: last.change || 0,
        changePercent: last.changePercent || 0,
        trend: last.trend || 'flat',
        updatedAt: last.createdAt,
        metrics: last.metrics || {},
        disclaimer: 'Fiktiv TSN-aktivitetspris. Viser seneste gemte datapunkt, fordi original TSN ikke kunne kontaktes.'
      }, history, { saved: false, mode: PERSISTENCE_ENABLED ? 'mongodb-data-api' : 'memory' }, 'last-known');
      cachedAt = now;
      return cachedPayload;
    }
    throw error;
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const urlPath = url.pathname;

  if (urlPath === '/healthz') {
    return sendJson(res, 200, {
      ok: true,
      service: 'tsn-stock',
      persistence: PERSISTENCE_ENABLED ? 'mongodb-data-api' : 'memory',
      tsnApiConfigured: Boolean(TSN_API_BASE_URL)
    });
  }

  if (urlPath === '/api/stock') {
    getStockPayload({ force: url.searchParams.get('force') === '1' })
      .then((payload) => sendJson(res, 200, payload))
      .catch((error) => sendJson(res, error.statusCode || 500, {
        ok: false,
        error: error.message,
        needs: !TSN_API_BASE_URL ? ['TSN_API_BASE_URL'] : []
      }));
    return;
  }

  if (urlPath === '/api/history') {
    loadHistory()
      .then((history) => sendJson(res, 200, {
        ok: true,
        persistence: PERSISTENCE_ENABLED ? 'mongodb-data-api' : 'memory',
        history: history.map((point) => ({ price: point.price, createdAt: point.createdAt }))
      }))
      .catch((error) => sendJson(res, 500, { ok: false, error: error.message }));
    return;
  }

  if (urlPath === '/config.js') {
    return send(
      res,
      200,
      `window.TSN_STOCK_CONFIG = ${JSON.stringify({
        refreshIntervalMs: REFRESH_INTERVAL_MS,
        persistenceEnabled: PERSISTENCE_ENABLED
      })};`,
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
  console.log(`TSN Stock persistent server running on port ${PORT}`);
  console.log(`Persistence: ${PERSISTENCE_ENABLED ? `MongoDB Data API (${DATABASE}.${COLLECTION})` : 'memory only'}`);
  if (!TSN_API_BASE_URL) {
    console.warn('Missing TSN_API_BASE_URL. Set it to your original TSN website URL, for example https://your-tsn.onrender.com');
  }
  if (!PERSISTENCE_ENABLED) {
    console.warn('MongoDB persistence is not configured. Set MONGODB_DATA_API_URL, MONGODB_DATA_API_KEY, MONGODB_DATA_SOURCE, MONGODB_DATABASE and MONGODB_COLLECTION.');
  }
});
