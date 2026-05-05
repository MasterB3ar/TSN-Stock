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
  isFetching: false
};

const $ = (selector) => document.querySelector(selector);

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

function normalizeHistory(stock) {
  const raw = Array.isArray(stock?.history) && stock.history.length
    ? stock.history
    : [{ price: stock?.price, createdAt: stock?.updatedAt }];

  const clean = raw
    .map((point) => ({
      price: Number(point.price) || 0,
      createdAt: point.createdAt || point.updatedAt || stock?.updatedAt || new Date().toISOString()
    }))
    .filter((point) => Number.isFinite(point.price));

  const current = {
    price: Number(stock?.price) || 0,
    createdAt: stock?.updatedAt || new Date().toISOString()
  };

  const last = clean[clean.length - 1];
  if (!last || Math.abs(last.price - current.price) > 0.0001 || last.createdAt !== current.createdAt) {
    clean.push(current);
  }

  return clean.slice(-160);
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

async function fetchStock({ manual = false } = {}) {
  if (state.isFetching) return;

  state.isFetching = true;
  if (manual) setStatus('Opdaterer...', '');

  try {
    const url = '/api/stock?force=1';
    const response = await fetchWithTimeout(url, { cache: 'no-store' }, 12000);
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      if (Array.isArray(data.needs) && data.needs.includes('TSN_API_BASE_URL')) {
        $('#setupHelp')?.classList.remove('hidden');
      }
      throw new Error(data.error || `TSN Stock API svarede ${response.status}`);
    }
    renderStock(data.stock);
    const source = data.stock?.source === 'last-known' ? 'Seneste gemte data' : 'Live fra TSN';
    const persistent = data.stock?.persistence?.enabled ? ' + MongoDB' : '';
    setStatus(`${source}${persistent}`, data.stock?.source === 'last-known' ? '' : 'connected');
    state.lastFetchFailed = false;
  } finally {
    state.isFetching = false;
  }
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

$('#stockChart')?.addEventListener('mousemove', handleChartPointer);
$('#stockChart')?.addEventListener('touchmove', (event) => {
  if (event.touches[0]) handleChartPointer(event.touches[0]);
}, { passive: true });
$('#stockChart')?.addEventListener('mouseleave', hideTooltip);
$('#stockChart')?.addEventListener('touchend', hideTooltip);

window.addEventListener('resize', () => {
  if (state.stock) drawChart(state.stock);
});

fetchStock().catch((error) => {
  console.error(error);
  setStatus('Kan ikke forbinde', 'error');
});
startAutoRefresh();
