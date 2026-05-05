const http = require('http');
const fs = require('fs');
const path = require('path');
let MongoClient = null;
try {
  ({ MongoClient } = require('mongodb'));
} catch {
  MongoClient = null;
}

const PORT = Number(process.env.PORT || 3010);
const TSN_API_BASE_URL = String(process.env.TSN_API_BASE_URL || '').replace(/\/$/, '');
const PUBLIC_DIR = path.join(__dirname, 'public');

// Optional MongoDB Atlas persistence using the normal MongoDB connection string.
// This is the same setup style as the original TSN app: MONGODB_URI.
const MONGODB_URI = String(process.env.MONGODB_URI || '');
const DATABASE = String(process.env.MONGODB_DATABASE || 'tsn_stock');
const COLLECTION = String(process.env.MONGODB_COLLECTION || 'stockSnapshots');
const MAX_HISTORY_POINTS = Number(process.env.TSN_STOCK_MAX_HISTORY || 720);
const REFRESH_INTERVAL_MS = Number(process.env.TSN_STOCK_REFRESH_MS || 2000);

const PERSISTENCE_ENABLED = Boolean(MONGODB_URI);
let mongoClient = null;
let mongoCollection = null;

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

async function getMongoCollection() {
  if (!PERSISTENCE_ENABLED) throw new Error('MONGODB_URI is not configured');
  if (!MongoClient) throw new Error('MongoDB driver is not installed. Run npm install.');
  if (mongoCollection) return mongoCollection;

  mongoClient = new MongoClient(MONGODB_URI, {
    serverSelectionTimeoutMS: 12000,
    connectTimeoutMS: 12000,
    maxPoolSize: 5
  });
  await mongoClient.connect();
  mongoCollection = mongoClient.db(DATABASE).collection(COLLECTION);
  await mongoCollection.createIndex({ createdAt: -1 });
  return mongoCollection;
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


function hourActivityCurve(hour) {
  const onlineCurve = [0.20, 0.14, 0.10, 0.08, 0.07, 0.08, 0.13, 0.22, 0.34, 0.42, 0.48, 0.52, 0.56, 0.58, 0.60, 0.66, 0.78, 0.92, 1.00, 0.96, 0.86, 0.68, 0.46, 0.30];
  const messageCurve = [0.16, 0.11, 0.08, 0.06, 0.05, 0.07, 0.12, 0.21, 0.32, 0.40, 0.48, 0.54, 0.58, 0.62, 0.66, 0.74, 0.84, 0.98, 1.00, 0.94, 0.82, 0.63, 0.42, 0.25];
  const postCurve = [0.12, 0.08, 0.06, 0.05, 0.05, 0.06, 0.10, 0.18, 0.30, 0.38, 0.46, 0.52, 0.56, 0.60, 0.63, 0.70, 0.80, 0.92, 1.00, 0.96, 0.84, 0.62, 0.38, 0.20];
  const index = Math.max(0, Math.min(23, Number(hour) || 0));
  return {
    online: onlineCurve[index],
    messages: messageCurve[index],
    posts: postCurve[index]
  };
}

function clamp(number, min, max) {
  return Math.max(min, Math.min(max, Number(number) || 0));
}

function normalizeMetrics(metrics = {}) {
  const now = new Date();
  const hour = Number.isFinite(Number(metrics.hour)) ? Number(metrics.hour) : now.getHours();
  const curve = hourActivityCurve(hour);
  const usersTotal = Math.max(1, Number(metrics.usersTotal) || Number(metrics.totalUsers) || Math.max(1, Number(metrics.onlineUsers) || 1));
  const onlineUsers = Math.max(0, Number(metrics.onlineUsers) || 0);
  const messagesPerHour = Math.max(0, Number(metrics.messagesPerHour) || 0);
  const postsPerHour = Math.max(0, Number(metrics.postsPerHour) || 0);
  const expectedOnline = Math.max(1, Number(metrics.expectedOnline) || usersTotal * curve.online);
  const expectedMessagesPerHour = Math.max(1, Number(metrics.expectedMessagesPerHour) || usersTotal * 3.2 * curve.messages);
  const expectedPostsPerHour = Math.max(1, Number(metrics.expectedPostsPerHour) || usersTotal * 0.9 * curve.posts);
  const onlineRatio = onlineUsers / expectedOnline;
  const messageRatio = messagesPerHour / expectedMessagesPerHour;
  const postRatio = postsPerHour / expectedPostsPerHour;
  const calculatedActivityScore = clamp(onlineRatio * 0.45 + messageRatio * 0.30 + postRatio * 0.25, 0, 3.5);

  return {
    ...metrics,
    onlineUsers,
    usersTotal,
    messagesPerHour,
    postsPerHour,
    hour,
    expectedOnline: Number(expectedOnline.toFixed(2)),
    expectedMessagesPerHour: Number(expectedMessagesPerHour.toFixed(2)),
    expectedPostsPerHour: Number(expectedPostsPerHour.toFixed(2)),
    onlineRatio: Number(onlineRatio.toFixed(4)),
    messageRatio: Number(messageRatio.toFixed(4)),
    postRatio: Number(postRatio.toFixed(4)),
    activityScore: Number((Number(metrics.activityScore) || calculatedActivityScore).toFixed(3))
  };
}


function metricDelta(current, previous) {
  const onlineDelta = Number(current.onlineUsers || 0) - Number(previous.onlineUsers || 0);
  const messageDelta = Number(current.messagesPerHour || 0) - Number(previous.messagesPerHour || 0);
  const postDelta = Number(current.postsPerHour || 0) - Number(previous.postsPerHour || 0);
  const activityDelta = Number(current.activityScore || 0) - Number(previous.activityScore || 0);
  return {
    onlineDelta,
    messageDelta,
    postDelta,
    activityDelta,
    changed: Math.abs(onlineDelta) > 0.0001
      || Math.abs(messageDelta) > 0.0001
      || Math.abs(postDelta) > 0.0001
      || Math.abs(activityDelta) > 0.0001
  };
}

function sameSnapshotMetrics(a = {}, b = {}) {
  return Math.abs(Number(a.onlineUsers || 0) - Number(b.onlineUsers || 0)) < 0.0001
    && Math.abs(Number(a.messagesPerHour || 0) - Number(b.messagesPerHour || 0)) < 0.0001
    && Math.abs(Number(a.postsPerHour || 0) - Number(b.postsPerHour || 0)) < 0.0001
    && Math.abs(Number(a.activityScore || 0) - Number(b.activityScore || 0)) < 0.0001;
}

function calculateStandalonePrice(sourceStock, history) {
  const clean = cleanHistory(history);
  const lastPoint = clean[clean.length - 1] || null;
  const previousPrice = Number(lastPoint?.price) || Number(sourceStock?.price) || 100;
  const previousMetrics = normalizeMetrics(lastPoint?.metrics || {});
  const metrics = normalizeMetrics(sourceStock?.metrics || {});
  const deltas = metricDelta(metrics, previousMetrics);

  const activeUsers = metrics.onlineUsers > 0;
  const activeMessages = metrics.messagesPerHour > 0;
  const activePosts = metrics.postsPerHour > 0;
  const hasAnyActivity = activeUsers || activeMessages || activePosts;
  const hasStrongActivity = metrics.onlineUsers >= 2 || metrics.messagesPerHour >= 3 || metrics.postsPerHour >= 1 || metrics.activityScore >= 0.55;
  const activityIncreased = deltas.onlineDelta > 0 || deltas.messageDelta > 0 || deltas.postDelta > 0 || deltas.activityDelta > 0.001;

  // Bullish model: TSN Stock rewards real use more strongly than it punishes quiet periods.
  // It no longer drops just because activity is below a time-of-day expectation. If users are
  // online or people are posting/chatting, the natural pressure is upward.
  const basePrice = 100;
  const targetPrice = clamp(basePrice * (0.94 + metrics.activityScore * 1.18), 5, 99999);
  const targetPull = (targetPrice - previousPrice) * 0.055;

  const activityLevelBoost =
    metrics.onlineUsers * 0.035
    + metrics.messagesPerHour * 0.018
    + metrics.postsPerHour * 0.12
    + metrics.activityScore * 0.18;

  const onlineMomentum = deltas.onlineDelta * 1.35;
  const messageMomentum = deltas.messageDelta * 0.34;
  const postMomentum = deltas.postDelta * 1.85;
  const activityMomentum = deltas.activityDelta * 8.75;

  let rawMove = targetPull + activityLevelBoost + onlineMomentum + messageMomentum + postMomentum + activityMomentum;

  // Only apply negative pressure when TSN is completely quiet. With active users/messages/posts,
  // negative target pull is softened so a busy TSN does not trend down unfairly.
  if (!hasAnyActivity) {
    rawMove -= 0.05;
  } else if (rawMove < 0) {
    rawMove *= 0.18;
  }

  // Any new activity should create a visible green tick.
  if (activityIncreased && rawMove < 0.03) {
    rawMove = 0.03;
  }

  // If there is strong current activity, keep the stock biased upward even if the previous
  // snapshot had slightly higher activity. This makes active TSN sessions feel bullish.
  if (hasStrongActivity && rawMove < 0.015) {
    rawMove = 0.015;
  }

  // When activity is unchanged but still present, drift up slowly instead of going flat/down.
  if (!deltas.changed && hasAnyActivity && rawMove < 0.01) {
    rawMove = 0.01;
  }

  rawMove = clamp(rawMove, -1.25, 12.5);

  const price = Number(clamp(previousPrice + rawMove, 1, 99999).toFixed(2));
  const change = Number((price - previousPrice).toFixed(2));
  const changePercent = Number((previousPrice ? (change / previousPrice) * 100 : 0).toFixed(2));

  return {
    ...sourceStock,
    price,
    previousPrice: Number(previousPrice.toFixed(2)),
    change,
    changePercent,
    trend: change > 0.01 ? 'up' : change < -0.01 ? 'down' : 'flat',
    updatedAt: new Date().toISOString(),
    metrics: {
      ...metrics,
      targetPrice: Number(targetPrice.toFixed(2)),
      priceMove: Number(rawMove.toFixed(4)),
      bullishActivityBoost: Number(activityLevelBoost.toFixed(4)),
      activeUsers,
      activeMessages,
      activePosts,
      hasStrongActivity,
      metricDeltas: deltas,
      changedSinceLastSnapshot: deltas.changed
    },
    pricingEngine: 'bullish-instant-standalone-mongodb-history-v4'
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
  const collection = await getMongoCollection();
  const documents = await collection
    .find({}, {
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
    })
    .sort({ createdAt: -1 })
    .limit(MAX_HISTORY_POINTS)
    .toArray();
  return cleanHistory(documents);
}

async function saveSnapshot(snapshot) {
  if (!PERSISTENCE_ENABLED) {
    memoryHistory.push(snapshot);
    memoryHistory = cleanHistory(memoryHistory);
    return { saved: false, mode: 'memory' };
  }
  const collection = await getMongoCollection();
  await collection.insertOne(snapshot);
  return { saved: true, mode: 'mongodb-uri' };
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
        mode: persistence?.mode || (PERSISTENCE_ENABLED ? 'mongodb-uri' : 'memory'),
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
    const sourceStock = await fetchOriginalStock();
    const previousHistory = await loadHistory().catch((error) => {
      console.error('Could not load previous TSN Stock history:', error.message);
      return cleanHistory(memoryHistory);
    });
    const stock = calculateStandalonePrice(sourceStock, previousHistory);
    const snapshot = makeSnapshot(stock);
    const persistence = await saveSnapshot(snapshot).catch((error) => {
      console.error('Could not save TSN Stock snapshot:', error.message);
      memoryHistory.push(snapshot);
      memoryHistory = cleanHistory(memoryHistory);
      return { saved: false, mode: 'memory-fallback' };
    });
    const history = await loadHistory().catch((error) => {
      console.error('Could not load TSN Stock history:', error.message);
      return cleanHistory([...previousHistory, snapshot, ...memoryHistory]);
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
      }, history, { saved: false, mode: PERSISTENCE_ENABLED ? 'mongodb-uri' : 'memory' }, 'last-known');
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
      persistence: PERSISTENCE_ENABLED ? 'mongodb-uri' : 'memory',
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
        persistence: PERSISTENCE_ENABLED ? 'mongodb-uri' : 'memory',
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
  console.log(`Persistence: ${PERSISTENCE_ENABLED ? `MongoDB URI (${DATABASE}.${COLLECTION})` : 'memory only'}`);
  if (!TSN_API_BASE_URL) {
    console.warn('Missing TSN_API_BASE_URL. Set it to your original TSN website URL, for example https://your-tsn.onrender.com');
  }
  if (!PERSISTENCE_ENABLED) {
    console.warn('MongoDB persistence is not configured. Set MONGODB_URI, plus optional MONGODB_DATABASE and MONGODB_COLLECTION.');
  }
});
