const http = require('http');
const fs = require('fs');
const path = require('path');
let MongoClient = null;
try {
  ({ MongoClient } = require('mongodb'));
} catch {
  MongoClient = null;
}
let bcrypt = null;
try {
  bcrypt = require('bcryptjs');
} catch {
  bcrypt = null;
}
let jwt = null;
try {
  jwt = require('jsonwebtoken');
} catch {
  jwt = null;
}
const crypto = require('crypto');

function firstEnvValue(names) {
  for (const name of names) {
    const value = String(process.env[name] || '').trim();
    if (value) return { name, value };
  }
  return { name: '', value: '' };
}

function normalizeBaseUrl(value) {
  let url = String(value || '').trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) {
    url = /^(localhost|127\.0\.0\.1)(:|\/|$)/i.test(url) ? `http://${url}` : `https://${url}`;
  }
  url = url.replace(/\/+$/, '');
  // Users often paste https://their-tsn.onrender.com/api. TSN-S needs the site root.
  url = url.replace(/\/api$/i, '');
  return url;
}

function joinApiUrl(baseUrl, endpoint) {
  return `${String(baseUrl || '').replace(/\/+$/, '')}/${String(endpoint || '').replace(/^\/+/, '')}`;
}

const PORT = Number(process.env.PORT || 3010);
const TSN_API_ENV = firstEnvValue(['TSN_API_BASE_URL', 'TSN_BASE_URL', 'ORIGINAL_TSN_URL', 'TSN_URL', 'PUBLIC_TSN_URL']);
const TSN_API_BASE_URL = normalizeBaseUrl(TSN_API_ENV.value);
const TSN_API_CONNECT_TIMEOUT_MS = Number(process.env.TSN_API_CONNECT_TIMEOUT_MS || 30000);
const TSN_API_RETRY_COUNT = Number(process.env.TSN_API_RETRY_COUNT || 2);
const PUBLIC_DIR = path.join(__dirname, 'public');

// Optional MongoDB Atlas persistence using the normal MongoDB connection string.
// This is the same setup style as the original TSN app: MONGODB_URI.
const MONGODB_URI = String(process.env.MONGODB_URI || '');
const DATABASE = String(process.env.MONGODB_DATABASE || 'tsn_stock');
const EXPLICIT_ORIGINAL_TSN_MONGODB_URI = String(process.env.TSN_ORIGINAL_MONGODB_URI || process.env.ORIGINAL_TSN_MONGODB_URI || '').trim();
const ORIGINAL_TSN_MONGODB_URI = EXPLICIT_ORIGINAL_TSN_MONGODB_URI;
const ORIGINAL_TSN_DATABASE = String(process.env.TSN_ORIGINAL_MONGODB_DATABASE || process.env.MONGODB_TSN_DATABASE || 'tsn');
const ORIGINAL_TSN_STATE_COLLECTION = String(process.env.TSN_ORIGINAL_MONGODB_STATE_COLLECTION || 'app_state');
const ORIGINAL_TSN_STATE_ID = String(process.env.TSN_ORIGINAL_MONGODB_STATE_ID || 'main');
const STOCK_SESSION_SECRET = String(process.env.TSN_STOCK_SESSION_SECRET || process.env.JWT_SECRET || process.env.SESSION_SECRET || 'dev-tsn-stock-session-secret-change-me');
const TSN_DATA_ENCRYPTION_KEY = String(process.env.TSN_DATA_ENCRYPTION_KEY || process.env.JWT_SECRET || 'dev-data-encryption-key-change-before-release-32chars');
const COLLECTION = String(process.env.MONGODB_COLLECTION || 'stockSnapshots');
const WALLET_COLLECTION = String(process.env.MONGODB_WALLET_COLLECTION || 'tsnMoneyWallets');
const TRADE_COLLECTION = String(process.env.MONGODB_TRADE_COLLECTION || 'tsnMoneyTrades');
const TSNM_EARN_PER_MINUTE = Number(process.env.TSNM_EARN_PER_MINUTE || 10);
const TSNM_MAX_REWARD_MINUTES_PER_TICK = Number(process.env.TSNM_MAX_REWARD_MINUTES_PER_TICK || 30);
const MAX_HISTORY_POINTS = Number(process.env.TSN_STOCK_MAX_HISTORY || 302400); // 7 days at 2-second snapshots
const STOCK_PAYLOAD_HISTORY_POINTS = Number(process.env.TSN_STOCK_PAYLOAD_HISTORY_POINTS || 720);
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
let originalTsnMongoClient = null;

let cachedPayload = null;
let cachedAt = 0;
let backgroundStockRefreshInFlight = null;
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
  let cleanPath = 'index.html';
  try {
    cleanPath = decodeURIComponent(String(urlPath || '/').split('?')[0]).replace(/^\/+/, '') || 'index.html';
  } catch {
    return null;
  }
  const resolved = path.resolve(PUBLIC_DIR, cleanPath);
  if (!resolved.startsWith(PUBLIC_DIR)) return null;
  return resolved;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableFetchError(error) {
  const status = Number(error?.statusCode || 0);
  return error?.name === 'AbortError'
    || /aborted|timeout|terminated|fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(String(error?.message || ''))
    || [408, 425, 429, 500, 502, 503, 504].includes(status);
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
      const message = data?.error || data?.message || `HTTP ${response.status} from ${url}`;
      const error = new Error(message);
      error.statusCode = response.status;
      error.data = data;
      error.url = url;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJsonWithRetry(url, options = {}, timeoutMs = TSN_API_CONNECT_TIMEOUT_MS, retries = TSN_API_RETRY_COUNT) {
  let lastError = null;
  for (let attempt = 0; attempt <= Math.max(0, retries); attempt += 1) {
    try {
      return await fetchJsonWithTimeout(url, options, timeoutMs);
    } catch (error) {
      lastError = error;
      if (attempt >= retries || !isRetryableFetchError(error)) break;
      await sleep(Math.min(5000, 1000 + attempt * 2000));
    }
  }
  throw lastError;
}



function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 24);
}

const DATA_KEY_CANDIDATES = [...new Set([
  TSN_DATA_ENCRYPTION_KEY,
  ...String(process.env.TSN_OLD_DATA_ENCRYPTION_KEYS || '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean),
  process.env.JWT_SECRET || '',
  'dev-secret-change-before-release',
  'dev-data-encryption-key-change-before-release-32chars'
].filter(Boolean))];

const CRYPTO_KEY_CANDIDATES = DATA_KEY_CANDIDATES.map((value) => ({
  fieldKey: crypto.createHash('sha256').update(String(value)).digest(),
  lookupKey: crypto.createHash('sha256').update(`lookup:${value}`).digest()
}));

function lookupHashWithKey(scope, normalizedValue, lookupKey) {
  const value = String(normalizedValue || '');
  if (!value) return '';
  return crypto.createHmac('sha256', lookupKey).update(`${scope}:${value}`).digest('hex');
}

function lookupHashes(scope, normalizedValue) {
  return CRYPTO_KEY_CANDIDATES.map((keys) => lookupHashWithKey(scope, normalizedValue, keys.lookupKey));
}

function decryptTsnField(value) {
  const text = String(value || '');
  if (!text.startsWith('v1:')) return text;
  const [, ivText, tagText, encryptedText] = text.split(':');
  for (const keys of CRYPTO_KEY_CANDIDATES) {
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', keys.fieldKey, Buffer.from(ivText, 'base64url'));
      decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(encryptedText, 'base64url')),
        decipher.final()
      ]).toString('utf8');
    } catch {
      // Try next configured/legacy key.
    }
  }
  return '';
}

function getOriginalUserField(user, field) {
  if (!user) return '';
  const encryptedValue = user[`${field}Enc`];
  if (encryptedValue) return decryptTsnField(encryptedValue);
  return String(user[field] || '');
}

function originalUserMatchesLogin(user, loginValue) {
  const username = normalizeUsername(loginValue);
  if (!username || !user) return false;
  const hashes = lookupHashes('username', username);
  if (user.usernameHash && hashes.includes(user.usernameHash)) return true;
  return normalizeUsername(getOriginalUserField(user, 'username')) === username;
}

async function getOriginalTsnDb() {
  if (!ORIGINAL_TSN_MONGODB_URI) throw new Error('TSN_ORIGINAL_MONGODB_URI or MONGODB_URI is missing.');
  if (!MongoClient) throw new Error('MongoDB driver is not installed.');
  if (!originalTsnMongoClient) {
    originalTsnMongoClient = new MongoClient(ORIGINAL_TSN_MONGODB_URI, {
      serverSelectionTimeoutMS: 12000,
      connectTimeoutMS: 12000,
      maxPoolSize: 4
    });
    await originalTsnMongoClient.connect();
  }
  return originalTsnMongoClient.db(ORIGINAL_TSN_DATABASE);
}

async function readOriginalTsnState() {
  const db = await getOriginalTsnDb();
  const document = await db.collection(ORIGINAL_TSN_STATE_COLLECTION).findOne({ _id: ORIGINAL_TSN_STATE_ID });
  const state = document?.data || document?.state || document || null;
  if (!state || !Array.isArray(state.users)) {
    const error = new Error(`Could not find original TSN users in MongoDB database "${ORIGINAL_TSN_DATABASE}" collection "${ORIGINAL_TSN_STATE_COLLECTION}".`);
    error.statusCode = 502;
    throw error;
  }
  return state;
}

function isOriginalUserBanned(user) {
  return Boolean(user && user.bannedAt);
}

function signStockSession(user) {
  if (!jwt) throw new Error('jsonwebtoken is not installed.');
  return jwt.sign({
    iss: 'tsn-stock',
    sub: String(user.id),
    username: String(user.username || ''),
    name: String(user.name || user.username || 'TSN User'),
    role: user.role || 'user',
    isAdmin: Boolean(user.isAdmin || user.role === 'admin')
  }, STOCK_SESSION_SECRET, { expiresIn: '7d' });
}

function verifyStockSession(token) {
  if (!jwt || !token) return null;
  try {
    const payload = jwt.verify(token, STOCK_SESSION_SECRET);
    if (payload?.iss !== 'tsn-stock' || !payload?.sub) return null;
    return {
      id: String(payload.sub),
      username: String(payload.username || 'tsn-user'),
      name: String(payload.name || payload.username || 'TSN User'),
      role: payload.role || 'user',
      isAdmin: Boolean(payload.isAdmin || payload.role === 'admin')
    };
  } catch {
    return null;
  }
}

async function directOriginalTsnLogin(username, password) {
  if (!bcrypt) {
    const error = new Error('bcryptjs is not installed, so direct TSN MongoDB login is unavailable.');
    error.statusCode = 500;
    throw error;
  }
  const login = String(username || '').trim();
  const pass = String(password || '');
  if (!login || !pass) {
    const error = new Error('Skriv brugernavn og adgangskode.');
    error.statusCode = 400;
    throw error;
  }
  const state = await readOriginalTsnState();
  const user = state.users.find((candidate) => originalUserMatchesLogin(candidate, login));
  if (!user) {
    const error = new Error('Forkert brugernavn eller adgangskode. Check også at TSN_ORIGINAL_MONGODB_DATABASE er sat til din normale TSN database, typisk "tsn".');
    error.statusCode = 401;
    throw error;
  }
  if (isOriginalUserBanned(user)) {
    const error = new Error('Denne TSN-konto er banned.');
    error.statusCode = 403;
    throw error;
  }
  const ok = await bcrypt.compare(pass, user.passwordHash || '');
  if (!ok) {
    const error = new Error('Forkert brugernavn eller adgangskode.');
    error.statusCode = 401;
    throw error;
  }
  const publicUser = publicTsnUser({
    id: user.id,
    username: getOriginalUserField(user, 'username'),
    name: getOriginalUserField(user, 'name'),
    role: user.role || 'user',
    isAdmin: user.role === 'admin'
  });
  return { token: signStockSession(publicUser), user: publicUser, authMode: 'mongodb' };
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
  const directErrors = [];
  if (EXPLICIT_ORIGINAL_TSN_MONGODB_URI && ORIGINAL_TSN_MONGODB_URI && bcrypt && jwt && MongoClient) {
    try {
      return await directOriginalTsnLogin(username, password);
    } catch (error) {
      directErrors.push(error.data?.error || error.message || 'Direct MongoDB login failed.');
      // A banned account should stay blocked. Wrong DB/key/password can still be rescued by the TSN API fallback.
      if (Number(error.statusCode) === 403) throw error;
    }
  }

  if (!TSN_API_BASE_URL) {
    const configuredHint = TSN_API_ENV.name ? ` ${TSN_API_ENV.name} was set, but it could not be normalized.` : '';
    const error = new Error(`TSN-S could not log in. Direct MongoDB login failed: ${directErrors.join(' | ') || 'not configured'}. TSN_API_BASE_URL is missing.${configuredHint}`);
    error.statusCode = 500;
    throw error;
  }

  try {
    const data = await fetchJsonWithRetry(joinApiUrl(TSN_API_BASE_URL, '/api/auth/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, login: username, password })
    }, TSN_API_CONNECT_TIMEOUT_MS);
    if (!data?.token || !data?.user) {
      const error = new Error('Original TSN login did not return token/user. Deploy the newest normal TSN version or enable direct MongoDB login.');
      error.statusCode = 502;
      throw error;
    }
    // Convert the original TSN token into a TSN-S token, so TSN-S does not break if the original token format changes.
    const user = publicTsnUser(data.user);
    return { token: jwt ? signStockSession(user) : data.token, user, authMode: 'api' };
  } catch (error) {
    const message = error.data?.error || error.message || 'Login fejlede.';
    const combined = directErrors.length ? `${message} Direct MongoDB fallback: ${directErrors.join(' | ')}` : message;
    const wrapped = new Error(combined);
    wrapped.statusCode = error.statusCode || 401;
    throw wrapped;
  }
}

async function getTsnSession(req) {
  const token = getBearerToken(req);
  if (!token) {
    const error = new Error('Du skal logge ind med din originale TSN-konto.');
    error.statusCode = 401;
    throw error;
  }

  const stockUser = verifyStockSession(token);
  if (stockUser) return { token, user: publicTsnUser(stockUser) };

  // Backward compatibility for older TSN-S tokens that were original TSN JWTs.
  if (TSN_API_BASE_URL) {
    const data = await fetchJsonWithRetry(joinApiUrl(TSN_API_BASE_URL, '/api/me'), {
      headers: { Authorization: `Bearer ${token}` }
    }, TSN_API_CONNECT_TIMEOUT_MS);
    if (data?.user) return { token, user: publicTsnUser(data.user) };
  }

  const error = new Error('Din TSN-S-session kunne ikke bekræftes. Log ind igen.');
  error.statusCode = 401;
  throw error;
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

function bestKnownStockPrice() {
  return Number(cachedPayload?.stock?.price) || Number(memoryHistory.at(-1)?.price) || TARGET_BASE_PRICE || 100;
}

function refreshStockInBackground(reason = 'background') {
  if (backgroundStockRefreshInFlight) return backgroundStockRefreshInFlight;
  backgroundStockRefreshInFlight = getStockPayload({ force: true })
    .catch((error) => {
      console.error(`Background TSN Stock refresh failed (${reason}):`, error.message);
      return null;
    })
    .finally(() => {
      backgroundStockRefreshInFlight = null;
    });
  return backgroundStockRefreshInFlight;
}

async function getCurrentStockPrice({ force = false } = {}) {
  if (!force && cachedPayload?.stock?.price) return Number(cachedPayload.stock.price) || TARGET_BASE_PRICE || 100;
  if (!force) return bestKnownStockPrice();
  try {
    const payload = await getStockPayload({ force: true });
    return Number(payload?.stock?.price) || bestKnownStockPrice();
  } catch {
    return bestKnownStockPrice();
  }
}

async function getPublicWalletFast(playerId, playerName, reward = null) {
  const wallet = await getWallet(playerId, playerName);
  return publicWallet(wallet, bestKnownStockPrice(), reward);
}

async function tradeStock({ playerId, playerName, type, quantity }) {
  const cleanType = String(type || '').toLowerCase();
  const qty = Number(quantity);
  if (!['buy', 'sell'].includes(cleanType)) throw new Error('Trade type must be buy or sell');
  if (!Number.isFinite(qty) || qty <= 0) throw new Error('Quantity must be higher than 0');
  if (qty > 1_000_000) throw new Error('Quantity is too large');

  const { wallet } = await rewardOnlineMinutes(playerId, playerName);
  const price = await getCurrentStockPrice({ force: false });
  refreshStockInBackground('after-trade');
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


function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function countSince(items, sinceMs, predicate = null) {
  return asArray(items).filter((item) => {
    const createdAt = new Date(item?.createdAt || item?.updatedAt || 0).getTime();
    if (!Number.isFinite(createdAt) || createdAt < sinceMs) return false;
    return predicate ? predicate(item) : true;
  }).length;
}

function getRecentActiveUserCount(state, sinceMs) {
  const activeIds = new Set();
  asArray(state.globalMessages).forEach((message) => {
    const postTime = new Date(message?.createdAt || 0).getTime();
    if (Number.isFinite(postTime) && postTime >= sinceMs && message.authorId) activeIds.add(String(message.authorId));
    asArray(message?.comments).forEach((comment) => {
      const commentTime = new Date(comment?.createdAt || 0).getTime();
      if (Number.isFinite(commentTime) && commentTime >= sinceMs && comment.authorId) activeIds.add(String(comment.authorId));
    });
  });
  asArray(state.messages).forEach((message) => {
    const time = new Date(message?.createdAt || 0).getTime();
    if (Number.isFinite(time) && time >= sinceMs) {
      if (message.from) activeIds.add(String(message.from));
      if (message.to) activeIds.add(String(message.to));
    }
  });
  return activeIds.size;
}

async function fetchOriginalStockFromMongo() {
  const state = await readOriginalTsnState();
  const now = new Date();
  const nowMs = now.getTime();
  const hourAgoMs = nowMs - 60 * 60 * 1000;
  const recentActiveMs = nowMs - 5 * 60 * 1000;
  const users = asArray(state.users).filter((user) => !isOriginalUserBanned(user));
  const usersTotal = Math.max(1, users.length);
  const privateMessagesPerHour = countSince(state.messages, hourAgoMs);
  const globalCommentsPerHour = asArray(state.globalMessages).reduce((total, message) => total + countSince(message?.comments, hourAgoMs), 0);
  const messagesPerHour = privateMessagesPerHour + globalCommentsPerHour;
  const postsPerHour = countSince(state.globalMessages, hourAgoMs);
  const onlineUsers = getRecentActiveUserCount(state, recentActiveMs);
  const expected = hourActivityCurve(now.getHours());
  const expectedOnline = Math.max(1, usersTotal * expected.online);
  const expectedMessagesPerHour = Math.max(1, usersTotal * 3.2 * expected.messages);
  const expectedPostsPerHour = Math.max(1, usersTotal * 0.9 * expected.posts);
  const onlineRatio = onlineUsers / expectedOnline;
  const messageRatio = messagesPerHour / expectedMessagesPerHour;
  const postRatio = postsPerHour / expectedPostsPerHour;
  const activityScore = Math.max(0, onlineRatio * 0.45 + messageRatio * 0.30 + postRatio * 0.25);
  return {
    symbol: 'TSN',
    name: 'TSN Stock',
    price: TARGET_BASE_PRICE,
    change: 0,
    changePercent: 0,
    trend: 'flat',
    updatedAt: now.toISOString(),
    metrics: {
      onlineUsers,
      usersTotal,
      messagesPerHour,
      privateMessagesPerHour,
      globalCommentsPerHour,
      postsPerHour,
      hour: now.getHours(),
      expectedOnline: Number(expectedOnline.toFixed(2)),
      expectedMessagesPerHour: Number(expectedMessagesPerHour.toFixed(2)),
      expectedPostsPerHour: Number(expectedPostsPerHour.toFixed(2)),
      activityScore: Number(activityScore.toFixed(3)),
      source: 'original-tsn-mongodb-fallback',
      onlineUsersMode: 'recent-active-5-minutes'
    },
    disclaimer: 'Fiktiv TSN-aktivitetspris. Aktivitet hentet direkte fra original TSN MongoDB.'
  };
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
      pricingEngine: 'event-driven-balanced-up-down-v8-robust-tsn-connection'
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
    pricingEngine: 'event-driven-balanced-up-down-v8-robust-tsn-connection'
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

function cleanHistory(documents, options = {}) {
  const limit = Number(options.limit || MAX_HISTORY_POINTS);
  const cleaned = (documents || [])
    .map((doc) => ({
      price: Number(doc.price) || 0,
      change: Number(doc.change) || 0,
      changePercent: Number(doc.changePercent) || 0,
      trend: doc.trend || 'flat',
      metrics: doc.metrics || {},
      createdAt: doc.createdAt || doc.sourceUpdatedAt || new Date().toISOString()
    }))
    .filter((point) => Number.isFinite(point.price) && point.price > 0)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  return limit > 0 ? cleaned.slice(-limit) : cleaned;
}

async function loadHistory(options = {}) {
  const sinceMs = Number(options.sinceMs || 0);
  const limit = Number(options.limit || MAX_HISTORY_POINTS);
  const sinceIso = sinceMs > 0 ? new Date(Date.now() - sinceMs).toISOString() : null;

  if (!PERSISTENCE_ENABLED) {
    const filtered = sinceIso
      ? memoryHistory.filter((point) => String(point.createdAt || point.sourceUpdatedAt || '') >= sinceIso)
      : memoryHistory;
    return cleanHistory(filtered, { limit });
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
  return cleanHistory(documents, { limit });
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
    return { history: await loadHistory({ limit: MAX_HISTORY_POINTS }), rebased: true, factor };
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
    memoryHistory = cleanHistory(memoryHistory, { limit: MAX_HISTORY_POINTS });
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
    memoryHistory = cleanHistory(memoryHistory, { limit: MAX_HISTORY_POINTS });
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

async function fetchOriginalStockFromApi() {
  if (!TSN_API_BASE_URL) throw new Error('TSN_API_BASE_URL is missing');
  const endpoints = ['/api/public/stock'];
  const errors = [];
  for (const endpoint of endpoints) {
    const fullUrl = joinApiUrl(TSN_API_BASE_URL, endpoint);
    try {
      const data = await fetchJsonWithRetry(fullUrl, { cache: 'no-store' }, TSN_API_CONNECT_TIMEOUT_MS);
      return { ...normalizeSourceStock(data), connectionSource: 'original-tsn-api', connectionEndpoint: endpoint };
    } catch (error) {
      errors.push(`${endpoint}: ${error.message}`);
    }
  }
  const error = new Error(`TSN API failed at ${TSN_API_BASE_URL}: ${errors.join(' | ')}`);
  error.statusCode = 502;
  error.connectionErrors = errors;
  throw error;
}

async function fetchOriginalStock() {
  const errors = [];

  if (TSN_API_BASE_URL) {
    try {
      return await fetchOriginalStockFromApi();
    } catch (error) {
      errors.push(error.message);
    }
  } else {
    errors.push('TSN_API_BASE_URL is missing');
  }

  if (EXPLICIT_ORIGINAL_TSN_MONGODB_URI && ORIGINAL_TSN_MONGODB_URI && MongoClient) {
    try {
      return { ...normalizeSourceStock(await fetchOriginalStockFromMongo()), connectionSource: 'original-tsn-mongodb' };
    } catch (error) {
      errors.push(`MongoDB fallback failed: ${error.message}`);
    }
  } else {
    errors.push('TSN_ORIGINAL_MONGODB_URI fallback is not configured. This is optional if TSN_API_BASE_URL works.');
  }

  const hint = 'Check that TSN_API_BASE_URL points to the normal TSN root URL, for example https://your-tsn.onrender.com, not the TSN-S URL and not a URL ending in /api.';
  const error = new Error(`Could not connect to original TSN. ${errors.join(' | ')} ${hint}`);
  error.statusCode = 502;
  error.connectionErrors = errors;
  throw error;
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
      history: clean.slice(-STOCK_PAYLOAD_HISTORY_POINTS).map((point) => ({
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
      memoryHistory = cleanHistory(memoryHistory, { limit: MAX_HISTORY_POINTS });
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
      tsnMoney: { earnPerMinute: TSNM_EARN_PER_MINUTE, walletCollection: WALLET_COLLECTION, tradeCollection: TRADE_COLLECTION, walletDatabase: PERSISTENCE_ENABLED ? DATABASE : null, walletPersistence: PERSISTENCE_ENABLED ? 'mongodb-uri' : 'memory' },
      tsnApiConfigured: Boolean(TSN_API_BASE_URL),
      tsnApiEnvName: TSN_API_ENV.name || null,
      tsnApiBaseUrl: TSN_API_BASE_URL || null,
      tsnApiTimeoutMs: TSN_API_CONNECT_TIMEOUT_MS,
      tsnApiRetries: TSN_API_RETRY_COUNT,
      originalTsnMongoLogin: Boolean(EXPLICIT_ORIGINAL_TSN_MONGODB_URI && ORIGINAL_TSN_MONGODB_URI && MongoClient && bcrypt && jwt),
      originalTsnMongoFallbackExplicit: Boolean(EXPLICIT_ORIGINAL_TSN_MONGODB_URI),
      originalTsnDatabase: ORIGINAL_TSN_DATABASE
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

  if (urlPath === '/api/source-test') {
    Promise.allSettled([
      TSN_API_BASE_URL
        ? fetchOriginalStockFromApi()
        : Promise.reject(new Error('TSN_API_BASE_URL is missing')),
      EXPLICIT_ORIGINAL_TSN_MONGODB_URI && ORIGINAL_TSN_MONGODB_URI && MongoClient
        ? fetchOriginalStockFromMongo()
        : Promise.reject(new Error('TSN_ORIGINAL_MONGODB_URI fallback is not configured. Optional if the API test works.'))
    ]).then(([apiResult, mongoResult]) => sendJson(res, 200, {
      ok: apiResult.status === 'fulfilled' || mongoResult.status === 'fulfilled',
      api: {
        configured: Boolean(TSN_API_BASE_URL),
        envName: TSN_API_ENV.name || null,
        baseUrl: TSN_API_BASE_URL || null,
        url: TSN_API_BASE_URL ? joinApiUrl(TSN_API_BASE_URL, '/api/public/stock') : null,
        timeoutMs: TSN_API_CONNECT_TIMEOUT_MS,
        retries: TSN_API_RETRY_COUNT,
        ok: apiResult.status === 'fulfilled',
        error: apiResult.status === 'rejected' ? apiResult.reason.message : null,
        metrics: apiResult.status === 'fulfilled' ? apiResult.value.metrics : null
      },
      mongodbFallback: {
        configured: Boolean(EXPLICIT_ORIGINAL_TSN_MONGODB_URI),
        database: ORIGINAL_TSN_DATABASE,
        collection: ORIGINAL_TSN_STATE_COLLECTION,
        ok: mongoResult.status === 'fulfilled',
        error: mongoResult.status === 'rejected' ? mongoResult.reason.message : null,
        metrics: mongoResult.status === 'fulfilled' ? mongoResult.value.metrics : null
      },
      setupHint: 'TSN_API_BASE_URL must be the normal TSN site root, for example https://your-tsn.onrender.com. Do not use the TSN-S URL.'
    })).catch((error) => sendJson(res, 500, { ok: false, error: error.message }));
    return;
  }

  if (urlPath === '/api/stock') {
    getStockPayload({ force: url.searchParams.get('force') === '1' })
      .then((payload) => sendJson(res, 200, payload))
      .catch((error) => sendJson(res, error.statusCode || 500, {
        ok: false,
        error: error.message,
        needs: !TSN_API_BASE_URL && !EXPLICIT_ORIGINAL_TSN_MONGODB_URI ? ['TSN_API_BASE_URL or TSN_ORIGINAL_MONGODB_URI'] : [],
        sourceTestUrl: '/api/source-test'
      }));
    return;
  }


  if (urlPath === '/api/wallet') {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'Use GET for wallet.' });
    walletForRequest(req)
      .then((identity) => getPublicWalletFast(identity.playerId, identity.playerName)
        .then((wallet) => ({ identity, wallet })))
      .then(({ identity, wallet }) => sendJson(res, 200, {
        ok: true,
        user: identity.user,
        wallet,
        earnPerMinute: TSNM_EARN_PER_MINUTE,
        persistence: PERSISTENCE_ENABLED ? 'mongodb-uri' : 'memory',
        walletDatabase: PERSISTENCE_ENABLED ? DATABASE : null,
        walletCollection: WALLET_COLLECTION,
        fictional: true
      }))
      .catch((error) => sendJson(res, error.statusCode || 400, { ok: false, error: error.data?.error || error.message }));
    return;
  }

  if (urlPath === '/api/wallet/tick') {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'Use POST for wallet tick.' });
    walletForRequest(req)
      .then((identity) => rewardOnlineMinutes(identity.playerId, identity.playerName)
        .then((result) => ({ identity, result })))
      .then(({ identity, result }) => sendJson(res, 200, {
        ok: true,
        user: identity.user,
        wallet: publicWallet(result.wallet, bestKnownStockPrice(), result.reward),
        earnPerMinute: TSNM_EARN_PER_MINUTE,
        persistence: PERSISTENCE_ENABLED ? 'mongodb-uri' : 'memory',
        walletDatabase: PERSISTENCE_ENABLED ? DATABASE : null,
        walletCollection: WALLET_COLLECTION,
        fictional: true
      }))
      .catch((error) => sendJson(res, error.statusCode || 400, { ok: false, error: error.data?.error || error.message }));
    return;
  }

  if (urlPath === '/api/wallet/test') {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'Use GET for wallet test.' });
    walletForRequest(req)
      .then(async (identity) => {
        const wallet = await getWallet(identity.playerId, identity.playerName);
        let databaseWriteOk = !PERSISTENCE_ENABLED;
        let databaseError = null;
        if (PERSISTENCE_ENABLED) {
          try {
            const collection = await getWalletCollection();
            await collection.updateOne(
              { playerId: wallet.playerId },
              { $set: { walletTestedAt: new Date().toISOString() } },
              { upsert: true }
            );
            databaseWriteOk = true;
          } catch (error) {
            databaseError = error.message;
          }
        }
        return { identity, wallet, databaseWriteOk, databaseError };
      })
      .then(({ identity, wallet, databaseWriteOk, databaseError }) => sendJson(res, 200, {
        ok: databaseWriteOk,
        user: identity.user,
        playerId: identity.playerId,
        persistence: PERSISTENCE_ENABLED ? 'mongodb-uri' : 'memory',
        walletDatabase: PERSISTENCE_ENABLED ? DATABASE : null,
        walletCollection: WALLET_COLLECTION,
        databaseWriteOk,
        databaseError,
        wallet: publicWallet(wallet, bestKnownStockPrice()),
        message: databaseWriteOk
          ? 'Wallet can load and save.'
          : 'Wallet loaded, but MongoDB write failed. Check MONGODB_URI and database permissions.'
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

  if (urlPath === '/api/trade/test') {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'Use GET for trade test.' });
    walletForRequest(req)
      .then(async (identity) => {
        const wallet = await getWallet(identity.playerId, identity.playerName);
        const price = await getCurrentStockPrice({ force: false });
        return { identity, wallet, price };
      })
      .then(({ identity, wallet, price }) => sendJson(res, 200, {
        ok: true,
        user: identity.user,
        playerId: identity.playerId,
        price,
        wallet: publicWallet(wallet, price),
        canBuyOneShare: (Number(wallet.balance) || 0) >= price,
        persistence: PERSISTENCE_ENABLED ? 'mongodb-uri' : 'memory',
        walletDatabase: PERSISTENCE_ENABLED ? DATABASE : null,
        walletCollection: WALLET_COLLECTION,
        message: 'Trade route can read your wallet and find a usable stock price without waiting for normal TSN.'
      }))
      .catch((error) => sendJson(res, error.statusCode || 400, { ok: false, error: error.data?.error || error.message }));
    return;
  }

  if (urlPath === '/api/history') {
    const range = url.searchParams.get('range') || '10m';
    const sinceMs = historyRangeToMs(range);
    const limit = Math.min(Number(url.searchParams.get('limit') || HISTORY_API_MAX_POINTS), HISTORY_API_MAX_POINTS * 2);
    const estimatedRangePoints = sinceMs
      ? Math.ceil(sinceMs / Math.max(1000, REFRESH_INTERVAL_MS)) + 60
      : MAX_HISTORY_POINTS;
    const queryLimit = sinceMs
      ? Math.min(Math.max(estimatedRangePoints, limit * 5, 5000), MAX_HISTORY_POINTS)
      : Math.min(Math.max(MAX_HISTORY_POINTS, limit * 10), MAX_HISTORY_POINTS);
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
        historyApiMaxPoints: HISTORY_API_MAX_POINTS,
        storedHistoryPoints: MAX_HISTORY_POINTS,
        stockPayloadHistoryPoints: STOCK_PAYLOAD_HISTORY_POINTS
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
  } else {
    console.log(`Original TSN API: ${TSN_API_BASE_URL} (${TSN_API_ENV.name || 'env'})`);
  }
  if (!PERSISTENCE_ENABLED) {
    console.warn('MongoDB persistence is not configured. Set MONGODB_URI, plus optional MONGODB_DATABASE and MONGODB_COLLECTION.');
  }
});
