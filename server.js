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
const WALLET_COLLECTION = String(process.env.MONGODB_WALLET_COLLECTION || 'tsnMoneyWallets');
const TRADE_COLLECTION = String(process.env.MONGODB_TRADE_COLLECTION || 'tsnMoneyTrades');
const TSNM_EARN_PER_MINUTE = Number(process.env.TSNM_EARN_PER_MINUTE || 10);
const TSNM_MAX_REWARD_MINUTES_PER_TICK = Number(process.env.TSNM_MAX_REWARD_MINUTES_PER_TICK || 30);
const MAX_HISTORY_POINTS = Number(process.env.TSN_STOCK_MAX_HISTORY || 720);
const HISTORY_API_MAX_POINTS = Number(process.env.TSN_STOCK_HISTORY_API_MAX_POINTS || 1400);
const REFRESH_INTERVAL_MS = Number(process.env.TSN_STOCK_REFRESH_MS || 2000);
const RESET_KEY = String(process.env.TSN_STOCK_RESET_KEY || '');
const RESET_BASE_PRICE = Number(process.env.TSN_STOCK_RESET_PRICE || 100);
const TARGET_BASE_PRICE = Number(process.env.TSN_STOCK_TARGET_BASE_PRICE || RESET_BASE_PRICE || 100);
const AUTO_REBASE_ENABLED = String(process.env.TSN_STOCK_AUTO_REBASE || 'true').toLowerCase() !== 'false';
const AUTO_REBASE_THRESHOLD_MULTIPLIER = Number(process.env.TSN_STOCK_AUTO_REBASE_THRESHOLD || 1.8);
const ACTIVITY_SCORE_POINTS_MULTIPLIER = Number(process.env.TSN_STOCK_ACTIVITY_POINTS_MULTIPLIER || 1000);
const ACTIVITY_SCORE_PRICE_SOFT_CAP = Number(process.env.TSN_STOCK_ACTIVITY_PRICE_SOFT_CAP || 8);
const METRIC_MESSAGE_EPSILON = Number(process.env.TSN_STOCK_MESSAGE_EPSILON || 0.05);
const METRIC_POST_EPSILON = Number(process.env.TSN_STOCK_POST_EPSILON || 0.05);
const METRIC_ACTIVITY_EPSILON = Number(process.env.TSN_STOCK_ACTIVITY_EPSILON || 0.01);
const MAX_PRICE_MOVE_PER_TICK = Number(process.env.TSN_STOCK_MAX_PRICE_MOVE_PER_TICK || 1.25);
const DOWNTURN_STRENGTH = Number(process.env.TSN_STOCK_DOWNTURN_STRENGTH || 1);
const QUIET_DECAY_PER_TICK = Number(process.env.TSN_STOCK_QUIET_DECAY_PER_TICK || 0.08);

const PERSISTENCE_ENABLED = Boolean(MONGODB_URI);
let mongoClient = null;
let mongoCollection = null;
let mongoWalletCollection = null;
let mongoTradeCollection = null;

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


function getBearerToken(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

function publicTsnUser(user) {
  return {
    id: String(user?.id || ''),
    username: String(user?.username || user?.name || 'tsn-user'),
    name: String(user?.name || user?.username || 'TSN User'),
    role: user?.role || 'user',
    isAdmin: Boolean(user?.isAdmin || user?.role === 'admin')
  };
}

async function proxyTsnLogin(username, password) {
  if (!TSN_API_BASE_URL) {
    const error = new Error('TSN_API_BASE_URL is missing. TSN-S needs the original TSN URL to log users in.');
    error.statusCode = 500;
    throw error;
  }
  const data = await fetchJsonWithTimeout(`${TSN_API_BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, login: username, password })
  }, 12000);
  if (!data?.token || !data?.user) {
    const error = new Error('Original TSN login did not return a valid session.');
    error.statusCode = 502;
    throw error;
  }
  return { token: data.token, user: publicTsnUser(data.user) };
}

async function getTsnSession(req) {
  if (!TSN_API_BASE_URL) {
    const error = new Error('TSN_API_BASE_URL is missing.');
    error.statusCode = 500;
    throw error;
  }
  const token = getBearerToken(req);
  if (!token) {
    const error = new Error('Du skal logge ind med din originale TSN-konto.');
    error.statusCode = 401;
    throw error;
  }
  const data = await fetchJsonWithTimeout(`${TSN_API_BASE_URL}/api/me`, {
    headers: { Authorization: `Bearer ${token}` }
  }, 12000);
  if (!data?.user) {
    const error = new Error('Din TSN-session kunne ikke bekræftes. Log ind igen.');
    error.statusCode = 401;
    throw error;
  }
  return { token, user: publicTsnUser(data.user) };
}

async function walletForRequest(req) {
  const session = await getTsnSession(req);
  return { playerId: session.user.id, playerName: session.user.name || session.user.username, user: session.user };
}

async function getMongoCollection() {
  if (!PERSISTENCE_ENABLED) throw new Error('MONGODB_URI is not configured');
  if (!MongoClient) throw new Error('MongoDB driver is not installed. Run npm install.');
  if (mongoCollection) return mongoCollection;

  const db = await getMongoDb();
  mongoCollection = db.collection(COLLECTION);
  await mongoCollection.createIndex({ createdAt: -1 });
  return mongoCollection;
}


async function getMongoDb() {
  if (!PERSISTENCE_ENABLED) throw new Error('MONGODB_URI is not configured');
  if (!MongoClient) throw new Error('MongoDB driver is not installed. Run npm install.');
  if (!mongoClient) {
    mongoClient = new MongoClient(MONGODB_URI, {
      serverSelectionTimeoutMS: 12000,
      connectTimeoutMS: 12000,
      maxPoolSize: 8
    });
    await mongoClient.connect();
  }
  return mongoClient.db(DATABASE);
}

async function getWalletCollection() {
  if (!PERSISTENCE_ENABLED) throw new Error('MONGODB_URI is not configured');
  if (mongoWalletCollection) return mongoWalletCollection;
  const db = await getMongoDb();
  mongoWalletCollection = db.collection(WALLET_COLLECTION);
  await mongoWalletCollection.createIndex({ playerId: 1 }, { unique: true });
  await mongoWalletCollection.createIndex({ updatedAt: -1 });
  return mongoWalletCollection;
}

async function getTradeCollection() {
  if (!PERSISTENCE_ENABLED) throw new Error('MONGODB_URI is not configured');
  if (mongoTradeCollection) return mongoTradeCollection;
  const db = await getMongoDb();
  mongoTradeCollection = db.collection(TRADE_COLLECTION);
  await mongoTradeCollection.createIndex({ playerId: 1, createdAt: -1 });
  await mongoTradeCollection.createIndex({ createdAt: -1 });
  return mongoTradeCollection;
}

function sanitizePlayerId(value) {
  return String(value || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
}

function sanitizePlayerName(value) {
  return String(value || 'TSN Investor').trim().replace(/[<>]/g, '').slice(0, 40) || 'TSN Investor';
}

function makeDefaultWallet(playerId, playerName) {
  const now = new Date().toISOString();
  return {
    playerId,
    playerName: sanitizePlayerName(playerName),
    balance: 0,
    shares: 0,
    avgBuyPrice: 0,
    realizedProfit: 0,
    totalEarned: 0,
    totalBought: 0,
    totalSold: 0,
    lastRewardAt: now,
    createdAt: now,
    updatedAt: now
  };
}

const memoryWallets = new Map();
const memoryTrades = [];

async function readJsonBody(req, maxBytes = 100_000) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > maxBytes) {
        reject(new Error('Request body is too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); }
      catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

async function getWallet(playerId, playerName) {
  const cleanId = sanitizePlayerId(playerId);
  if (!cleanId) throw new Error('Missing playerId');

  if (!PERSISTENCE_ENABLED) {
    if (!memoryWallets.has(cleanId)) memoryWallets.set(cleanId, makeDefaultWallet(cleanId, playerName));
    const wallet = memoryWallets.get(cleanId);
    if (playerName && wallet.playerName !== sanitizePlayerName(playerName)) wallet.playerName = sanitizePlayerName(playerName);
    return wallet;
  }

  const collection = await getWalletCollection();
  const now = new Date().toISOString();
  const existing = await collection.findOne({ playerId: cleanId }, { projection: { _id: 0 } });
  if (existing) {
    if (playerName && existing.playerName !== sanitizePlayerName(playerName)) {
      await collection.updateOne({ playerId: cleanId }, { $set: { playerName: sanitizePlayerName(playerName), updatedAt: now } });
      existing.playerName = sanitizePlayerName(playerName);
    }
    return existing;
  }
  const wallet = makeDefaultWallet(cleanId, playerName);
  await collection.insertOne(wallet);
  return wallet;
}

function publicWallet(wallet, stockPrice = 100, reward = null) {
  const balance = Number(wallet.balance) || 0;
  const shares = Number(wallet.shares) || 0;
  const portfolioValue = shares * (Number(stockPrice) || 0);
  const netWorth = balance + portfolioValue;
  const avgBuyPrice = Number(wallet.avgBuyPrice) || 0;
  const unrealizedProfit = shares > 0 ? portfolioValue - shares * avgBuyPrice : 0;
  return {
    playerId: wallet.playerId,
    playerName: wallet.playerName,
    balance: Number(balance.toFixed(2)),
    shares: Number(shares.toFixed(6)),
    avgBuyPrice: Number(avgBuyPrice.toFixed(2)),
    realizedProfit: Number((Number(wallet.realizedProfit) || 0).toFixed(2)),
    unrealizedProfit: Number(unrealizedProfit.toFixed(2)),
    totalEarned: Number((Number(wallet.totalEarned) || 0).toFixed(2)),
    totalBought: Number((Number(wallet.totalBought) || 0).toFixed(2)),
    totalSold: Number((Number(wallet.totalSold) || 0).toFixed(2)),
    portfolioValue: Number(portfolioValue.toFixed(2)),
    netWorth: Number(netWorth.toFixed(2)),
    lastRewardAt: wallet.lastRewardAt,
    updatedAt: wallet.updatedAt,
    reward
  };
}

async function saveWallet(wallet) {
  wallet.updatedAt = new Date().toISOString();
  if (!PERSISTENCE_ENABLED) {
    memoryWallets.set(wallet.playerId, wallet);
    return wallet;
  }
  const collection = await getWalletCollection();
  await collection.updateOne({ playerId: wallet.playerId }, { $set: wallet }, { upsert: true });
  return wallet;
}

function calculateReward(wallet) {
  const nowMs = Date.now();
  const lastMs = Date.parse(wallet.lastRewardAt || wallet.createdAt || new Date().toISOString()) || nowMs;
  const fullMinutes = Math.floor((nowMs - lastMs) / 60_000);
  const cappedMinutes = clamp(fullMinutes, 0, Math.max(1, TSNM_MAX_REWARD_MINUTES_PER_TICK));
  const amount = Number((cappedMinutes * TSNM_EARN_PER_MINUTE).toFixed(2));
  return { minutes: cappedMinutes, amount, nextRewardInMs: Math.max(0, 60_000 - ((nowMs - lastMs) % 60_000)) };
}

async function rewardOnlineMinutes(playerId, playerName) {
  const wallet = await getWallet(playerId, playerName);
  const reward = calculateReward(wallet);
  if (reward.minutes > 0) {
    const now = new Date();
    wallet.balance = Number((Number(wallet.balance || 0) + reward.amount).toFixed(2));
    wallet.totalEarned = Number((Number(wallet.totalEarned || 0) + reward.amount).toFixed(2));
    wallet.lastRewardAt = new Date(now.getTime() - (Date.now() - Date.parse(wallet.lastRewardAt || now.toISOString())) % 60_000).toISOString();
    await saveWallet(wallet);
  }
  return { wallet, reward };
}

async function recordTrade(trade) {
  if (!PERSISTENCE_ENABLED) {
    memoryTrades.push(trade);
    while (memoryTrades.length > 500) memoryTrades.shift();
    return;
  }
  const collection = await getTradeCollection();
  await collection.insertOne(trade);
}

async function getCurrentStockPrice() {
  const payload = await getStockPayload({ force: true });
  return Number(payload?.stock?.price) || TARGET_BASE_PRICE || 100;
}

async function tradeStock({ playerId, playerName, type, quantity }) {
  const cleanType = String(type || '').toLowerCase();
  const qty = Number(quantity);
  if (!['buy', 'sell'].includes(cleanType)) throw new Error('Trade type must be buy or sell');
  if (!Number.isFinite(qty) || qty <= 0) throw new Error('Quantity must be higher than 0');
  if (qty > 1_000_000) throw new Error('Quantity is too large');

  const { wallet } = await rewardOnlineMinutes(playerId, playerName);
  const price = await getCurrentStockPrice();
  const value = Number((qty * price).toFixed(2));
  const now = new Date().toISOString();

  if (cleanType === 'buy') {
    if ((Number(wallet.balance) || 0) + 0.0001 < value) throw new Error('Not enough TSNM balance');
    const oldShares = Number(wallet.shares) || 0;
    const oldCost = oldShares * (Number(wallet.avgBuyPrice) || 0);
    const newShares = oldShares + qty;
    wallet.balance = Number((Number(wallet.balance || 0) - value).toFixed(2));
    wallet.shares = Number(newShares.toFixed(6));
    wallet.avgBuyPrice = Number(((oldCost + value) / newShares).toFixed(2));
    wallet.totalBought = Number((Number(wallet.totalBought || 0) + value).toFixed(2));
  } else {
    if ((Number(wallet.shares) || 0) + 0.000001 < qty) throw new Error('Not enough TSN Stock shares');
    const costBasis = qty * (Number(wallet.avgBuyPrice) || 0);
    const profit = value - costBasis;
    wallet.balance = Number((Number(wallet.balance || 0) + value).toFixed(2));
    wallet.shares = Number((Number(wallet.shares || 0) - qty).toFixed(6));
    if (wallet.shares <= 0.000001) {
      wallet.shares = 0;
      wallet.avgBuyPrice = 0;
    }
    wallet.realizedProfit = Number((Number(wallet.realizedProfit || 0) + profit).toFixed(2));
    wallet.totalSold = Number((Number(wallet.totalSold || 0) + value).toFixed(2));
  }

  await saveWallet(wallet);
  const trade = {
    playerId: wallet.playerId,
    playerName: wallet.playerName,
    type: cleanType,
    quantity: Number(qty.toFixed(6)),
    price: Number(price.toFixed(2)),
    value,
    createdAt: now
  };
  await recordTrade(trade);
  return { wallet, trade, price };
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

  // Uncapped activity model: earlier versions capped this at 3.5, which made the UI
  // look like it could not pass 3,500 activity points. Keep the raw score uncapped
  // for display/history, then use a separate softened value for price movement.
  const calculatedActivityScore = Math.max(0, onlineRatio * 0.45 + messageRatio * 0.30 + postRatio * 0.25);
  const sourceActivityScore = Number(metrics.activityScore);
  const activityScore = Number.isFinite(sourceActivityScore) && sourceActivityScore > 0
    ? Math.max(sourceActivityScore, calculatedActivityScore)
    : calculatedActivityScore;
  const activityPoints = Math.max(0, Math.round(activityScore * Math.max(1, ACTIVITY_SCORE_POINTS_MULTIPLIER)));
  const priceActivityScore = clamp(
    Math.log1p(activityScore) / Math.log(2),
    0,
    Math.max(1, ACTIVITY_SCORE_PRICE_SOFT_CAP)
  );

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
    activityScore: Number(activityScore.toFixed(3)),
    activityPoints,
    priceActivityScore: Number(priceActivityScore.toFixed(3))
  };
}


function metricDelta(current, previous) {
  const onlineDelta = Number(current.onlineUsers || 0) - Number(previous.onlineUsers || 0);
  const messageDelta = Number(current.messagesPerHour || 0) - Number(previous.messagesPerHour || 0);
  const postDelta = Number(current.postsPerHour || 0) - Number(previous.postsPerHour || 0);
  const activityDelta = Number(current.activityScore || 0) - Number(previous.activityScore || 0);

  // Do not treat tiny rolling-rate noise as a real market event. This stops the
  // chart from bouncing +4 / -4 when TSN activity is effectively unchanged.
  const onlineChanged = Math.abs(onlineDelta) > 0.0001;
  const messageChanged = Math.abs(messageDelta) >= Math.max(0, METRIC_MESSAGE_EPSILON);
  const postChanged = Math.abs(postDelta) >= Math.max(0, METRIC_POST_EPSILON);
  const activityChanged = Math.abs(activityDelta) >= Math.max(0, METRIC_ACTIVITY_EPSILON);

  return {
    onlineDelta,
    messageDelta,
    postDelta,
    activityDelta,
    onlineChanged,
    messageChanged,
    postChanged,
    activityChanged,
    changed: onlineChanged || messageChanged || postChanged || activityChanged
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

  // If TSN activity has not really changed since the last saved snapshot, hold
  // the price exactly still. This removes artificial oscillation like +4, -4,
  // +4, -4 caused by target-pull/gravity recalculating on every poll.
  if (lastPoint && !deltas.changed) {
    const price = Number(previousPrice.toFixed(2));
    return {
      ...sourceStock,
      price,
      previousPrice: price,
      change: 0,
      changePercent: 0,
      trend: 'flat',
      updatedAt: new Date().toISOString(),
      metrics: {
        ...metrics,
        priceMove: 0,
        targetPrice: Number(price.toFixed(2)),
        targetPull: 0,
        baseGravity: 0,
        bullishActivityBoost: 0,
        activityMomentumBoost: 0,
        metricDeltas: deltas,
        changedSinceLastSnapshot: false,
        heldBecauseMetricsUnchanged: true
      },
      pricingEngine: 'event-driven-balanced-up-down-v7'
    };
  }

  const activeUsers = metrics.onlineUsers > 0;
  const activeMessages = metrics.messagesPerHour > 0;
  const activePosts = metrics.postsPerHour > 0;
  const hasAnyActivity = activeUsers || activeMessages || activePosts;
  const scoreForPrice = Number(metrics.priceActivityScore) || clamp(metrics.activityScore, 0, Math.max(1, ACTIVITY_SCORE_PRICE_SOFT_CAP));
  const hasStrongActivity = metrics.onlineUsers >= 2 || metrics.messagesPerHour >= 3 || metrics.postsPerHour >= 1 || metrics.activityScore >= 0.55 || metrics.activityPoints >= 550;
  const activityIncreased = deltas.onlineDelta > 0 || deltas.messageDelta > 0 || deltas.postDelta > 0 || deltas.activityDelta > 0.001;

  // Rebased bullish model: visible activity points can now go beyond 3,500, but
  // the pricing engine uses a softened score so the stock can react without instantly
  // exploding away from the 100-ish base.
  const basePrice = clamp(TARGET_BASE_PRICE, 1, 99999);
  const targetPrice = clamp(basePrice * (0.90 + scoreForPrice * 0.24), basePrice * 0.55, basePrice * 2.35);
  const distanceFromBase = previousPrice - basePrice;
  const targetPull = (targetPrice - previousPrice) * 0.13;
  const baseGravity = distanceFromBase > basePrice * 0.35
    ? -Math.min(35, distanceFromBase * 0.22)
    : distanceFromBase < -basePrice * 0.25
      ? Math.min(8, Math.abs(distanceFromBase) * 0.09)
      : 0;

  const activityLevelBoost =
    metrics.onlineUsers * 0.018
    + metrics.messagesPerHour * 0.009
    + metrics.postsPerHour * 0.055
    + scoreForPrice * 0.055
    + Math.log1p(metrics.activityPoints || 0) * 0.008;

  const onlineMomentum = deltas.onlineDelta * 0.42;
  const messageMomentum = deltas.messageDelta * 0.09;
  const postMomentum = deltas.postDelta * 0.55;
  const activityMomentum = deltas.activityDelta * 2.15;

  let rawMove = targetPull + baseGravity + activityLevelBoost + onlineMomentum + messageMomentum + postMomentum + activityMomentum;

  // A real stock simulation needs three states:
  // 1) unchanged metrics => exactly flat, handled by the early return above;
  // 2) increased metrics => green tick;
  // 3) decreased/quiet metrics => red tick.
  // The previous version softened negative moves too much, so the stock almost never
  // moved down. This version only blocks artificial formula-red ticks, not real drops.
  const activityDropped = deltas.onlineDelta < -0.0001
    || deltas.messageDelta <= -Math.max(0.25, METRIC_MESSAGE_EPSILON * 4)
    || deltas.postDelta <= -Math.max(0.1, METRIC_POST_EPSILON * 4)
    || deltas.activityDelta <= -Math.max(0.02, METRIC_ACTIVITY_EPSILON * 2);

  const dropPressure = (
    Math.max(0, -deltas.onlineDelta) * 0.48
    + Math.max(0, -deltas.messageDelta) * 0.075
    + Math.max(0, -deltas.postDelta) * 0.48
    + Math.max(0, -deltas.activityDelta) * 1.35
  ) * Math.max(0.1, DOWNTURN_STRENGTH);

  if (!hasAnyActivity) {
    rawMove = Math.min(rawMove, -Math.max(0.01, QUIET_DECAY_PER_TICK));
  } else if (activityDropped) {
    rawMove = Math.min(rawMove, -Math.max(0.02, dropPressure));
  } else if (rawMove < 0) {
    // TSN is active and metrics did not actually drop, so do not show fake red ticks.
    rawMove = 0;
  }

  // Any real new activity should create a small green tick. If activity is merely
  // stable, the early-return above holds the price at 0 change.
  if (activityIncreased && !activityDropped && rawMove < 0.03) {
    rawMove = 0.03;
  }

  const maxMove = Math.max(0.01, MAX_PRICE_MOVE_PER_TICK);
  rawMove = clamp(rawMove, -maxMove, maxMove);

  // Tiny movements look like noise. Round them to flat so the UI shows 0 / 0.
  if (Math.abs(rawMove) < 0.01) {
    rawMove = 0;
  }

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
      scoreForPrice: Number(scoreForPrice.toFixed(3)),
      bullishActivityBoost: Number(activityLevelBoost.toFixed(4)),
      activeUsers,
      activeMessages,
      activePosts,
      hasStrongActivity,
      metricDeltas: deltas,
      changedSinceLastSnapshot: deltas.changed
    },
    pricingEngine: 'event-driven-balanced-up-down-v7'
  };
}


function historyRangeToMs(range) {
  const value = String(range || '10m').toLowerCase();
  const ranges = {
    '10m': 10 * 60 * 1000,
    '30m': 30 * 60 * 1000,
    '1h': 60 * 60 * 1000,
    '6h': 6 * 60 * 60 * 1000,
    '1d': 24 * 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000
  };
  if (value === 'all') return null;
  return ranges[value] || ranges['10m'];
}

function downsampleHistory(points, maxPoints = HISTORY_API_MAX_POINTS) {
  const clean = cleanHistory(points);
  const limit = Math.max(50, Number(maxPoints) || HISTORY_API_MAX_POINTS);
  if (clean.length <= limit) return clean;

  const sampled = [];
  const step = (clean.length - 1) / (limit - 1);
  for (let i = 0; i < limit; i += 1) {
    sampled.push(clean[Math.round(i * step)]);
  }
  return sampled;
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

async function loadHistory(options = {}) {
  const sinceMs = Number(options.sinceMs || 0);
  const limit = Number(options.limit || MAX_HISTORY_POINTS);
  const sinceIso = sinceMs > 0 ? new Date(Date.now() - sinceMs).toISOString() : null;

  if (!PERSISTENCE_ENABLED) {
    const filtered = sinceIso
      ? memoryHistory.filter((point) => String(point.createdAt || point.sourceUpdatedAt || '') >= sinceIso)
      : memoryHistory;
    return cleanHistory(filtered).slice(-limit);
  }

  const collection = await getMongoCollection();
  const query = sinceIso ? { createdAt: { $gte: sinceIso } } : {};
  const documents = await collection
    .find(query, {
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
    .limit(limit)
    .toArray();
  return cleanHistory(documents);
}
async function rebaseHistoryIfNeeded(history) {
  const clean = cleanHistory(history);
  const last = clean[clean.length - 1];
  const target = clamp(TARGET_BASE_PRICE, 1, 99999);
  const threshold = target * Math.max(1.05, AUTO_REBASE_THRESHOLD_MULTIPLIER || 1.8);

  if (!AUTO_REBASE_ENABLED || !last || last.price <= threshold) {
    return { history: clean, rebased: false, factor: 1 };
  }

  const factor = target / last.price;
  const rebasedAt = new Date().toISOString();

  if (PERSISTENCE_ENABLED) {
    const collection = await getMongoCollection();
    const documents = await collection
      .find({}, { projection: { _id: 1, price: 1, change: 1 } })
      .sort({ createdAt: -1 })
      .limit(MAX_HISTORY_POINTS)
      .toArray();

    for (const doc of documents) {
      await collection.updateOne(
        { _id: doc._id },
        {
          $set: {
            price: Number(clamp(Number(doc.price || 0) * factor, 1, 99999).toFixed(2)),
            change: Number(((Number(doc.change) || 0) * factor).toFixed(2)),
            rebasedAround: target,
            rebaseFactor: Number(factor.toFixed(8)),
            rebasedAt
          }
        }
      );
    }
    cachedPayload = null;
    cachedAt = 0;
    return { history: await loadHistory(), rebased: true, factor };
  }

  memoryHistory = clean.map((point) => ({
    ...point,
    price: Number(clamp(point.price * factor, 1, 99999).toFixed(2)),
    change: Number(((Number(point.change) || 0) * factor).toFixed(2)),
    metrics: { ...(point.metrics || {}), rebasedAround: target, rebaseFactor: Number(factor.toFixed(8)), rebasedAt }
  }));
  return { history: cleanHistory(memoryHistory), rebased: true, factor };
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


async function resetStockHistory() {
  cachedPayload = null;
  cachedAt = 0;
  memoryHistory = [];

  if (PERSISTENCE_ENABLED) {
    const collection = await getMongoCollection();
    await collection.deleteMany({});
  }

  const now = new Date().toISOString();
  const resetSnapshot = {
    price: Number(clamp(RESET_BASE_PRICE, 1, 99999).toFixed(2)),
    change: 0,
    changePercent: 0,
    trend: 'flat',
    metrics: {
      onlineUsers: 0,
      messagesPerHour: 0,
      postsPerHour: 0,
      activityScore: 0,
      reset: true
    },
    sourceUpdatedAt: now,
    createdAt: now,
    source: 'tsn-stock-reset'
  };

  const persistence = await saveSnapshot(resetSnapshot).catch((error) => {
    console.error('Could not save reset snapshot:', error.message);
    memoryHistory.push(resetSnapshot);
    memoryHistory = cleanHistory(memoryHistory);
    return { saved: false, mode: 'memory-fallback' };
  });

  const history = await loadHistory().catch(() => cleanHistory([resetSnapshot, ...memoryHistory]));
  cachedPayload = buildPayload({
    price: resetSnapshot.price,
    previousPrice: resetSnapshot.price,
    change: 0,
    changePercent: 0,
    trend: 'flat',
    updatedAt: now,
    metrics: resetSnapshot.metrics,
    disclaimer: 'Fiktiv TSN-aktivitetspris. Historikken blev nulstillet.',
    pricingEngine: 'reset-baseline'
  }, history, persistence, 'reset');
  cachedAt = Date.now();
  return cachedPayload;
}

function requestResetKey(req, url) {
  return String(req.headers['x-reset-key'] || url.searchParams.get('key') || '');
}

function resetAllowed(req, url) {
  return !RESET_KEY || requestResetKey(req, url) === RESET_KEY;
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
    const loadedHistory = await loadHistory().catch((error) => {
      console.error('Could not load previous TSN Stock history:', error.message);
      return cleanHistory(memoryHistory);
    });
    const rebaseResult = await rebaseHistoryIfNeeded(loadedHistory).catch((error) => {
      console.error('Could not auto-rebase TSN Stock history:', error.message);
      return { history: loadedHistory, rebased: false, factor: 1 };
    });
    const previousHistory = rebaseResult.history;
    const stock = calculateStandalonePrice(sourceStock, previousHistory);
    if (rebaseResult.rebased) {
      stock.metrics = {
        ...(stock.metrics || {}),
        autoRebased: true,
        rebaseFactor: Number(rebaseResult.factor.toFixed(8)),
        rebasedAround: clamp(TARGET_BASE_PRICE, 1, 99999)
      };
    }
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
      resetEnabled: true,
      resetRequiresKey: Boolean(RESET_KEY),
      targetBasePrice: TARGET_BASE_PRICE,
      autoRebaseEnabled: AUTO_REBASE_ENABLED,
      persistence: PERSISTENCE_ENABLED ? 'mongodb-uri' : 'memory',
      tsnMoney: { earnPerMinute: TSNM_EARN_PER_MINUTE, walletCollection: WALLET_COLLECTION, tradeCollection: TRADE_COLLECTION },
      tsnApiConfigured: Boolean(TSN_API_BASE_URL)
    });
  }


  if (urlPath === '/api/auth/login') {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'Use POST for login.' });
    readJsonBody(req)
      .then((body) => proxyTsnLogin(body.username || body.login, body.password))
      .then((session) => sendJson(res, 200, { ok: true, ...session }))
      .catch((error) => sendJson(res, error.statusCode || 401, { ok: false, error: error.data?.error || error.message || 'Login fejlede.' }));
    return;
  }

  if (urlPath === '/api/auth/me') {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'Use GET for session check.' });
    getTsnSession(req)
      .then((session) => sendJson(res, 200, { ok: true, user: session.user }))
      .catch((error) => sendJson(res, error.statusCode || 401, { ok: false, error: error.data?.error || error.message || 'Ikke logget ind.', logout: true }));
    return;
  }

  if (urlPath === '/api/auth/logout') {
    return sendJson(res, 200, { ok: true, logout: true });
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


  if (urlPath === '/api/wallet') {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'Use GET for wallet.' });
    walletForRequest(req)
      .then((identity) => Promise.all([identity, getWallet(identity.playerId, identity.playerName), getStockPayload({ force: false }).catch(() => null)]))
      .then(([identity, wallet, payload]) => sendJson(res, 200, {
        ok: true,
        user: identity.user,
        wallet: publicWallet(wallet, payload?.stock?.price || TARGET_BASE_PRICE),
        earnPerMinute: TSNM_EARN_PER_MINUTE,
        fictional: true
      }))
      .catch((error) => sendJson(res, error.statusCode || 400, { ok: false, error: error.data?.error || error.message }));
    return;
  }

  if (urlPath === '/api/wallet/tick') {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'Use POST for wallet tick.' });
    walletForRequest(req)
      .then((identity) => Promise.all([
        identity,
        rewardOnlineMinutes(identity.playerId, identity.playerName),
        getStockPayload({ force: false }).catch(() => null)
      ]))
      .then(([identity, result, payload]) => sendJson(res, 200, {
        ok: true,
        user: identity.user,
        wallet: publicWallet(result.wallet, payload?.stock?.price || TARGET_BASE_PRICE, result.reward),
        earnPerMinute: TSNM_EARN_PER_MINUTE,
        fictional: true
      }))
      .catch((error) => sendJson(res, error.statusCode || 400, { ok: false, error: error.data?.error || error.message }));
    return;
  }

  if (urlPath === '/api/trade') {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'Use POST for trading.' });
    Promise.all([walletForRequest(req), readJsonBody(req)])
      .then(([identity, body]) => tradeStock({
        playerId: identity.playerId,
        playerName: identity.playerName,
        type: body.type,
        quantity: body.quantity
      }).then((result) => ({ identity, result })))
      .then(({ identity, result }) => sendJson(res, 200, {
        ok: true,
        user: identity.user,
        wallet: publicWallet(result.wallet, result.price),
        trade: result.trade,
        fictional: true
      }))
      .catch((error) => sendJson(res, error.statusCode || 400, { ok: false, error: error.data?.error || error.message }));
    return;
  }

  if (urlPath === '/api/history') {
    const range = url.searchParams.get('range') || '10m';
    const sinceMs = historyRangeToMs(range);
    const limit = Math.min(Number(url.searchParams.get('limit') || HISTORY_API_MAX_POINTS), HISTORY_API_MAX_POINTS * 2);
    const queryLimit = sinceMs
      ? Math.min(Math.max(limit * 50, 5000), 100000)
      : Math.min(Math.max(MAX_HISTORY_POINTS * 10, limit * 10), 100000);
    loadHistory({ sinceMs: sinceMs || 0, limit: queryLimit })
      .then((history) => {
        const points = downsampleHistory(history, limit);
        sendJson(res, 200, {
          ok: true,
          persistence: PERSISTENCE_ENABLED ? 'mongodb-uri' : 'memory',
          range,
          sinceMs,
          totalPoints: history.length,
          pointsReturned: points.length,
          history: points.map((point) => ({
            price: point.price,
            change: point.change,
            changePercent: point.changePercent,
            trend: point.trend,
            metrics: point.metrics,
            createdAt: point.createdAt
          }))
        });
      })
      .catch((error) => sendJson(res, 500, { ok: false, error: error.message }));
    return;
  }

  if (urlPath === '/api/reset') {
    if (req.method !== 'POST') {
      return sendJson(res, 405, { ok: false, error: 'Use POST to reset TSN Stock.' });
    }
    if (!resetAllowed(req, url)) {
      return sendJson(res, 401, { ok: false, error: 'Reset key is missing or wrong.' });
    }
    resetStockHistory()
      .then((payload) => sendJson(res, 200, { ...payload, reset: true }))
      .catch((error) => sendJson(res, 500, { ok: false, error: error.message }));
    return;
  }

  if (urlPath === '/config.js') {
    return send(
      res,
      200,
      `window.TSN_STOCK_CONFIG = ${JSON.stringify({
        refreshIntervalMs: REFRESH_INTERVAL_MS,
        persistenceEnabled: PERSISTENCE_ENABLED,
        resetRequiresKey: Boolean(RESET_KEY),
        targetBasePrice: TARGET_BASE_PRICE,
        autoRebaseEnabled: AUTO_REBASE_ENABLED,
        tsnmEarnPerMinute: TSNM_EARN_PER_MINUTE,
        historyApiMaxPoints: HISTORY_API_MAX_POINTS
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
