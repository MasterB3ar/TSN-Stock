const config = window.TSN_STOCK_CONFIG || {};
const API_BASE = String(config.apiBaseUrl || '').replace(/\/$/, '');
const state = { stock: null, lastFetchFailed: false };

const $ = (selector) => document.querySelector(selector);

function formatNumber(value, decimals = 2) {
  return Number(value || 0).toLocaleString('da-DK', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function formatSigned(value) {
  const number = Number(value) || 0;
  const sign = number > 0 ? '+' : number < 0 ? '-' : '';
  return `${sign}${formatNumber(Math.abs(number), 2)}`;
}

function formatTime(iso) {
  if (!iso) return 'Live';
  return new Intl.DateTimeFormat('da-DK', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(iso));
}

function setStatus(text, mode = '') {
  const el = $('#connectionStatus');
  if (!el) return;
  el.textContent = text;
  el.className = `status-pill ${mode}`.trim();
}

function drawChart(stock) {
  const canvas = $('#stockChart');
  if (!canvas || !stock) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(320, Math.floor(rect.width * dpr));
  const height = Math.max(220, Math.floor(rect.height * dpr));
  canvas.width = width;
  canvas.height = height;
  ctx.clearRect(0, 0, width, height);

  const points = Array.isArray(stock.history) && stock.history.length ? stock.history : [{ price: stock.price, createdAt: stock.updatedAt }];
  const prices = points.map((p) => Number(p.price) || 0);
  const min = Math.min(...prices, Number(stock.price) || 0);
  const max = Math.max(...prices, Number(stock.price) || 0);
  const range = Math.max(1, max - min);
  const pad = 38 * dpr;
  const chartW = width - pad * 2;
  const chartH = height - pad * 2;

  ctx.strokeStyle = 'rgba(255,255,255,.10)';
  ctx.lineWidth = 1 * dpr;
  for (let i = 0; i <= 4; i += 1) {
    const y = pad + chartH * (i / 4);
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(width - pad, y);
    ctx.stroke();
  }

  const gradient = ctx.createLinearGradient(0, pad, 0, height - pad);
  gradient.addColorStop(0, 'rgba(56,217,169,.32)');
  gradient.addColorStop(1, 'rgba(124,92,255,.04)');

  const coords = points.map((point, index) => {
    const x = pad + (points.length === 1 ? chartW : chartW * (index / (points.length - 1)));
    const y = pad + chartH - (((Number(point.price) || 0) - min) / range) * chartH;
    return { x, y };
  });

  if (coords.length > 1) {
    ctx.beginPath();
    coords.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.lineTo(coords[coords.length - 1].x, height - pad);
    ctx.lineTo(coords[0].x, height - pad);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();
  }

  ctx.beginPath();
  coords.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.strokeStyle = stock.trend === 'down' ? '#ff6b6b' : '#38d9a9';
  ctx.lineWidth = 3 * dpr;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();

  const last = coords[coords.length - 1];
  if (last) {
    ctx.beginPath();
    ctx.arc(last.x, last.y, 5 * dpr, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
  }

  ctx.fillStyle = 'rgba(245,247,251,.72)';
  ctx.font = `${12 * dpr}px system-ui, sans-serif`;
  ctx.fillText(`Top ${formatNumber(max)}`, pad, 20 * dpr);
  ctx.fillText(`Bund ${formatNumber(min)}`, pad, height - 10 * dpr);
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

  const metrics = stock.metrics || {};
  $('#onlineUsers').textContent = metrics.onlineUsers ?? 0;
  $('#messagesHour').textContent = metrics.messagesPerHour ?? 0;
  $('#postsHour').textContent = metrics.postsPerHour ?? 0;
  $('#activityScore').textContent = formatNumber(metrics.activityScore || 0, 3);
  drawChart(stock);
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

async function fetchStock() {
  if (!API_BASE) {
    setStatus('Mangler TSN URL', 'error');
    $('#setupHelp')?.classList.remove('hidden');
    return;
  }
  const response = await fetchWithTimeout(`${API_BASE}/api/public/stock`, { cache: 'no-store' }, 10000);
  if (!response.ok) throw new Error(`TSN API svarede ${response.status}`);
  const data = await response.json();
  renderStock(data.stock);
  setStatus('Live fra TSN', 'connected');
  state.lastFetchFailed = false;
}

$('#refreshButton')?.addEventListener('click', () => fetchStock().catch((error) => {
  setStatus('Kunne ikke opdatere', 'error');
  console.error(error);
}));

window.addEventListener('resize', () => {
  if (state.stock) drawChart(state.stock);
});

fetchStock().catch((error) => {
  console.error(error);
  setStatus('Kan ikke forbinde', 'error');
});
setInterval(() => fetchStock().catch(() => setStatus('Venter på TSN', '')), 30000);
