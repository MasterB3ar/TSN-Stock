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
const TSN_STOCK_ALLOWED_USERNAME = normalizeUsername(process.env.TSN_STOCK_ALLOWED_USERNAME || 'ceo');
const ACCESS_DENIED_MESSAGE = 'access denied';
const TSN_DATA_ENCRYPTION_KEY = String(process.env.TSN_DATA_ENCRYPTION_KEY || process.env.JWT_SECRET || 'dev-data-encryption-key-change-before-release-32chars');
const COLLECTION = String(process.env.MONGODB_COLLECTION || 'stockSnapshots');
const MARKET_TIMEZONE = String(process.env.TSN_STOCK_MARKET_TIMEZONE || process.env.TSN_MARKET_TIMEZONE || 'Europe/Copenhagen');
const MARKET_WINDOWS = [
  { start: '08:10', end: '09:30', label: 'Morning session' },
  { start: '09:50', end: '11:15', label: 'Late-morning session' },
  { start: '12:00', end: '13:30', label: 'Afternoon session' }
];
const MAX_HISTORY_POINTS = Number(process.env.TSN_STOCK_MAX_HISTORY || 302400); // 7 days at 2-second snapshots
const STOCK_PAYLOAD_HISTORY_POINTS = Number(process.env.TSN_STOCK_PAYLOAD_HISTORY_POINTS || 720);
const HISTORY_API_MAX_POINTS = Number(process.env.TSN_STOCK_HISTORY_API_MAX_POINTS || 1400);
const REFRESH_INTERVAL_MS = Number(process.env.TSN_STOCK_REFRESH_MS || 2000);
const BACKGROUND_UPDATER_ENABLED = String(process.env.TSN_STOCK_BACKGROUND_UPDATER || 'true').toLowerCase() !== 'false';
const BACKGROUND_UPDATE_INTERVAL_MS = Math.max(10_000, Number(process.env.TSN_STOCK_BACKGROUND_UPDATE_MS || 60_000));
const BACKGROUND_UPDATE_WHEN_CLOSED = String(process.env.TSN_STOCK_BACKGROUND_UPDATE_WHEN_CLOSED || 'true').toLowerCase() !== 'false';
const BACKGROUND_STARTUP_REFRESH = String(process.env.TSN_STOCK_BACKGROUND_STARTUP_REFRESH || 'true').toLowerCase() !== 'false';
const CRON_TICK_SECRET = String(process.env.TSN_STOCK_CRON_SECRET || '').trim();
const CRON_TICK_MIN_INTERVAL_MS = Math.max(10_000, Number(process.env.TSN_STOCK_CRON_MIN_INTERVAL_MS || 30_000));
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
const ANTI_SPAM_ENABLED = String(process.env.TSN_STOCK_ANTI_SPAM || 'true').toLowerCase() !== 'false';
const ANTI_SPAM_MESSAGE_CAP_PER_USER_PER_HOUR = Number(process.env.TSN_STOCK_SPAM_MESSAGE_CAP_PER_USER_PER_HOUR || 8);
const ANTI_SPAM_POST_CAP_PER_USER_PER_HOUR = Number(process.env.TSN_STOCK_SPAM_POST_CAP_PER_USER_PER_HOUR || 3);
const ANTI_SPAM_DUPLICATE_WINDOW_MS = Number(process.env.TSN_STOCK_SPAM_DUPLICATE_WINDOW_MS || 120000);
const ANTI_SPAM_MIN_UNIQUE_USERS_FOR_FULL_BOOST = Number(process.env.TSN_STOCK_SPAM_MIN_UNIQUE_USERS_FOR_FULL_BOOST || 2);
const RESET_ENABLED = String(process.env.TSN_STOCK_ENABLE_RESET || 'false').toLowerCase() === 'true';

const PERSISTENCE_ENABLED = Boolean(MONGODB_URI);
let mongoClient = null;
let mongoCollection = null;
let originalTsnMongoClient = null;

let cachedPayload = null;
let cachedAt = 0;
let memoryHistory = [];
let backgroundTimer = null;
let backgroundTickInProgress = false;
let lastCronTickAt = 0;
const backgroundStatus = {
  enabled: BACKGROUND_UPDATER_ENABLED,
  intervalMs: BACKGROUND_UPDATE_INTERVAL_MS,
  updateWhenClosed: BACKGROUND_UPDATE_WHEN_CLOSED,
  startupRefresh: BACKGROUND_STARTUP_REFRESH,
  cronEndpoint: '/api/cron/tick',
  cronSecretConfigured: Boolean(CRON_TICK_SECRET),
  running: false,
  lastTrigger: null,
  lastStartedAt: null,
  lastFinishedAt: null,
  lastSuccessAt: null,
  lastErrorAt: null,
  lastError: null,
  totalRuns: 0,
  totalSuccess: 0,
  totalErrors: 0,
  lastPrice: null,
  lastSource: null
};

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


function timeToMinutes(value) {
  const [hours, minutes] = String(value || '00:00').split(':').map((part) => Number(part));
  return clamp((Number.isFinite(hours) ? hours : 0) * 60 + (Number.isFinite(minutes) ? minutes : 0), 0, 1439);
}

function minutesToTime(minutes) {
  const clean = ((Number(minutes) % 1440) + 1440) % 1440;
  const hours = String(Math.floor(clean / 60)).padStart(2, '0');
  const mins = String(clean % 60).padStart(2, '0');
  return `${hours}:${mins}`;
}

function marketClock(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: MARKET_TIMEZONE,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});

  const hour = Number(parts.hour) || 0;
  const minute = Number(parts.minute) || 0;
  const second = Number(parts.second) || 0;
  return {
    hour,
    minute,
    second,
    minuteOfDay: hour * 60 + minute,
    localTime: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`,
    localDate: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: parts.weekday || ''
  };
}

function getMarketStatus(date = new Date()) {
  const clock = marketClock(date);
  const schedule = MARKET_WINDOWS.map((window) => ({
    ...window,
    startMinutes: timeToMinutes(window.start),
    endMinutes: timeToMinutes(window.end)
  }));
  const activeWindow = schedule.find((window) => clock.minuteOfDay >= window.startMinutes && clock.minuteOfDay < window.endMinutes) || null;
  const open = Boolean(activeWindow);

  let nextMinute;
  let nextStatus;
  let nextLabel;
  if (open) {
    nextMinute = activeWindow.endMinutes;
    nextStatus = 'closed';
    nextLabel = `Closes at ${activeWindow.end}`;
  } else {
    const nextWindowToday = schedule.find((window) => clock.minuteOfDay < window.startMinutes);
    if (nextWindowToday) {
      nextMinute = nextWindowToday.startMinutes;
      nextStatus = 'open';
      nextLabel = `Opens at ${nextWindowToday.start}`;
    } else {
      nextMinute = schedule[0].startMinutes + 24 * 60;
      nextStatus = 'open';
      nextLabel = `Opens tomorrow at ${schedule[0].start}`;
    }
  }

  const nowSecondOfDay = clock.minuteOfDay * 60 + clock.second;
  const nextSecond = nextMinute * 60;
  const secondsUntilNextChange = Math.max(0, nextSecond - nowSecondOfDay);

  return {
    open,
    state: open ? 'open' : 'closed',
    label: open ? 'TSN-S open' : 'TSN-S closed',
    message: open
      ? `Trading is open until ${activeWindow.end} (${MARKET_TIMEZONE}).`
      : `Trading is closed. ${nextLabel} (${MARKET_TIMEZONE}).`,
    timezone: MARKET_TIMEZONE,
    localTime: clock.localTime,
    localDate: clock.localDate,
    activeWindow: activeWindow ? { start: activeWindow.start, end: activeWindow.end, label: activeWindow.label } : null,
    nextStatus,
    nextChangeAt: minutesToTime(nextMinute),
    nextChangeLabel: nextLabel,
    secondsUntilNextChange,
    schedule: schedule.map((window) => ({ start: window.start, end: window.end, label: window.label }))
  };
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

function getStableUserId(user) {
  const raw = user?.id || user?._id || user?.userId || user?.uid || user?.sub || user?.username || user?.name || 'ceo';
  return String(raw);
}

function signStockSession(user) {
  if (!jwt) throw new Error('jsonwebtoken is not installed.');
  return jwt.sign({
    iss: 'tsn-stock',
    sub: getStableUserId(user),
    username: String(user.username || user.name || ''),
    name: String(user.name || user.username || 'TSN User'),
    role: user.role || 'user',
    isAdmin: Boolean(user.isAdmin || user.role === 'admin')
  }, STOCK_SESSION_SECRET, { expiresIn: '7d' });
}

function verifyStockSession(token) {
  if (!jwt || !token) return null;
  try {
    const payload = jwt.verify(token, STOCK_SESSION_SECRET);
    if (payload?.iss !== 'tsn-stock') return null;
    const username = String(payload.username || payload.name || 'tsn-user');
    return {
      id: String(payload.sub || username || 'ceo'),
      username,
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
  const publicUser = assertCeoAccess({
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
  const username = String(user?.username || user?.name || 'tsn-user');
  return {
    id: getStableUserId({ ...user, username }),
    username,
    name: String(user?.name || user?.username || 'TSN User'),
    role: user?.role || 'user',
    isAdmin: Boolean(user?.isAdmin || user?.role === 'admin')
  };
}

function isAllowedCeoUser(user) {
  return normalizeUsername(user?.username || user?.name || '') === TSN_STOCK_ALLOWED_USERNAME;
}

function makeAccessDeniedError() {
  const error = new Error(ACCESS_DENIED_MESSAGE);
  error.statusCode = 403;
  error.accessDenied = true;
  return error;
}

function assertCeoAccess(user) {
  const publicUser = publicTsnUser(user);
  if (!isAllowedCeoUser(publicUser)) throw makeAccessDeniedError();
  return publicUser;
}

function disabledCommerceResponse(res) {
  return sendJson(res, 410, {
    ok: false,
    error: 'Wallet and stock trading are removed. TSN-S is now a read-only CEO dashboard.'
  });
}

async function proxyTsnLogin(username, password) {
  if (normalizeUsername(username) !== TSN_STOCK_ALLOWED_USERNAME) {
    throw makeAccessDeniedError();
  }
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
    const user = assertCeoAccess(data.user);
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
  if (stockUser) return { token, user: assertCeoAccess(stockUser) };

  // Backward compatibility for older TSN-S tokens that were original TSN JWTs.
  if (TSN_API_BASE_URL) {
    const data = await fetchJsonWithRetry(joinApiUrl(TSN_API_BASE_URL, '/api/me'), {
      headers: { Authorization: `Bearer ${token}` }
    }, TSN_API_CONNECT_TIMEOUT_MS);
    if (data?.user) return { token, user: assertCeoAccess(data.user) };
  }

  const error = new Error('Din TSN-S-session kunne ikke bekræftes. Log ind igen.');
  error.statusCode = 401;
  throw error;
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

function normalizeSpamText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' link ')
    .replace(/[^a-z0-9æøåäöüß]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220);
}

function readTextField(item = {}) {
  return item.text
    || item.content
    || item.body
    || item.message
    || item.comment
    || item.caption
    || item.title
    || '';
}

function readActorId(item = {}, candidates = []) {
  for (const key of candidates) {
    if (item?.[key]) return String(item[key]);
  }
  if (item?.authorId) return String(item.authorId);
  if (item?.userId) return String(item.userId);
  if (item?.from) return String(item.from);
  if (item?.senderId) return String(item.senderId);
  if (item?.username) return String(item.username);
  return 'unknown';
}

function buildAntiSpamStatsFromState(state, sinceMs) {
  const events = [];
  const pushEvent = (kind, item, actorCandidates, bucket) => {
    const createdAt = new Date(item?.createdAt || item?.updatedAt || 0).getTime();
    if (!Number.isFinite(createdAt) || createdAt < sinceMs) return;
    events.push({
      kind,
      bucket,
      createdAt,
      actorId: readActorId(item, actorCandidates),
      text: readTextField(item)
    });
  };

  asArray(state.globalMessages).forEach((message) => {
    pushEvent('post', message, ['authorId', 'userId', 'username'], 'globalPosts');
    asArray(message?.comments).forEach((comment) => {
      pushEvent('message', comment, ['authorId', 'userId', 'username'], 'globalComments');
    });
  });
  asArray(state.messages).forEach((message) => {
    pushEvent('message', message, ['from', 'authorId', 'senderId', 'userId', 'username'], 'privateMessages');
  });

  events.sort((a, b) => a.createdAt - b.createdAt);

  const messageCap = Math.max(1, ANTI_SPAM_MESSAGE_CAP_PER_USER_PER_HOUR);
  const postCap = Math.max(1, ANTI_SPAM_POST_CAP_PER_USER_PER_HOUR);
  const duplicateWindowMs = Math.max(0, ANTI_SPAM_DUPLICATE_WINDOW_MS);
  const seenTextAt = new Map();
  const countedMessagesByUser = new Map();
  const countedPostsByUser = new Map();
  const messageUsers = new Set();
  const postUsers = new Set();
  const rawMessageUsers = new Set();
  const rawPostUsers = new Set();

  const stats = {
    enabled: ANTI_SPAM_ENABLED,
    rawMessagesPerHour: 0,
    rawPrivateMessagesPerHour: 0,
    rawGlobalCommentsPerHour: 0,
    rawPostsPerHour: 0,
    messagesPerHour: 0,
    privateMessagesPerHour: 0,
    globalCommentsPerHour: 0,
    postsPerHour: 0,
    ignoredDuplicateMessages: 0,
    ignoredDuplicatePosts: 0,
    ignoredOverLimitMessages: 0,
    ignoredOverLimitPosts: 0
  };

  for (const event of events) {
    const actorId = event.actorId || 'unknown';
    const isPost = event.kind === 'post';
    const text = normalizeSpamText(event.text);
    const textKey = `${event.kind}:${actorId}:${text || '<empty>'}`;

    if (isPost) {
      stats.rawPostsPerHour += 1;
      rawPostUsers.add(actorId);
    } else {
      stats.rawMessagesPerHour += 1;
      rawMessageUsers.add(actorId);
      if (event.bucket === 'privateMessages') stats.rawPrivateMessagesPerHour += 1;
      if (event.bucket === 'globalComments') stats.rawGlobalCommentsPerHour += 1;
    }

    if (!ANTI_SPAM_ENABLED) {
      if (isPost) {
        stats.postsPerHour += 1;
        postUsers.add(actorId);
      } else {
        stats.messagesPerHour += 1;
        messageUsers.add(actorId);
        if (event.bucket === 'privateMessages') stats.privateMessagesPerHour += 1;
        if (event.bucket === 'globalComments') stats.globalCommentsPerHour += 1;
      }
      continue;
    }

    const lastSeen = seenTextAt.get(textKey) || 0;
    if (text && duplicateWindowMs > 0 && lastSeen && event.createdAt - lastSeen < duplicateWindowMs) {
      if (isPost) stats.ignoredDuplicatePosts += 1;
      else stats.ignoredDuplicateMessages += 1;
      continue;
    }
    seenTextAt.set(textKey, event.createdAt);

    if (isPost) {
      const previousCount = countedPostsByUser.get(actorId) || 0;
      if (previousCount >= postCap) {
        stats.ignoredOverLimitPosts += 1;
        continue;
      }
      countedPostsByUser.set(actorId, previousCount + 1);
      stats.postsPerHour += 1;
      postUsers.add(actorId);
    } else {
      const previousCount = countedMessagesByUser.get(actorId) || 0;
      if (previousCount >= messageCap) {
        stats.ignoredOverLimitMessages += 1;
        continue;
      }
      countedMessagesByUser.set(actorId, previousCount + 1);
      stats.messagesPerHour += 1;
      messageUsers.add(actorId);
      if (event.bucket === 'privateMessages') stats.privateMessagesPerHour += 1;
      if (event.bucket === 'globalComments') stats.globalCommentsPerHour += 1;
    }
  }

  const uniqueMessageUsers = messageUsers.size;
  const uniquePostUsers = postUsers.size;
  const uniqueContributors = new Set([...messageUsers, ...postUsers]).size;
  const rawUniqueContributors = new Set([...rawMessageUsers, ...rawPostUsers]).size;
  const spamIgnored = stats.ignoredDuplicateMessages
    + stats.ignoredDuplicatePosts
    + stats.ignoredOverLimitMessages
    + stats.ignoredOverLimitPosts;
  const minUniqueUsersForFullBoost = Math.max(1, ANTI_SPAM_MIN_UNIQUE_USERS_FOR_FULL_BOOST);
  const singleUserSpamSuppressed = ANTI_SPAM_ENABLED && spamIgnored > 0 && rawUniqueContributors < minUniqueUsersForFullBoost;
  if (singleUserSpamSuppressed) {
    stats.messagesPerHour = 0;
    stats.privateMessagesPerHour = 0;
    stats.globalCommentsPerHour = 0;
    stats.postsPerHour = 0;
  }

  return {
    ...stats,
    uniqueMessageUsers,
    uniquePostUsers,
    uniqueContributors,
    rawUniqueContributors,
    spamIgnored,
    spamDetected: spamIgnored > 0,
    singleUserSpamSuppressed,
    messageCapPerUserPerHour: messageCap,
    postCapPerUserPerHour: postCap,
    duplicateWindowMs,
    minUniqueUsersForFullBoost
  };
}

function applyMetricAntiSpam(metrics = {}) {
  const rawMessagesPerHour = Math.max(0, Number(metrics.rawMessagesPerHour ?? metrics.messagesPerHour) || 0);
  const rawPostsPerHour = Math.max(0, Number(metrics.rawPostsPerHour ?? metrics.postsPerHour) || 0);
  const usersTotal = Math.max(1, Number(metrics.usersTotal) || Number(metrics.totalUsers) || Math.max(1, Number(metrics.onlineUsers) || 1));
  const onlineUsers = Math.max(0, Number(metrics.onlineUsers) || 0);
  const knownContributors = Math.max(
    Number(metrics.uniqueContributors) || 0,
    Number(metrics.uniqueMessageUsers) || 0,
    Number(metrics.uniquePostUsers) || 0,
    onlineUsers || 0,
    1
  );
  const contributorBase = clamp(knownContributors, 1, usersTotal);
  const messageCap = Math.max(1, ANTI_SPAM_MESSAGE_CAP_PER_USER_PER_HOUR) * contributorBase;
  const postCap = Math.max(1, ANTI_SPAM_POST_CAP_PER_USER_PER_HOUR) * contributorBase;

  let messagesPerHour = Math.max(0, Number(metrics.messagesPerHour) || 0);
  let postsPerHour = Math.max(0, Number(metrics.postsPerHour) || 0);
  let apiSpamLimitedMessages = 0;
  let apiSpamLimitedPosts = 0;
  let singleUserSpamSuppressed = Boolean(metrics.antiSpam?.singleUserSpamSuppressed);

  if (ANTI_SPAM_ENABLED) {
    const limitedMessages = Math.min(messagesPerHour, messageCap);
    const limitedPosts = Math.min(postsPerHour, postCap);
    apiSpamLimitedMessages = Math.max(0, messagesPerHour - limitedMessages);
    apiSpamLimitedPosts = Math.max(0, postsPerHour - limitedPosts);
    messagesPerHour = limitedMessages;
    postsPerHour = limitedPosts;
    const detectedApiSpam = apiSpamLimitedMessages > 0 || apiSpamLimitedPosts > 0 || Boolean(metrics.antiSpam?.spamDetected);
    if (detectedApiSpam && contributorBase < Math.max(1, ANTI_SPAM_MIN_UNIQUE_USERS_FOR_FULL_BOOST)) {
      messagesPerHour = 0;
      postsPerHour = 0;
      singleUserSpamSuppressed = true;
    }
  }

  return {
    ...metrics,
    rawMessagesPerHour,
    rawPostsPerHour,
    messagesPerHour: Number(messagesPerHour.toFixed(3)),
    postsPerHour: Number(postsPerHour.toFixed(3)),
    antiSpam: {
      ...(metrics.antiSpam || {}),
      enabled: ANTI_SPAM_ENABLED,
      source: metrics.antiSpam?.source || metrics.source || 'metrics',
      contributorBase: Number(contributorBase.toFixed(3)),
      messageCapPerUserPerHour: Math.max(1, ANTI_SPAM_MESSAGE_CAP_PER_USER_PER_HOUR),
      postCapPerUserPerHour: Math.max(1, ANTI_SPAM_POST_CAP_PER_USER_PER_HOUR),
      messageCapAppliedPerHour: Number(messageCap.toFixed(3)),
      postCapAppliedPerHour: Number(postCap.toFixed(3)),
      rawMessagesPerHour,
      rawPostsPerHour,
      effectiveMessagesPerHour: Number(messagesPerHour.toFixed(3)),
      effectivePostsPerHour: Number(postsPerHour.toFixed(3)),
      apiSpamLimitedMessages: Number(apiSpamLimitedMessages.toFixed(3)),
      apiSpamLimitedPosts: Number(apiSpamLimitedPosts.toFixed(3)),
      spamDetected: Boolean(metrics.antiSpam?.spamDetected || apiSpamLimitedMessages > 0 || apiSpamLimitedPosts > 0),
      singleUserSpamSuppressed,
      spamIgnored: Number(metrics.antiSpam?.spamIgnored || 0) + apiSpamLimitedMessages + apiSpamLimitedPosts
    }
  };
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
  const antiSpamStats = buildAntiSpamStatsFromState(state, hourAgoMs);
  const privateMessagesPerHour = antiSpamStats.privateMessagesPerHour;
  const globalCommentsPerHour = antiSpamStats.globalCommentsPerHour;
  const messagesPerHour = antiSpamStats.messagesPerHour;
  const postsPerHour = antiSpamStats.postsPerHour;
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
      globalChatsPerHour: postsPerHour,
      hour: now.getHours(),
      expectedOnline: Number(expectedOnline.toFixed(2)),
      expectedMessagesPerHour: Number(expectedMessagesPerHour.toFixed(2)),
      expectedPostsPerHour: Number(expectedPostsPerHour.toFixed(2)),
      activityScore: Number(activityScore.toFixed(3)),
      source: 'original-tsn-mongodb-fallback',
      onlineUsersMode: 'recent-active-5-minutes',
      rawMessagesPerHour: antiSpamStats.rawMessagesPerHour,
      rawPrivateMessagesPerHour: antiSpamStats.rawPrivateMessagesPerHour,
      rawGlobalCommentsPerHour: antiSpamStats.rawGlobalCommentsPerHour,
      rawPostsPerHour: antiSpamStats.rawPostsPerHour,
      rawGlobalChatsPerHour: antiSpamStats.rawPostsPerHour,
      uniqueMessageUsers: antiSpamStats.uniqueMessageUsers,
      uniquePostUsers: antiSpamStats.uniquePostUsers,
      uniqueContributors: antiSpamStats.uniqueContributors,
      antiSpam: { ...antiSpamStats, source: 'original-tsn-mongodb-fallback' }
    },
    disclaimer: 'Fiktiv TSN-aktivitetspris. Aktivitet hentet direkte fra original TSN MongoDB.'
  };
}

function normalizeSourceStock(data) {
  const stock = data?.stock || data;
  if (!stock || typeof stock !== 'object') throw new Error('Original TSN API did not return stock data');
  const now = new Date().toISOString();
  const sourceMetrics = stock.metrics && typeof stock.metrics === 'object' ? stock.metrics : {};
  const metrics = applyMetricAntiSpam({
    ...sourceMetrics,
    onlineUsers: Number(sourceMetrics.onlineUsers) || 0,
    usersTotal: Number(sourceMetrics.usersTotal || sourceMetrics.totalUsers) || undefined,
    messagesPerHour: Number(sourceMetrics.messagesPerHour) || 0,
    postsPerHour: Number(sourceMetrics.globalChatsPerHour ?? sourceMetrics.postsPerHour) || 0,
    globalChatsPerHour: Number(sourceMetrics.globalChatsPerHour ?? sourceMetrics.postsPerHour) || 0,
    activityScore: Number(sourceMetrics.activityScore) || 0,
    source: sourceMetrics.source || 'original-tsn-api'
  });
  return {
    price: Number(stock.price) || 100,
    change: Number(stock.change) || 0,
    changePercent: Number(stock.changePercent) || 0,
    trend: stock.trend || 'flat',
    updatedAt: stock.updatedAt || now,
    metrics,
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
  const protectedMetrics = applyMetricAntiSpam(metrics);
  const now = new Date();
  const hour = Number.isFinite(Number(protectedMetrics.hour)) ? Number(protectedMetrics.hour) : now.getHours();
  const curve = hourActivityCurve(hour);
  const usersTotal = Math.max(1, Number(protectedMetrics.usersTotal) || Number(protectedMetrics.totalUsers) || Math.max(1, Number(protectedMetrics.onlineUsers) || 1));
  const onlineUsers = Math.max(0, Number(protectedMetrics.onlineUsers) || 0);
  const messagesPerHour = Math.max(0, Number(protectedMetrics.messagesPerHour) || 0);
  const postsPerHour = Math.max(0, Number(protectedMetrics.postsPerHour) || 0);
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
  // The price engine intentionally uses the anti-spam-adjusted score instead of
  // trusting a raw source activityScore. One spammer can raise raw message counts,
  // but the effective score below is capped before it can move the stock.
  const sourceActivityScore = Number(protectedMetrics.activityScore);
  const activityScore = calculatedActivityScore;
  const activityPoints = Math.max(0, Math.round(activityScore * Math.max(1, ACTIVITY_SCORE_POINTS_MULTIPLIER)));
  const priceActivityScore = clamp(
    Math.log1p(activityScore) / Math.log(2),
    0,
    Math.max(1, ACTIVITY_SCORE_PRICE_SOFT_CAP)
  );

  return {
    ...protectedMetrics,
    onlineUsers,
    usersTotal,
    messagesPerHour,
    postsPerHour,
    globalChatsPerHour: postsPerHour,
    rawGlobalChatsPerHour: protectedMetrics.rawPostsPerHour,
    hour,
    expectedOnline: Number(expectedOnline.toFixed(2)),
    expectedMessagesPerHour: Number(expectedMessagesPerHour.toFixed(2)),
    expectedPostsPerHour: Number(expectedPostsPerHour.toFixed(2)),
    onlineRatio: Number(onlineRatio.toFixed(4)),
    messageRatio: Number(messageRatio.toFixed(4)),
    postRatio: Number(postRatio.toFixed(4)),
    sourceActivityScore: Number.isFinite(sourceActivityScore) ? Number(sourceActivityScore.toFixed(3)) : 0,
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


function msSinceLocalMidnight(timezone = MARKET_TIMEZONE, date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  const hours = Number(parts.hour) || 0;
  const minutes = Number(parts.minute) || 0;
  const seconds = Number(parts.second) || 0;
  return Math.max(0, ((hours * 60 * 60) + (minutes * 60) + seconds) * 1000 + date.getMilliseconds());
}

function historyRangeToMs(range) {
  const value = String(range || '10m').toLowerCase();
  const ranges = {
    '10m': 10 * 60 * 1000,
    '30m': 30 * 60 * 1000,
    '1h': 60 * 60 * 1000,
    '6h': 6 * 60 * 60 * 1000,
    'today': msSinceLocalMidnight(MARKET_TIMEZONE),
    '1d': 24 * 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000
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
      source,
      market: getMarketStatus(),
      backgroundUpdater: getBackgroundUpdaterStatus()
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


function getBackgroundUpdaterStatus() {
  return {
    ...backgroundStatus,
    running: backgroundTickInProgress,
    lastCronTickAt: lastCronTickAt ? new Date(lastCronTickAt).toISOString() : null
  };
}

function cronSecretAllowed(req, url) {
  if (!CRON_TICK_SECRET) return true;
  const supplied = String(req.headers['x-cron-secret'] || url.searchParams.get('secret') || url.searchParams.get('key') || '').trim();
  return supplied && supplied === CRON_TICK_SECRET;
}

async function runBackgroundSnapshot(trigger = 'background') {
  const market = getMarketStatus();
  if (!BACKGROUND_UPDATE_WHEN_CLOSED && !market.open && trigger !== 'manual' && trigger !== 'cron') {
    backgroundStatus.lastTrigger = trigger;
    backgroundStatus.lastFinishedAt = new Date().toISOString();
    backgroundStatus.lastError = null;
    return {
      ok: true,
      skipped: true,
      reason: 'market-closed',
      market,
      background: getBackgroundUpdaterStatus()
    };
  }

  if (backgroundTickInProgress) {
    return {
      ok: true,
      skipped: true,
      reason: 'already-running',
      market,
      background: getBackgroundUpdaterStatus()
    };
  }

  backgroundTickInProgress = true;
  backgroundStatus.running = true;
  backgroundStatus.lastTrigger = trigger;
  backgroundStatus.lastStartedAt = new Date().toISOString();
  backgroundStatus.totalRuns += 1;

  try {
    const payload = await getStockPayload({ force: true });
    const stock = payload?.stock || {};
    const finishedAt = new Date().toISOString();
    backgroundStatus.lastFinishedAt = finishedAt;
    backgroundStatus.lastSuccessAt = finishedAt;
    backgroundStatus.lastError = null;
    backgroundStatus.totalSuccess += 1;
    backgroundStatus.lastPrice = Number(stock.price || 0);
    backgroundStatus.lastSource = stock.source || null;
    return {
      ok: true,
      skipped: false,
      trigger,
      saved: Boolean(stock.persistence?.saved),
      persistence: stock.persistence || null,
      price: stock.price,
      change: stock.change,
      changePercent: stock.changePercent,
      source: stock.source,
      updatedAt: stock.updatedAt,
      market: stock.market || market,
      background: getBackgroundUpdaterStatus()
    };
  } catch (error) {
    const finishedAt = new Date().toISOString();
    backgroundStatus.lastFinishedAt = finishedAt;
    backgroundStatus.lastErrorAt = finishedAt;
    backgroundStatus.lastError = error.message || 'Background update failed.';
    backgroundStatus.totalErrors += 1;
    throw error;
  } finally {
    backgroundTickInProgress = false;
    backgroundStatus.running = false;
  }
}

function startBackgroundUpdater() {
  if (!BACKGROUND_UPDATER_ENABLED) {
    console.log('TSN-S background updater is disabled. Set TSN_STOCK_BACKGROUND_UPDATER=true to enable it.');
    return;
  }
  if (backgroundTimer) clearInterval(backgroundTimer);
  backgroundTimer = setInterval(() => {
    runBackgroundSnapshot('timer').catch((error) => {
      console.error('TSN-S background update failed:', error.message);
    });
  }, BACKGROUND_UPDATE_INTERVAL_MS);
  if (typeof backgroundTimer.unref === 'function') backgroundTimer.unref();

  console.log(`TSN-S background updater enabled every ${Math.round(BACKGROUND_UPDATE_INTERVAL_MS / 1000)}s${BACKGROUND_UPDATE_WHEN_CLOSED ? ' including closed hours' : ' during open hours only'}.`);
  if (BACKGROUND_STARTUP_REFRESH) {
    setTimeout(() => {
      runBackgroundSnapshot('startup').catch((error) => {
        console.error('TSN-S startup background update failed:', error.message);
      });
    }, 1500).unref?.();
  }
}


function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function summarizeHistory(history = []) {
  const clean = cleanHistory(history, { limit: 0 });
  if (!clean.length) {
    return {
      points: 0,
      firstPrice: 0,
      lastPrice: 0,
      high: 0,
      low: 0,
      average: 0,
      change: 0,
      changePercent: 0,
      startedAt: null,
      endedAt: null
    };
  }
  const first = clean[0];
  const last = clean[clean.length - 1];
  const prices = clean.map((point) => finiteNumber(point.price)).filter((value) => value > 0);
  const high = Math.max(...prices);
  const low = Math.min(...prices);
  const average = prices.reduce((sum, value) => sum + value, 0) / Math.max(1, prices.length);
  const change = finiteNumber(last.price) - finiteNumber(first.price);
  const changePercent = first.price ? (change / first.price) * 100 : 0;
  return {
    points: clean.length,
    firstPrice: Number(finiteNumber(first.price).toFixed(2)),
    lastPrice: Number(finiteNumber(last.price).toFixed(2)),
    high: Number(high.toFixed(2)),
    low: Number(low.toFixed(2)),
    average: Number(average.toFixed(2)),
    change: Number(change.toFixed(2)),
    changePercent: Number(changePercent.toFixed(2)),
    startedAt: first.createdAt || null,
    endedAt: last.createdAt || null
  };
}


function openHoursActivityTrend(history = [], options = {}) {
  const days = clamp(Number(options.days || 7), 2, 30);
  const clean = cleanHistory(history, { limit: 0 });
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const groups = new Map();

  for (const point of clean) {
    const createdMs = new Date(point.createdAt || 0).getTime();
    if (!Number.isFinite(createdMs) || createdMs < cutoff) continue;
    const date = new Date(createdMs);
    const market = getMarketStatus(date);
    if (!market.open) continue;

    const metrics = point.metrics || {};
    const key = market.localDate || new Date(createdMs).toISOString().slice(0, 10);
    if (!groups.has(key)) {
      groups.set(key, {
        date: key,
        samples: 0,
        firstSampleAt: point.createdAt || null,
        lastSampleAt: point.createdAt || null,
        sumActivityScore: 0,
        sumActivityPoints: 0,
        sumOnlineUsers: 0,
        sumMessagesPerHour: 0,
        sumGlobalChatsPerHour: 0,
        sumPrivateMessagesPerHour: 0,
        minPrice: Infinity,
        maxPrice: 0,
        firstPrice: null,
        lastPrice: null
      });
    }

    const row = groups.get(key);
    const globalChats = finiteNumber(metrics.globalChatsPerHour ?? metrics.postsPerHour);
    const activityScore = finiteNumber(metrics.activityScore);
    const activityPoints = finiteNumber(metrics.activityPoints, activityScore * ACTIVITY_SCORE_POINTS_MULTIPLIER);
    const price = finiteNumber(point.price);

    row.samples += 1;
    row.lastSampleAt = point.createdAt || row.lastSampleAt;
    row.sumActivityScore += activityScore;
    row.sumActivityPoints += activityPoints;
    row.sumOnlineUsers += finiteNumber(metrics.onlineUsers);
    row.sumMessagesPerHour += finiteNumber(metrics.messagesPerHour);
    row.sumGlobalChatsPerHour += globalChats;
    row.sumPrivateMessagesPerHour += finiteNumber(metrics.privateMessagesPerHour);
    if (price > 0) {
      row.minPrice = Math.min(row.minPrice, price);
      row.maxPrice = Math.max(row.maxPrice, price);
      if (row.firstPrice === null) row.firstPrice = price;
      row.lastPrice = price;
    }
  }

  const daysList = Array.from(groups.values())
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .map((row) => {
      const samples = Math.max(1, row.samples);
      const priceChange = row.firstPrice !== null && row.lastPrice !== null ? row.lastPrice - row.firstPrice : 0;
      const priceChangePercent = row.firstPrice ? (priceChange / row.firstPrice) * 100 : 0;
      return {
        date: row.date,
        samples: row.samples,
        firstSampleAt: row.firstSampleAt,
        lastSampleAt: row.lastSampleAt,
        averageActivityScore: Number((row.sumActivityScore / samples).toFixed(3)),
        averageActivityPoints: Number((row.sumActivityPoints / samples).toFixed(0)),
        averageOnlineUsers: Number((row.sumOnlineUsers / samples).toFixed(2)),
        averageMessagesPerHour: Number((row.sumMessagesPerHour / samples).toFixed(2)),
        averageGlobalChatsPerHour: Number((row.sumGlobalChatsPerHour / samples).toFixed(2)),
        averagePrivateMessagesPerHour: Number((row.sumPrivateMessagesPerHour / samples).toFixed(2)),
        minPrice: row.minPrice === Infinity ? 0 : Number(row.minPrice.toFixed(2)),
        maxPrice: Number(row.maxPrice.toFixed(2)),
        priceChange: Number(priceChange.toFixed(2)),
        priceChangePercent: Number(priceChangePercent.toFixed(2))
      };
    });

  const latest = daysList[daysList.length - 1] || null;
  const previousDays = latest ? daysList.slice(0, -1) : [];
  const previousAverage = previousDays.length
    ? previousDays.reduce((sum, day) => sum + finiteNumber(day.averageActivityScore), 0) / previousDays.length
    : 0;
  const latestAverage = latest ? finiteNumber(latest.averageActivityScore) : 0;
  const change = latest && previousDays.length ? latestAverage - previousAverage : 0;
  const changePercent = previousAverage ? (change / previousAverage) * 100 : 0;
  const direction = !latest || !previousDays.length || Math.abs(changePercent) < 3
    ? 'flat'
    : changePercent > 0 ? 'up' : 'down';

  const headline = !latest
    ? 'Not enough open-hours history yet.'
    : !previousDays.length
      ? `Today’s open-hours average activity is ${latestAverage.toFixed(3)}. More past-day data is needed for a trend.`
      : direction === 'up'
        ? `TSN looks more popular during open hours: activity is up ${changePercent.toFixed(1)}% versus recent open-day averages.`
        : direction === 'down'
          ? `TSN looks less popular during open hours: activity is down ${Math.abs(changePercent).toFixed(1)}% versus recent open-day averages.`
          : `TSN popularity is mostly stable during open hours: activity changed ${changePercent >= 0 ? '+' : ''}${changePercent.toFixed(1)}%.`;

  return {
    ok: true,
    timezone: MARKET_TIMEZONE,
    generatedAt: new Date().toISOString(),
    daysRequested: days,
    openWindows: MARKET_WINDOWS.map((window) => ({ ...window })),
    market: getMarketStatus(),
    latestDay: latest,
    previousOpenDaysAverage: previousDays.length ? Number(previousAverage.toFixed(3)) : 0,
    latestVsPrevious: {
      change: Number(change.toFixed(3)),
      changePercent: Number(changePercent.toFixed(2)),
      direction
    },
    headline,
    days: daysList.slice(-days)
  };
}

function makePriceExplanation(stock = {}, history = []) {
  const metrics = stock.metrics || {};
  const deltas = metrics.metricDeltas || {};
  const market = stock.market || getMarketStatus();
  const reasons = [];
  const source = stock.source || 'live';
  const trend = stock.trend || 'flat';
  const change = finiteNumber(stock.change);
  const changePercent = finiteNumber(stock.changePercent);

  if (source === 'last-known') {
    reasons.push('Normal TSN could not be reached, so TSN-S is showing the latest saved price point.');
  }
  if (market && market.state === 'closed') {
    reasons.push(`TSN-S market status is closed until ${market.nextChangeAt || 'the next open window'} (${market.timezone || MARKET_TIMEZONE}).`);
  } else if (market && market.state === 'open') {
    reasons.push(`TSN-S market status is open until ${market.activeWindow?.end || market.nextChangeAt || 'the next close window'} (${market.timezone || MARKET_TIMEZONE}).`);
  }

  const onlineDelta = finiteNumber(deltas.onlineDelta);
  const messageDelta = finiteNumber(deltas.messageDelta);
  const postDelta = finiteNumber(deltas.postDelta);
  const activityDelta = finiteNumber(deltas.activityDelta);

  if (Math.abs(onlineDelta) >= 1) {
    reasons.push(`${onlineDelta > 0 ? 'More' : 'Fewer'} users are active compared with the previous snapshot (${onlineDelta > 0 ? '+' : ''}${Number(onlineDelta.toFixed(2))}).`);
  }
  if (Math.abs(messageDelta) >= Math.max(0.05, METRIC_MESSAGE_EPSILON)) {
    reasons.push(`Messages/hour ${messageDelta > 0 ? 'increased' : 'decreased'} by ${messageDelta > 0 ? '+' : ''}${Number(messageDelta.toFixed(2))}.`);
  }
  if (Math.abs(postDelta) >= Math.max(0.05, METRIC_POST_EPSILON)) {
    reasons.push(`Global chats/hour ${postDelta > 0 ? 'increased' : 'decreased'} by ${postDelta > 0 ? '+' : ''}${Number(postDelta.toFixed(2))}.`);
  }
  if (Math.abs(activityDelta) >= Math.max(0.01, METRIC_ACTIVITY_EPSILON)) {
    reasons.push(`Activity score ${activityDelta > 0 ? 'rose' : 'fell'} by ${activityDelta > 0 ? '+' : ''}${Number(activityDelta.toFixed(3))}.`);
  }

  const antiSpam = metrics.antiSpam || {};
  if (antiSpam.enabled && antiSpam.spamDetected) {
    reasons.push(`Spam filtering ignored ${Number(antiSpam.spamIgnored || 0).toFixed(0)} spam-like activity events before price calculation.`);
  }
  if (metrics.heldBecauseMetricsUnchanged) {
    reasons.push('Activity did not materially change since the last snapshot, so the price was held flat.');
  }
  if (!reasons.length) {
    reasons.push('No major activity change was detected. The price is mostly stable.');
  }

  const headline = trend === 'up'
    ? `Price is up ${change >= 0 ? '+' : ''}${Number(change.toFixed(2))} (${changePercent >= 0 ? '+' : ''}${Number(changePercent.toFixed(2))}%).`
    : trend === 'down'
      ? `Price is down ${Number(change.toFixed(2))} (${Number(changePercent.toFixed(2))}%).`
      : 'Price is flat because activity is stable.';

  return {
    headline,
    reasons: reasons.slice(0, 6),
    trend,
    generatedAt: new Date().toISOString()
  };
}

function makeSystemAlerts(stock = {}, history = [], persistence = {}) {
  const alerts = [];
  const metrics = stock.metrics || {};
  const antiSpam = metrics.antiSpam || {};
  const market = stock.market || getMarketStatus();
  const updatedMs = new Date(stock.updatedAt || 0).getTime();
  const ageSeconds = Number.isFinite(updatedMs) ? Math.round((Date.now() - updatedMs) / 1000) : null;

  if (stock.source === 'last-known') {
    alerts.push({ type: 'danger', title: 'Normal TSN is unreachable', message: 'TSN-S is showing the latest saved datapoint until the normal TSN source responds again.' });
  }
  if (ageSeconds !== null && ageSeconds > 180) {
    alerts.push({ type: 'warning', title: 'Source data is stale', message: `Latest price data is about ${ageSeconds}s old.` });
  }
  if (!PERSISTENCE_ENABLED || persistence?.enabled === false) {
    alerts.push({ type: 'warning', title: 'MongoDB history is not persistent', message: 'Set MONGODB_URI so price history survives Render restarts.' });
  }
  if (market?.state === 'closed') {
    alerts.push({ type: 'info', title: 'Market closed', message: market.message || 'TSN-S is currently closed.' });
  }
  if (antiSpam.enabled && antiSpam.spamDetected) {
    alerts.push({ type: antiSpam.singleUserSpamSuppressed ? 'warning' : 'info', title: 'Spam filtering active', message: `Ignored ${Number(antiSpam.spamIgnored || 0).toFixed(0)} spam-like events in the current activity window.` });
  }
  if (history.length < 2) {
    alerts.push({ type: 'info', title: 'Limited graph history', message: 'TSN-S needs more saved snapshots before long-range graphs become useful.' });
  }
  if (!alerts.length) {
    alerts.push({ type: 'success', title: 'Systems normal', message: 'TSN source, dashboard data, and graph history look healthy.' });
  }
  return alerts;
}

function buildReportPayload(stockPayload, history, range = 'today') {
  const stock = stockPayload?.stock || {};
  const summary = summarizeHistory(history);
  const explanation = makePriceExplanation(stock, history);
  const alerts = makeSystemAlerts(stock, history, stock.persistence || {});
  const metrics = stock.metrics || {};
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    service: 'TSN-S CEO Dashboard',
    access: { loginRequired: true, allowedUsername: TSN_STOCK_ALLOWED_USERNAME },
    range,
    stock: {
      symbol: 'TSN',
      price: finiteNumber(stock.price),
      change: finiteNumber(stock.change),
      changePercent: finiteNumber(stock.changePercent),
      trend: stock.trend || 'flat',
      updatedAt: stock.updatedAt || null,
      source: stock.source || 'unknown',
      market: stock.market || getMarketStatus()
    },
    metrics: {
      onlineUsers: finiteNumber(metrics.onlineUsers),
      messagesPerHour: finiteNumber(metrics.messagesPerHour),
      globalChatsPerHour: finiteNumber(metrics.globalChatsPerHour ?? metrics.postsPerHour),
      privateMessagesPerHour: finiteNumber(metrics.privateMessagesPerHour),
      activityScore: finiteNumber(metrics.activityScore),
      activityPoints: finiteNumber(metrics.activityPoints),
      rawMessagesPerHour: finiteNumber(metrics.rawMessagesPerHour),
      rawGlobalChatsPerHour: finiteNumber(metrics.rawGlobalChatsPerHour ?? metrics.rawPostsPerHour)
    },
    historySummary: summary,
    openHoursActivityTrend: openHoursActivityTrend(history, { days: range === '30d' ? 30 : range === '7d' ? 7 : 7 }),
    explanation,
    alerts,
    history: cleanHistory(history, { limit: HISTORY_API_MAX_POINTS }).map((point) => ({
      price: point.price,
      change: point.change,
      changePercent: point.changePercent,
      trend: point.trend,
      metrics: point.metrics,
      createdAt: point.createdAt
    })),
    notes: [
      'TSN-S is read-only.',
      'Wallet and trading are disabled.',
      'Only the configured CEO username can access this report.'
    ]
  };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const urlPath = url.pathname;

  if (urlPath === '/healthz') {
    return sendJson(res, 200, {
      ok: true,
      service: 'tsn-stock',
      resetEnabled: RESET_ENABLED,
      resetRequiresKey: Boolean(RESET_KEY),
      targetBasePrice: TARGET_BASE_PRICE,
      autoRebaseEnabled: AUTO_REBASE_ENABLED,
      antiSpam: { enabled: ANTI_SPAM_ENABLED, messageCapPerUserPerHour: ANTI_SPAM_MESSAGE_CAP_PER_USER_PER_HOUR, postCapPerUserPerHour: ANTI_SPAM_POST_CAP_PER_USER_PER_HOUR, duplicateWindowMs: ANTI_SPAM_DUPLICATE_WINDOW_MS },
      persistence: PERSISTENCE_ENABLED ? 'mongodb-uri' : 'memory',
      marketStatus: getMarketStatus(),
      access: { loginRequired: true, allowedUsername: TSN_STOCK_ALLOWED_USERNAME },
      commerce: { walletEnabled: false, tradingEnabled: false },
      backgroundUpdater: getBackgroundUpdaterStatus(),
      cronTick: { endpoint: '/api/cron/tick', secretConfigured: Boolean(CRON_TICK_SECRET), minIntervalMs: CRON_TICK_MIN_INTERVAL_MS },
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


  if (urlPath === '/api/cron/tick') {
    if (req.method !== 'GET' && req.method !== 'POST') {
      return sendJson(res, 405, { ok: false, error: 'Use GET or POST for cron tick.' });
    }
    if (!cronSecretAllowed(req, url)) {
      return sendJson(res, 401, { ok: false, error: 'Cron secret is missing or wrong.' });
    }
    const nowMs = Date.now();
    if (lastCronTickAt && nowMs - lastCronTickAt < CRON_TICK_MIN_INTERVAL_MS) {
      return sendJson(res, 429, {
        ok: false,
        error: `Cron tick is too soon. Wait at least ${Math.ceil((CRON_TICK_MIN_INTERVAL_MS - (nowMs - lastCronTickAt)) / 1000)}s.`,
        background: getBackgroundUpdaterStatus()
      });
    }
    lastCronTickAt = nowMs;
    runBackgroundSnapshot('cron')
      .then((result) => sendJson(res, 200, {
        ...result,
        cron: {
          ok: true,
          secretConfigured: Boolean(CRON_TICK_SECRET),
          note: CRON_TICK_SECRET ? 'Cron tick accepted with secret protection.' : 'Cron tick accepted. For public deployments, set TSN_STOCK_CRON_SECRET.'
        }
      }))
      .catch((error) => sendJson(res, error.statusCode || 500, {
        ok: false,
        error: error.message,
        background: getBackgroundUpdaterStatus()
      }));
    return;
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
    getTsnSession(req).then(() => Promise.allSettled([
      TSN_API_BASE_URL
        ? fetchOriginalStockFromApi()
        : Promise.reject(new Error('TSN_API_BASE_URL is missing')),
      EXPLICIT_ORIGINAL_TSN_MONGODB_URI && ORIGINAL_TSN_MONGODB_URI && MongoClient
        ? fetchOriginalStockFromMongo()
        : Promise.reject(new Error('TSN_ORIGINAL_MONGODB_URI fallback is not configured. Optional if the API test works.'))
    ])).then(([apiResult, mongoResult]) => sendJson(res, 200, {
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
    })).catch((error) => sendJson(res, error.statusCode || 500, { ok: false, error: error.message, accessDenied: Boolean(error.accessDenied) }));
    return;
  }

  if (urlPath === '/api/market-hours') {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'Use GET for market hours.' });
    getTsnSession(req)
      .then(() => sendJson(res, 200, { ok: true, market: getMarketStatus(), fictional: true }))
      .catch((error) => sendJson(res, error.statusCode || 401, { ok: false, error: error.message, accessDenied: Boolean(error.accessDenied) }));
    return;
  }

  if (urlPath === '/api/stock') {
    getTsnSession(req)
      .then(() => getStockPayload({ force: url.searchParams.get('force') === '1' }))
      .then((payload) => sendJson(res, 200, payload))
      .catch((error) => sendJson(res, error.statusCode || 500, {
        ok: false,
        error: error.message,
        needs: !TSN_API_BASE_URL && !EXPLICIT_ORIGINAL_TSN_MONGODB_URI ? ['TSN_API_BASE_URL or TSN_ORIGINAL_MONGODB_URI'] : [],
        sourceTestUrl: '/api/source-test'
      }));
    return;
  }


  if (urlPath === '/api/wallet' || urlPath === '/api/wallet/tick' || urlPath === '/api/wallet/test') {
    return disabledCommerceResponse(res);
  }

  if (urlPath === '/api/trade' || urlPath === '/api/trade/test') {
    return disabledCommerceResponse(res);
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
    getTsnSession(req)
      .then(() => loadHistory({ sinceMs: sinceMs || 0, limit: queryLimit }))
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
      .catch((error) => sendJson(res, error.statusCode || 500, { ok: false, error: error.message, accessDenied: Boolean(error.accessDenied) }));
    return;
  }


  if (urlPath === '/api/activity-trend') {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'Use GET for activity trend.' });
    const days = clamp(Number(url.searchParams.get('days') || 7), 2, 30);
    const sinceMs = days * 24 * 60 * 60 * 1000;
    const estimatedRangePoints = Math.ceil(sinceMs / Math.max(1000, REFRESH_INTERVAL_MS)) + 240;
    const queryLimit = Math.min(Math.max(estimatedRangePoints, HISTORY_API_MAX_POINTS), MAX_HISTORY_POINTS);
    getTsnSession(req)
      .then(() => loadHistory({ sinceMs, limit: queryLimit }).catch(() => cleanHistory(memoryHistory)))
      .then((history) => sendJson(res, 200, openHoursActivityTrend(history, { days })))
      .catch((error) => sendJson(res, error.statusCode || 500, { ok: false, error: error.message, accessDenied: Boolean(error.accessDenied) }));
    return;
  }


  if (urlPath === '/api/report') {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'Use GET for report export.' });
    const range = url.searchParams.get('range') || 'today';
    const sinceMs = historyRangeToMs(range);
    const estimatedRangePoints = sinceMs
      ? Math.ceil(sinceMs / Math.max(1000, REFRESH_INTERVAL_MS)) + 120
      : MAX_HISTORY_POINTS;
    const queryLimit = sinceMs
      ? Math.min(Math.max(estimatedRangePoints, HISTORY_API_MAX_POINTS), MAX_HISTORY_POINTS)
      : MAX_HISTORY_POINTS;
    getTsnSession(req)
      .then(() => getStockPayload({ force: url.searchParams.get('force') === '1' }))
      .then((payload) => Promise.all([
        Promise.resolve(payload),
        loadHistory({ sinceMs: sinceMs || 0, limit: queryLimit }).catch(() => cleanHistory(memoryHistory))
      ]))
      .then(([payload, history]) => sendJson(res, 200, buildReportPayload(payload, history, range)))
      .catch((error) => sendJson(res, error.statusCode || 500, { ok: false, error: error.message, accessDenied: Boolean(error.accessDenied) }));
    return;
  }

  if (urlPath === '/api/reset') {
    if (!RESET_ENABLED) {
      return sendJson(res, 410, { ok: false, error: 'Reset is disabled in this TSN-S version.' });
    }
    if (req.method !== 'POST') {
      return sendJson(res, 405, { ok: false, error: 'Use POST to reset TSN Stock.' });
    }
    if (!resetAllowed(req, url)) {
      return sendJson(res, 401, { ok: false, error: 'Reset key is missing or wrong.' });
    }
    resetStockHistory()
      .then((payload) => sendJson(res, 200, { ...payload, reset: true }))
      .catch((error) => sendJson(res, error.statusCode || 500, { ok: false, error: error.message, accessDenied: Boolean(error.accessDenied) }));
    return;
  }

  if (urlPath === '/config.js') {
    return send(
      res,
      200,
      `window.TSN_STOCK_CONFIG = ${JSON.stringify({
        refreshIntervalMs: REFRESH_INTERVAL_MS,
        persistenceEnabled: PERSISTENCE_ENABLED,
        resetEnabled: RESET_ENABLED,
        resetRequiresKey: Boolean(RESET_KEY),
        targetBasePrice: TARGET_BASE_PRICE,
        autoRebaseEnabled: AUTO_REBASE_ENABLED,
        loginRequired: true,
        allowedUsername: TSN_STOCK_ALLOWED_USERNAME,
        walletEnabled: false,
        tradingEnabled: false,
        reportEnabled: true,
        activityTrendEnabled: true,
        backgroundUpdater: getBackgroundUpdaterStatus(),
        backgroundUpdaterEnabled: BACKGROUND_UPDATER_ENABLED,
        backgroundUpdateIntervalMs: BACKGROUND_UPDATE_INTERVAL_MS,
        cronTickEndpoint: '/api/cron/tick',
        historyApiMaxPoints: HISTORY_API_MAX_POINTS,
        storedHistoryPoints: MAX_HISTORY_POINTS,
        stockPayloadHistoryPoints: STOCK_PAYLOAD_HISTORY_POINTS,
        chartRanges: ['10m', '30m', '1h', '6h', 'today', '1d', '7d', '30d', 'all'],
        marketHours: getMarketStatus(),
        antiSpam: { enabled: ANTI_SPAM_ENABLED, messageCapPerUserPerHour: ANTI_SPAM_MESSAGE_CAP_PER_USER_PER_HOUR, postCapPerUserPerHour: ANTI_SPAM_POST_CAP_PER_USER_PER_HOUR }
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
  startBackgroundUpdater();
  if (!PERSISTENCE_ENABLED) {
    console.warn('MongoDB persistence is not configured. Set MONGODB_URI, plus optional MONGODB_DATABASE and MONGODB_COLLECTION.');
  }
});
