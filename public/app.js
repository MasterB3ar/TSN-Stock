const config = window.TSN_STOCK_CONFIG || {};
const REFRESH_INTERVAL_MS = Number(config.refreshIntervalMs || 2_000);

const state = {
  stock: null,
  chart: {
    points: [],
    coords: [],
    area: null,
    hoverIndex: -1
  },
  timer: null,
  lastFetchFailed: false,
  isFetching: false,
  market: config.marketHours || null,
  token: localStorage.getItem('tsnStockCeoToken') || '',
  user: null,
  chartRange: localStorage.getItem('tsnStockChartRange') || '10m',
  chartHistory: [],
  chartHistoryFetchedAt: 0,
  chartHistoryTimer: null
};

const $ = (selector) => document.querySelector(selector);


function authHeaders(extra = {}) {
  return state.token ? { ...extra, Authorization: `Bearer ${state.token}` } : { ...extra };
}

function setAuthStatus(message = '') {
  const authStatus = $('#authStatus');
  if (authStatus) authStatus.textContent = message;
}

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 24);
}

function isCeoUser(user) {
  return normalizeUsername(user?.username || user?.name || '') === normalizeUsername(config.allowedUsername || 'ceo');
}

function showAccessDenied() {
  document.body.classList.add('access-denied');
  $('#deniedScreen')?.classList.remove('hidden');
  $('#dashboardShell')?.classList.add('hidden');
  $('#accountCard')?.classList.add('hidden');
  setAuthStatus('access denied');
}

function hideAccessDenied() {
  document.body.classList.remove('access-denied');
  $('#deniedScreen')?.classList.add('hidden');
}

function handleAuthError(error) {
  if (String(error?.message || '').toLowerCase().includes('access denied')) {
    showAccessDenied();
    return;
  }
  setAuthStatus(error?.message || 'Login fejlede.');
}

function renderAuth() {
  const loggedIn = Boolean(state.token && state.user && isCeoUser(state.user));
  document.body.classList.toggle('is-logged-in', loggedIn);
  $('#loginGate')?.classList.toggle('logged-in', loggedIn);
  $('#authCard')?.classList.toggle('hidden', loggedIn);
  $('#accountCard')?.classList.toggle('hidden', !loggedIn);
  $('#dashboardShell')?.classList.toggle('hidden', !loggedIn);
  if (loggedIn) hideAccessDenied();
  if (state.market) renderMarketStatus(state.market);

  const name = state.user?.name || state.user?.username || 'CEO';
  const username = state.user?.username ? `@${state.user.username}` : '@ceo';
  const accountName = $('#accountName');
  const accountUser = $('#accountUser');
  if (accountName) accountName.textContent = name;
  if (accountUser) accountUser.textContent = `${username} · read-only dashboard`;
}

async function loginWithTsn(event) {
  event?.preventDefault?.();
  const username = $('#loginUsername')?.value?.trim() || '';
  const password = $('#loginPassword')?.value || '';
  if (!username || !password) {
    setAuthStatus('Skriv brugernavn og adgangskode.');
    return;
  }
  setAuthStatus('Logger ind via original TSN...');
  const response = await fetchWithTimeout('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
    cache: 'no-store'
  }, 35000);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || 'Login fejlede.');
  state.token = data.token;
  state.user = {
    id: data.user?.id || data.user?._id || data.user?.userId || data.user?.username || username,
    username: data.user?.username || username,
    name: data.user?.name || data.user?.username || username,
    role: data.user?.role || 'user',
    isAdmin: Boolean(data.user?.isAdmin || data.user?.role === 'admin')
  };
  if (!isCeoUser(state.user)) {
    state.token = '';
    state.user = null;
    localStorage.removeItem('tsnStockCeoToken');
    showAccessDenied();
    return;
  }
  localStorage.setItem('tsnStockCeoToken', state.token);
  setAuthStatus('Logget ind som CEO.');
  renderAuth();
  await loadDashboardNow();
  startAutoRefresh();
  clearInterval(state.chartHistoryTimer);
  state.chartHistoryTimer = setInterval(() => fetchChartHistory().catch((error) => console.error(error)), 20_000);
}

function logout() {
  state.token = '';
  state.user = null;
  localStorage.removeItem('tsnStockCeoToken');
  clearInterval(state.timer);
  clearInterval(state.chartHistoryTimer);
  hideAccessDenied();
  renderAuth();
  setAuthStatus('Du er logget ud.');
  setStatus('Log ind kræves', '');
}

async function checkSession() {
  if (!state.token) {
    renderAuth();
    return false;
  }
  try {
    const response = await fetchWithTimeout('/api/auth/me', {
      headers: authHeaders(),
      cache: 'no-store'
    }, 12000);
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.error || 'Session udløbet.');
    state.user = {
      id: data.user?.id || data.user?._id || data.user?.userId || data.user?.username || 'ceo',
      username: data.user?.username || data.user?.name || 'ceo',
      name: data.user?.name || data.user?.username || 'CEO',
      role: data.user?.role || 'user',
      isAdmin: Boolean(data.user?.isAdmin || data.user?.role === 'admin')
    };
    renderAuth();
    return true;
  } catch (error) {
    console.warn(error);
    state.token = '';
    state.user = null;
    localStorage.removeItem('tsnStockCeoToken');
    if (String(error.message || '').toLowerCase().includes('access denied')) {
      showAccessDenied();
    } else {
      renderAuth();
      setAuthStatus('Sessionen udløb. Log ind igen.');
    }
    return false;
  }
}

function formatNumber(value, decimals = 2) {
  return Number(value || 0).toLocaleString('da-DK', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
}

function formatSigned(value) {
  const number = Number(value) || 0;
  const sign = number > 0 ? '+' : number < 0 ? '-' : '';
  return `${sign}${formatNumber(Math.abs(number), 2)}`;
}

function formatTime(iso, includeSeconds = true) {
  if (!iso) return 'Live';
  return new Intl.DateTimeFormat('da-DK', {
    hour: '2-digit',
    minute: '2-digit',
    second: includeSeconds ? '2-digit' : undefined
  }).format(new Date(iso));
}

function formatDateTime(iso) {
  if (!iso) return 'Live';
  return new Intl.DateTimeFormat('da-DK', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(new Date(iso));
}

function setStatus(text, mode = '') {
  const el = $('#connectionStatus');
  if (!el) return;
  el.textContent = text;
  el.className = `status-pill ${mode}`.trim();
}

function formatMarketCountdown(seconds) {
  const clean = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(clean / 3600);
  const minutes = Math.floor((clean % 3600) / 60);
  if (hours > 0) return `${hours}t ${minutes}m`;
  return `${Math.max(1, minutes)}m`;
}

function renderMarketStatus(market) {
  if (!market) return;
  state.market = market;
  const open = Boolean(market.open);
  const pill = $('#marketStatus');
  if (pill) {
    pill.textContent = open ? `TSN-S åben · lukker ${market.nextChangeAt}` : `TSN-S lukket · åbner ${market.nextChangeAt}`;
    pill.className = `status-pill market-pill ${open ? 'connected' : 'error'}`;
  }
  const info = $('#marketHoursInfo');
  if (info) {
    const schedule = Array.isArray(market.schedule)
      ? market.schedule.map((item) => `${item.start}-${item.end}`).join(' · ')
      : '08:10-09:30 · 09:50-11:15 · 12:00-13:30';
    info.textContent = open
      ? `Markedet er åbent. Det lukker kl. ${market.nextChangeAt}. Åbningstider: ${schedule}.`
      : `Markedet er lukket. Det åbner kl. ${market.nextChangeAt} om ca. ${formatMarketCountdown(market.secondsUntilNextChange)}. Åbningstider: ${schedule}.`;
    info.className = `small info-status ${open ? 'market-open-text' : 'market-closed-text'}`;
  }
  document.body.classList.toggle('market-closed', !open);
  document.body.classList.toggle('market-open', open);
}

async function fetchMarketHours() {
  if (!state.token) return;
  const response = await fetchWithTimeout('/api/market-hours', { headers: authHeaders(), cache: 'no-store' }, 12000);
  const data = await response.json().catch(() => ({}));
  if (response.ok && data.ok) renderMarketStatus(data.market);
}

function rangeToMs(range) {
  const ranges = {
    '10m': 10 * 60 * 1000,
    '30m': 30 * 60 * 1000,
    '1h': 60 * 60 * 1000,
    '6h': 6 * 60 * 60 * 1000,
    '1d': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000
  };
  return range === 'all' ? null : (ranges[range] || ranges['10m']);
}

function filterHistoryByRange(points, range) {
  const ms = rangeToMs(range);
  const clean = (points || [])
    .map((point) => ({
      price: Number(point.price) || 0,
      createdAt: point.createdAt || point.updatedAt || new Date().toISOString()
    }))
    .filter((point) => Number.isFinite(point.price) && point.price > 0)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  if (!ms) return clean;
  const cutoff = Date.now() - ms;
  return clean.filter((point) => new Date(point.createdAt).getTime() >= cutoff);
}

function normalizeHistory(stock) {
  const raw = Array.isArray(state.chartHistory) && state.chartHistory.length
    ? state.chartHistory
    : (Array.isArray(stock?.history) && stock.history.length
      ? stock.history
      : [{ price: stock?.price, createdAt: stock?.updatedAt }]);

  const clean = filterHistoryByRange(raw, state.chartRange);

  const current = {
    price: Number(stock?.price) || 0,
    createdAt: stock?.updatedAt || new Date().toISOString()
  };

  const last = clean[clean.length - 1];
  const currentTime = new Date(current.createdAt).getTime();
  const rangeMs = rangeToMs(state.chartRange);
  const insideSelectedRange = !rangeMs || currentTime >= Date.now() - rangeMs;
  if (insideSelectedRange && (!last || Math.abs(last.price - current.price) > 0.0001 || last.createdAt !== current.createdAt)) {
    clean.push(current);
  }

  return clean.length ? clean : [current];
}

function updateRangeButtons() {
  document.querySelectorAll('[data-chart-range]').forEach((button) => {
    button.classList.toggle('active', button.dataset.chartRange === state.chartRange);
  });
  const label = $('#chartRangeLabel');
  if (label) {
    const names = { '10m': '10 minutter', '30m': '30 minutter', '1h': '1 time', '6h': '6 timer', '1d': '1 dag', '7d': '7 dage', all: 'alt' };
    label.textContent = `Viser: ${names[state.chartRange] || state.chartRange}`;
  }
}

function drawChart(stock) {
  const canvas = $('#stockChart');
  if (!canvas || !stock) return;

  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(360, Math.floor(rect.width * dpr));
  const height = Math.max(260, Math.floor(rect.height * dpr));

  canvas.width = width;
  canvas.height = height;
  ctx.clearRect(0, 0, width, height);

  const points = normalizeHistory(stock);
  const prices = points.map((p) => p.price);
  const rawMin = Math.min(...prices);
  const rawMax = Math.max(...prices);
  const spread = Math.max(0.01, rawMax - rawMin);
  const min = rawMin - spread * 0.08;
  const max = rawMax + spread * 0.08;
  const range = Math.max(0.01, max - min);

  const padLeft = 58 * dpr;
  const padRight = 18 * dpr;
  const padTop = 26 * dpr;
  const padBottom = 36 * dpr;
  const chartW = width - padLeft - padRight;
  const chartH = height - padTop - padBottom;

  const area = {
    left: padLeft,
    right: width - padRight,
    top: padTop,
    bottom: height - padBottom,
    width: chartW,
    height: chartH,
    dpr
  };

  const coords = points.map((point, index) => {
    const x = padLeft + (points.length === 1 ? chartW : chartW * (index / (points.length - 1)));
    const y = padTop + chartH - ((point.price - min) / range) * chartH;
    return { ...point, x, y };
  });

  state.chart = { points, coords, area, hoverIndex: state.chart.hoverIndex };

  // Background panel like a clean broker chart.
  ctx.fillStyle = 'rgba(255,255,255,.018)';
  ctx.fillRect(area.left, area.top, area.width, area.height);

  // Horizontal grid + price axis.
  ctx.lineWidth = 1 * dpr;
  ctx.font = `${11 * dpr}px Inter, system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 5; i += 1) {
    const y = area.top + area.height * (i / 5);
    const labelValue = max - range * (i / 5);

    ctx.strokeStyle = i === 5 ? 'rgba(255,255,255,.16)' : 'rgba(255,255,255,.075)';
    ctx.beginPath();
    ctx.moveTo(area.left, y);
    ctx.lineTo(area.right, y);
    ctx.stroke();

    ctx.fillStyle = 'rgba(245,247,251,.58)';
    ctx.textAlign = 'right';
    ctx.fillText(formatNumber(labelValue), area.left - 10 * dpr, y);
  }

  // Vertical time guides.
  ctx.textBaseline = 'top';
  for (let i = 0; i <= 4; i += 1) {
    const x = area.left + area.width * (i / 4);
    const point = points[Math.round((points.length - 1) * (i / 4))];

    ctx.strokeStyle = 'rgba(255,255,255,.045)';
    ctx.beginPath();
    ctx.moveTo(x, area.top);
    ctx.lineTo(x, area.bottom);
    ctx.stroke();

    if (point?.createdAt) {
      ctx.fillStyle = 'rgba(245,247,251,.48)';
      ctx.textAlign = i === 0 ? 'left' : i === 4 ? 'right' : 'center';
      ctx.fillText(formatTime(point.createdAt, false), x, area.bottom + 11 * dpr);
    }
  }

  const firstPrice = coords[0]?.price ?? 0;
  const lastPrice = coords[coords.length - 1]?.price ?? firstPrice;
  const isDown = lastPrice < firstPrice;
  const lineColor = isDown ? '#ff5c7a' : '#17b978';

  if (coords.length > 1) {
    const fillGradient = ctx.createLinearGradient(0, area.top, 0, area.bottom);
    fillGradient.addColorStop(0, isDown ? 'rgba(255,92,122,.22)' : 'rgba(23,185,120,.22)');
    fillGradient.addColorStop(1, 'rgba(255,255,255,0)');

    ctx.beginPath();
    coords.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.lineTo(coords[coords.length - 1].x, area.bottom);
    ctx.lineTo(coords[0].x, area.bottom);
    ctx.closePath();
    ctx.fillStyle = fillGradient;
    ctx.fill();
  }

  // Smooth-ish polyline.
  ctx.beginPath();
  coords.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 2.4 * dpr;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();

  // Last price dotted guide and pill.
  const last = coords[coords.length - 1];
  if (last) {
    ctx.setLineDash([4 * dpr, 5 * dpr]);
    ctx.strokeStyle = isDown ? 'rgba(255,92,122,.45)' : 'rgba(23,185,120,.45)';
    ctx.beginPath();
    ctx.moveTo(area.left, last.y);
    ctx.lineTo(area.right, last.y);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.beginPath();
    ctx.arc(last.x, last.y, 4.5 * dpr, 0, Math.PI * 2);
    ctx.fillStyle = lineColor;
    ctx.fill();
    ctx.lineWidth = 2 * dpr;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
  }

  if (state.chart.hoverIndex >= 0 && coords[state.chart.hoverIndex]) {
    drawHover(ctx, coords[state.chart.hoverIndex], area, lineColor);
  }
}

function drawHover(ctx, point, area, lineColor) {
  const dpr = area.dpr;

  ctx.save();
  ctx.setLineDash([3 * dpr, 4 * dpr]);
  ctx.strokeStyle = 'rgba(245,247,251,.45)';
  ctx.lineWidth = 1 * dpr;
  ctx.beginPath();
  ctx.moveTo(point.x, area.top);
  ctx.lineTo(point.x, area.bottom);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(area.left, point.y);
  ctx.lineTo(area.right, point.y);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.beginPath();
  ctx.arc(point.x, point.y, 6 * dpr, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.lineWidth = 3 * dpr;
  ctx.strokeStyle = lineColor;
  ctx.stroke();
  ctx.restore();
}

function showTooltip(index, clientX, clientY) {
  const tooltip = $('#chartTooltip');
  const canvas = $('#stockChart');
  const point = state.chart.coords[index];
  if (!tooltip || !canvas || !point) return;

  tooltip.innerHTML = `
    <strong>${formatNumber(point.price)} TSN</strong>
    <span>${formatDateTime(point.createdAt)}</span>
  `;
  tooltip.classList.remove('hidden');

  const shell = $('.chart-shell');
  const shellRect = shell.getBoundingClientRect();
  const tipWidth = tooltip.offsetWidth || 160;
  const tipHeight = tooltip.offsetHeight || 58;
  const x = Math.min(Math.max(clientX - shellRect.left + 14, 8), shellRect.width - tipWidth - 8);
  const y = Math.min(Math.max(clientY - shellRect.top - tipHeight - 14, 8), shellRect.height - tipHeight - 8);

  tooltip.style.left = `${x}px`;
  tooltip.style.top = `${y}px`;
}

function hideTooltip() {
  const tooltip = $('#chartTooltip');
  if (tooltip) tooltip.classList.add('hidden');
  state.chart.hoverIndex = -1;
  if (state.stock) drawChart(state.stock);
}

function handleChartPointer(event) {
  const canvas = $('#stockChart');
  const { coords, area } = state.chart;
  if (!canvas || !coords.length || !area) return;

  const rect = canvas.getBoundingClientRect();
  const dpr = area.dpr;
  const x = (event.clientX - rect.left) * dpr;

  if (x < area.left || x > area.right) {
    hideTooltip();
    return;
  }

  let closestIndex = 0;
  let closestDistance = Infinity;
  coords.forEach((point, index) => {
    const distance = Math.abs(point.x - x);
    if (distance < closestDistance) {
      closestDistance = distance;
      closestIndex = index;
    }
  });

  state.chart.hoverIndex = closestIndex;
  drawChart(state.stock);
  showTooltip(closestIndex, event.clientX, event.clientY);
}


function renderStock(stock) {
  state.stock = stock;
  if (!stock) return;
  renderMarketStatus(stock.market);

  $('#stockPrice').textContent = formatNumber(stock.price);
  const change = $('#stockChange');
  const trend = stock.trend || 'flat';
  change.className = `change ${trend}`;
  change.textContent = `${formatSigned(stock.change)} · ${Number(stock.changePercent || 0) > 0 ? '+' : ''}${formatNumber(stock.changePercent)}%`;
  $('#updatedAt').textContent = `Opdateret ${formatTime(stock.updatedAt)}`;
  const metrics = stock.metrics || {};
  const antiSpam = metrics.antiSpam || {};
  const spamSuffix = antiSpam.enabled
    ? ` Spamfilter: ${formatNumber(antiSpam.effectiveMessagesPerHour ?? metrics.messagesPerHour ?? 0, 0)}/${formatNumber(antiSpam.rawMessagesPerHour ?? metrics.messagesPerHour ?? 0, 0)} beskeder og ${formatNumber(antiSpam.effectivePostsPerHour ?? metrics.globalChatsPerHour ?? metrics.postsPerHour ?? 0, 0)}/${formatNumber(antiSpam.rawPostsPerHour ?? metrics.rawGlobalChatsPerHour ?? metrics.postsPerHour ?? 0, 0)} global chats tæller.${antiSpam.singleUserSpamSuppressed ? ' Enkeltbruger-spam er ignoreret.' : ''}`
    : '';
  $('#stockDisclaimer').textContent = `${stock.disclaimer || 'Fiktiv TSN-aktivitetspris. Ikke en rigtig aktie.'}${spamSuffix}`;
  $('#refreshInfo').textContent = `Tjekker for ændringer hvert ${Math.max(1, Math.round(REFRESH_INTERVAL_MS / 1000))}. sekund og opdaterer ved selv små ændringer`;
  const persistenceInfo = $('#persistenceInfo');
  if (persistenceInfo) {
    const persistence = stock.persistence || {};
    persistenceInfo.textContent = persistence.enabled
      ? `Historik gemmes i MongoDB (${persistence.database || 'database'}.${persistence.collection || 'collection'})`
      : 'Historik gemmes kun midlertidigt, fordi MongoDB ikke er sat op endnu';
    persistenceInfo.className = `persistence-info ${persistence.enabled ? 'connected' : 'warning'}`;
  }

  $('#onlineUsers').textContent = metrics.onlineUsers ?? 0;
  $('#messagesHour').textContent = metrics.messagesPerHour ?? 0;
  $('#globalChatsHour').textContent = metrics.globalChatsPerHour ?? metrics.postsPerHour ?? 0;
  $('#messagesHour').title = antiSpam.enabled ? `Raw messages/hour: ${antiSpam.rawMessagesPerHour ?? metrics.messagesPerHour ?? 0}` : '';
  $('#globalChatsHour').title = antiSpam.enabled ? `Raw global chats/hour: ${antiSpam.rawPostsPerHour ?? metrics.rawGlobalChatsPerHour ?? metrics.postsPerHour ?? 0}` : '';
  drawChart(stock);
}


async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`Request timeout after ${Math.round(timeoutMs / 1000)}s. Render, MongoDB, or normal TSN was too slow to respond.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchChartHistory({ force = false } = {}) {
  const now = Date.now();
  if (!force && state.chartHistoryFetchedAt && now - state.chartHistoryFetchedAt < 20_000) return;
  const maxPoints = Number(config.historyApiMaxPoints || 1400);
  if (!state.token) return;
  const response = await fetchWithTimeout(`/api/history?range=${encodeURIComponent(state.chartRange)}&limit=${maxPoints}`, { headers: authHeaders(), cache: 'no-store' }, 12000);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || 'Kunne ikke hente grafhistorik');
  state.chartHistory = Array.isArray(data.history) ? data.history : [];
  state.chartHistoryFetchedAt = now;
  updateRangeButtons();
  if (state.stock) drawChart(state.stock);
}

async function fetchStock({ manual = false } = {}) {
  if (!state.token) return;
  if (state.isFetching) return;

  state.isFetching = true;
  if (manual) setStatus('Opdaterer...', '');

  try {
    const url = '/api/stock?force=1';
    const response = await fetchWithTimeout(url, { headers: authHeaders(), cache: 'no-store' }, 35000);
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      if (Array.isArray(data.needs) && data.needs.some((item) => String(item).includes('TSN_API_BASE_URL'))) {
        $('#setupHelp')?.classList.remove('hidden');
      }
      const testLink = data.sourceTestUrl ? ` Test forbindelsen på ${data.sourceTestUrl}.` : '';
      throw new Error((data.error || `TSN Stock API svarede ${response.status}`) + testLink);
    }
    renderStock(data.stock);
    fetchChartHistory({ force: manual }).catch((error) => console.error(error));
    const source = data.stock?.source === 'last-known' ? 'Seneste gemte data' : 'Live fra TSN';
    const persistent = data.stock?.persistence?.enabled ? ' + MongoDB' : '';
    setStatus(`${source}${persistent}`, data.stock?.source === 'last-known' ? '' : 'connected');
    state.lastFetchFailed = false;
  } finally {
    state.isFetching = false;
  }
}



async function testTsnSourceConnection() {
  const output = $('#sourceTestOutput');
  if (output) output.textContent = 'Tester forbindelse til normal TSN...';
  try {
    const response = await fetchWithTimeout('/api/source-test', { headers: authHeaders(), cache: 'no-store' }, 40000);
    const data = await response.json().catch(() => ({}));
    if (output) {
      const apiLine = data.api?.ok
        ? `API OK: ${data.api.url}`
        : `API fejl: ${data.api?.error || 'ikke konfigureret'}`;
      const mongoLine = data.mongodbFallback?.ok
        ? `Mongo fallback OK: ${data.mongodbFallback.database}.${data.mongodbFallback.collection}`
        : `Mongo fallback: ${data.mongodbFallback?.error || 'ikke konfigureret'}`;
      output.textContent = `${data.ok ? 'Forbindelse fundet.' : 'Ingen forbindelse endnu.'}
${apiLine}
${mongoLine}
${data.setupHint || ''}`;
    }
  } catch (error) {
    if (output) output.textContent = `Source-test fejlede: ${error.message}`;
  }
}


async function loadDashboardNow() {
  await fetchMarketHours().catch((error) => console.error(error));
  await fetchStock({ manual: true }).catch((error) => {
    console.error(error);
    setStatus('Kan ikke forbinde', 'error');
  });
  await fetchChartHistory({ force: true }).catch((error) => console.error(error));
}

function startAutoRefresh() {
  clearInterval(state.timer);
  if (!state.token) return;
  state.timer = setInterval(() => {
    fetchStock().catch((error) => {
      console.error(error);
      setStatus('Venter på TSN', '');
    });
  }, REFRESH_INTERVAL_MS);
}

$('#refreshButton')?.addEventListener('click', () => fetchStock({ manual: true }).catch((error) => {
  setStatus('Kunne ikke opdatere', 'error');
  console.error(error);
}));


document.querySelectorAll('[data-chart-range]').forEach((button) => {
  button.addEventListener('click', () => {
    state.chartRange = button.dataset.chartRange || '10m';
    localStorage.setItem('tsnStockChartRange', state.chartRange);
    state.chartHistoryFetchedAt = 0;
    updateRangeButtons();
    fetchChartHistory({ force: true }).catch((error) => console.error(error));
  });
});

$('#loginForm')?.addEventListener('submit', (event) => loginWithTsn(event).catch(handleAuthError));
$('#logoutButton')?.addEventListener('click', logout);

$('#stockChart')?.addEventListener('mousemove', handleChartPointer);
$('#stockChart')?.addEventListener('touchmove', (event) => {
  if (event.touches[0]) handleChartPointer(event.touches[0]);
}, { passive: true });
$('#stockChart')?.addEventListener('mouseleave', hideTooltip);
$('#stockChart')?.addEventListener('touchend', hideTooltip);

window.addEventListener('resize', () => {
  if (state.stock) drawChart(state.stock);
});

renderAuth();
updateRangeButtons();
setStatus('Log ind kræves', '');
checkSession().then((ok) => {
  if (ok) {
    loadDashboardNow().then(() => startAutoRefresh());
    setInterval(() => fetchMarketHours().catch((error) => console.error(error)), 30_000);
    state.chartHistoryTimer = setInterval(() => fetchChartHistory().catch((error) => console.error(error)), 20_000);
  }
});
