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
  wallet: null,
  walletTimer: null,
  token: localStorage.getItem('tsnStockToken') || '',
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

function renderAuth() {
  const loggedIn = Boolean(state.token && state.user?.id);
  document.body.classList.toggle('is-logged-in', loggedIn);
  $('#authCard')?.classList.toggle('hidden', loggedIn);
  $('#accountCard')?.classList.toggle('hidden', !loggedIn);
  $('#moneySection')?.classList.toggle('locked', !loggedIn);
  $('#tradeSection')?.classList.toggle('locked', !loggedIn);

  const name = state.user?.name || state.user?.username || 'TSN bruger';
  const username = state.user?.username ? `@${state.user.username}` : '';
  const accountName = $('#accountName');
  const accountUser = $('#accountUser');
  if (accountName) accountName.textContent = name;
  if (accountUser) accountUser.textContent = username || 'Original TSN konto';

  const lockText = $('#walletLockText');
  if (lockText) lockText.textContent = loggedIn
    ? 'Wallet er forbundet til din originale TSN-konto.'
    : 'Log ind med din originale TSN-konto for at optjene TSNM og handle.';
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
  state.user = data.user;
  localStorage.setItem('tsnStockToken', state.token);
  setAuthStatus('Logget ind.');
  renderAuth();
  await fetchWallet();
  startWalletRewards();
}

function logout() {
  state.token = '';
  state.user = null;
  state.wallet = null;
  localStorage.removeItem('tsnStockToken');
  clearInterval(state.walletTimer);
  renderAuth();
  renderWallet(null);
  setAuthStatus('Du er logget ud.');
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
    state.user = data.user;
    renderAuth();
    return true;
  } catch (error) {
    console.warn(error);
    logout();
    setAuthStatus('Sessionen udløb. Log ind igen.');
    return false;
  }
}

function formatTsnm(value) {
  return `${formatNumber(value, 2)} TSNM`;
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


function renderWallet(wallet) {
  state.wallet = wallet;
  if (!wallet) {
    $('#tsnmBalance').textContent = '0,00 TSNM';
    $('#tsnShares').textContent = '0';
    $('#portfolioValue').textContent = '0,00 TSNM';
    $('#netWorth').textContent = '0,00 TSNM';
    return;
  }
  $('#tsnmBalance').textContent = formatTsnm(wallet.balance || 0);
  $('#tsnShares').textContent = formatNumber(wallet.shares || 0, 3);
  $('#portfolioValue').textContent = formatTsnm(wallet.portfolioValue || 0);
  $('#netWorth').textContent = formatTsnm(wallet.netWorth || 0);

  const reward = wallet.reward;
  const rewardInfo = $('#rewardInfo');
  if (rewardInfo) {
    if (reward?.minutes > 0) {
      rewardInfo.textContent = `Du fik +${formatNumber(reward.amount, 0)} TSNM for ${reward.minutes} online minut${reward.minutes === 1 ? '' : 'ter'}.`;
    } else {
      const seconds = Math.max(1, Math.ceil((reward?.nextRewardInMs || 60000) / 1000));
      rewardInfo.textContent = `Du får ${Number(config.tsnmEarnPerMinute || 10)} TSNM pr. online minut. Næste reward om ca. ${seconds}s.`;
    }
  }
}

function updateTradeEstimate() {
  const qty = Number($('#tradeQuantity')?.value || 0);
  const price = Number(state.stock?.price || 0);
  const estimate = qty > 0 && price > 0 ? qty * price : 0;
  const el = $('#tradeEstimate');
  if (el) el.textContent = `Estimeret handelsværdi: ${formatTsnm(estimate)} ved kurs ${formatNumber(price)}.`;
}

async function fetchWallet() {
  if (!state.token) return;
  const rewardInfo = $('#rewardInfo');
  if (rewardInfo) rewardInfo.textContent = 'Henter TSNM wallet...';
  const response = await fetchWithTimeout('/api/wallet', { headers: authHeaders(), cache: 'no-store' }, 30000);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    const message = data.error || 'Kunne ikke hente TSNM wallet';
    if (rewardInfo) rewardInfo.textContent = message;
    throw new Error(message);
  }
  renderWallet(data.wallet);
  updateTradeEstimate();
}

async function tickWallet() {
  if (!state.token) return;
  const response = await fetchWithTimeout('/api/wallet/tick', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({}),
    cache: 'no-store'
  }, 30000);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || 'Kunne ikke opdatere TSNM wallet');
  renderWallet(data.wallet);
}

async function trade(type) {
  if (!state.token) {
    const status = $('#tradeStatus');
    if (status) status.textContent = 'Log ind med din TSN-konto først.';
    return;
  }
  const quantity = Number($('#tradeQuantity')?.value || 0);
  const status = $('#tradeStatus');
  if (!quantity || quantity <= 0) {
    if (status) status.textContent = 'Vælg et antal højere end 0.';
    return;
  }
  if (status) status.textContent = type === 'buy' ? 'Køber...' : 'Sælger...';

  const response = await fetchWithTimeout('/api/trade', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ type, quantity }),
    cache: 'no-store'
  }, 12000);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || 'Handel fejlede');
  renderWallet(data.wallet);
  if (status) {
    status.textContent = `${type === 'buy' ? 'Købt' : 'Solgt'} ${formatNumber(data.trade.quantity, 3)} TSN Stock for ${formatTsnm(data.trade.value)}.`;
  }
  await fetchStock({ manual: true }).catch(() => {});
}

function startWalletRewards() {
  clearInterval(state.walletTimer);
  if (!state.token) return;
  tickWallet().catch((error) => console.error(error));
  state.walletTimer = setInterval(() => {
    tickWallet().catch((error) => console.error(error));
  }, 15_000);
}

function renderStock(stock) {
  state.stock = stock;
  if (!stock) return;

  $('#stockPrice').textContent = formatNumber(stock.price);
  const change = $('#stockChange');
  const trend = stock.trend || 'flat';
  change.className = `change ${trend}`;
  change.textContent = `${formatSigned(stock.change)} · ${Number(stock.changePercent || 0) > 0 ? '+' : ''}${formatNumber(stock.changePercent)}%`;
  $('#updatedAt').textContent = `Opdateret ${formatTime(stock.updatedAt)}`;
  $('#stockDisclaimer').textContent = stock.disclaimer || 'Fiktiv TSN-aktivitetspris. Ikke en rigtig aktie.';
  $('#refreshInfo').textContent = `Tjekker for ændringer hvert ${Math.max(1, Math.round(REFRESH_INTERVAL_MS / 1000))}. sekund og opdaterer ved selv små ændringer`;
  const persistenceInfo = $('#persistenceInfo');
  if (persistenceInfo) {
    const persistence = stock.persistence || {};
    persistenceInfo.textContent = persistence.enabled
      ? `Historik gemmes i MongoDB (${persistence.database || 'database'}.${persistence.collection || 'collection'})`
      : 'Historik gemmes kun midlertidigt, fordi MongoDB ikke er sat op endnu';
    persistenceInfo.className = `persistence-info ${persistence.enabled ? 'connected' : 'warning'}`;
  }

  const metrics = stock.metrics || {};
  $('#onlineUsers').textContent = metrics.onlineUsers ?? 0;
  $('#messagesHour').textContent = metrics.messagesPerHour ?? 0;
  $('#postsHour').textContent = metrics.postsPerHour ?? 0;
  $('#activityScore').textContent = formatNumber(metrics.activityPoints ?? ((metrics.activityScore || 0) * 1000), 0);
  drawChart(stock);
  updateTradeEstimate();
}


async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchChartHistory({ force = false } = {}) {
  const now = Date.now();
  if (!force && state.chartHistoryFetchedAt && now - state.chartHistoryFetchedAt < 20_000) return;
  const maxPoints = Number(config.historyApiMaxPoints || 1400);
  const response = await fetchWithTimeout(`/api/history?range=${encodeURIComponent(state.chartRange)}&limit=${maxPoints}`, { cache: 'no-store' }, 12000);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || 'Kunne ikke hente grafhistorik');
  state.chartHistory = Array.isArray(data.history) ? data.history : [];
  state.chartHistoryFetchedAt = now;
  updateRangeButtons();
  if (state.stock) drawChart(state.stock);
}

async function fetchStock({ manual = false } = {}) {
  if (state.isFetching) return;

  state.isFetching = true;
  if (manual) setStatus('Opdaterer...', '');

  try {
    const url = '/api/stock?force=1';
    const response = await fetchWithTimeout(url, { cache: 'no-store' }, 35000);
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



async function testWalletConnection() {
  const output = $('#walletTestOutput') || $('#sourceTestOutput');
  if (output) output.textContent = 'Tester TSNM wallet...';
  try {
    const response = await fetchWithTimeout('/api/wallet/test', { headers: authHeaders(), cache: 'no-store' }, 30000);
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.error || data.message || 'Wallet-test fejlede.');
    if (output) {
      output.textContent = `Wallet OK. Bruger: ${data.user?.username || data.playerId}. Database: ${data.persistence === 'memory' ? 'memory (ikke permanent)' : `${data.walletDatabase}.${data.walletCollection}`}. Saldo: ${formatTsnm(data.wallet?.balance || 0)}.`;
    }
    renderWallet(data.wallet);
  } catch (error) {
    if (output) output.textContent = `Wallet-test fejlede: ${error.message}`;
  }
}

async function testTsnSourceConnection() {
  const output = $('#sourceTestOutput');
  if (output) output.textContent = 'Tester forbindelse til normal TSN...';
  try {
    const response = await fetchWithTimeout('/api/source-test', { cache: 'no-store' }, 40000);
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

async function resetStock() {
  const sure = window.confirm('Vil du nulstille TSN Stock? Dette sletter den gemte grafhistorik og starter prisen fra reset-niveauet igen.');
  if (!sure) return;

  let headers = {};
  if (config.resetRequiresKey) {
    const key = window.prompt('Indtast TSN Stock reset key:');
    if (!key) return;
    headers['X-Reset-Key'] = key;
  }

  setStatus('Nulstiller...', '');
  const response = await fetchWithTimeout('/api/reset', {
    method: 'POST',
    headers,
    cache: 'no-store'
  }, 12000);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    throw new Error(data.error || `Reset fejlede (${response.status})`);
  }
  renderStock(data.stock);
  setStatus('Nulstillet', 'connected');
  await fetchStock({ manual: true });
}

function startAutoRefresh() {
  clearInterval(state.timer);
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

$('#resetButton')?.addEventListener('click', () => resetStock().catch((error) => {
  setStatus('Kunne ikke nulstille', 'error');
  console.error(error);
  alert(error.message || 'Kunne ikke nulstille TSN Stock.');
}));

$('#buyButton')?.addEventListener('click', () => trade('buy').catch((error) => {
  const status = $('#tradeStatus');
  if (status) status.textContent = error.message || 'Køb fejlede.';
}));

$('#sellButton')?.addEventListener('click', () => trade('sell').catch((error) => {
  const status = $('#tradeStatus');
  if (status) status.textContent = error.message || 'Salg fejlede.';
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

$('#tradeQuantity')?.addEventListener('input', updateTradeEstimate);
$('#loginForm')?.addEventListener('submit', (event) => loginWithTsn(event).catch((error) => setAuthStatus(error.message || 'Login fejlede.')));
$('#logoutButton')?.addEventListener('click', logout);
$('#walletTestButton')?.addEventListener('click', () => testWalletConnection());

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
checkSession().then((ok) => {
  if (ok) {
    fetchWallet().catch((error) => console.error(error));
    startWalletRewards();
  }
});
fetchStock().catch((error) => {
  console.error(error);
  setStatus('Kan ikke forbinde', 'error');
});
startAutoRefresh();
state.chartHistoryTimer = setInterval(() => fetchChartHistory().catch((error) => console.error(error)), 20_000);
