// Mini App do walletbot-mcp: chama os endpoints do Telegram Serverless (que repassam ao Worker).
const tg = window.Telegram.WebApp;
tg.ready();
tg.expand();

const $ = (sel) => document.querySelector(sel);
const fmt = (n, d = 2) => (n === null || n === undefined || Number.isNaN(+n) ? '—' : (+n).toLocaleString('pt-BR', { maximumFractionDigits: d, minimumFractionDigits: Math.min(d, 2) }));
const usd = (n, d = 2) => (n === null || n === undefined ? '—' : `$${fmt(n, d)}`);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

function call(name, input = {}) {
  return new Promise((resolve, reject) => {
    tg.Serverless.call(name, input, (err, result) => (err ? reject(err) : resolve(result)));
  });
}

function showError(err) {
  const msg = err?.message || String(err);
  $('#alert').textContent = `⚠️ ${msg}`;
  $('#alert').classList.remove('hidden');
}

let state = null;
let contracts = [];

// ---------- abas ----------
document.querySelectorAll('nav button').forEach((b) =>
  b.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${b.dataset.tab}`));
    if (b.dataset.tab === 'pares' && !contracts.length) loadPairs();
    if (b.dataset.tab === 'hist') loadHistory();
  }),
);

// ---------- painel ----------
async function loadState() {
  try {
    state = await call('state');
    $('#alert').classList.add('hidden');
    renderState();
    if (state.grid) loadChart(state.grid.market);
  } catch (e) {
    showError(e);
  }
}

function renderState() {
  const s = state;
  $('#mode').textContent = s.mode.toUpperCase();
  $('#mode').className = `pill ${s.mode === 'live' ? 'live' : ''}`;
  $('#run').textContent = s.paused ? 'pausado' : s.running ? 'rodando' : 'parado';
  $('#run').className = `pill ${s.running && !s.paused ? 'on' : ''}`;
  $('#price').textContent = s.grid ? `${s.grid.market} ${usd(s.lastPrice, 2)}` : '—';

  const notes = [s.paused && `⏸️ ${s.paused}`, s.lastBlock && `🚫 ${s.lastBlock}`, s.lastError && `⚠️ ${s.lastError}`, !s.connected && '🔌 Walt não conectado (/connect no bot)'].filter(Boolean);
  $('#alert').innerHTML = notes.map(esc).join('<br>');
  $('#alert').classList.toggle('hidden', !notes.length);

  const g = s.grid;
  $('#g-desc').textContent = g ? `${g.market} ${usd(g.low)}–${usd(g.high)} · ${g.levels} degraus de ${usd(g.step)}` : 'não configurado';
  $('#g-trade').textContent = g ? `margem ${usd(g.marginUsd)} ${g.leverage}x ≈ ${usd(g.notional)} · SL ${usd(g.stopLoss)}` : '—';

  const p = s.position;
  const lp = s.livePosition;
  if (p) {
    const pnl = p.unrealizedPnl;
    const rows = [
      ['Entrada', usd(p.entryPrice)],
      ['Take-profit', usd(p.takeProfit)],
      ['Stop-loss', usd(p.stopLoss)],
      ['Margem', usd(p.marginUsd)],
      ['PnL aberto', `<span class="pos-pnl ${pnl >= 0 ? 'up' : 'down'}">${usd(pnl, 4)}</span>`],
    ];
    if (lp) {
      const liq = +lp.liquidation_price;
      rows.push(['Liquidação', `${usd(liq)}${liq && s.lastPrice ? ` (${fmt(((s.lastPrice - liq) / s.lastPrice) * 100, 1)}% de distância)` : ''}`]);
      if (lp.funding_paid_quote !== undefined) rows.push(['Funding pago', usd(lp.funding_paid_quote, 4)]);
      if (lp.margin_quote !== undefined) rows.push(['Margem no Walt', usd(lp.margin_quote)]);
    }
    $('#pos').innerHTML = rows.map(([k, v]) => `<div class="row"><span>${k}</span><b>${v}</b></div>`).join('');
  } else {
    $('#pos').textContent = g ? 'Nenhuma posição aberta — aguardando o preço entrar num degrau.' : 'Configure um grid em Controles.';
  }

  const st = s.stats;
  const eq = s.mode === 'paper' ? s.paper?.equity : null;
  $('#stats').innerHTML = [
    [`${st.trades}`, 'trades'],
    [`${st.wins}/${st.losses}`, 'TP / SL'],
    [usd(st.realizedPnl, 4), 'PnL realizado'],
    ...(eq !== null && eq !== undefined ? [[usd(eq), 'patrimônio paper']] : []),
    [s.lastTick ? new Date(s.lastTick).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '—', 'último tick'],
  ]
    .map(([v, l]) => `<div><b>${v}</b><span>${l}</span></div>`)
    .join('');
}

async function loadChart(market) {
  try {
    const c = await call('chart', { market });
    $('#chart-src').textContent = c.source === 'hyperliquid' ? '· 15 min, 48 h' : '· preços do bot';
    drawChart(c.candles);
  } catch (e) {
    $('#chart').innerHTML = `<text x="10" y="20" fill="currentColor" font-size="12">${esc(e.message)}</text>`;
  }
}

function drawChart(candles) {
  const svg = $('#chart');
  const W = 360, H = 220, P = 6;
  const g = state.grid;
  const closes = candles.map((c) => c[4]);
  const lines = [];
  if (g) lines.push(...g.levelPrices.map((v) => ({ v, cls: 'var(--hint)', dash: '2 3' })));
  if (state.position) lines.push({ v: state.position.takeProfit, cls: 'var(--green)' }, { v: state.position.entryPrice, cls: 'var(--link)' });
  const all = closes.concat(lines.map((l) => l.v)).filter((v) => Number.isFinite(v));
  if (!all.length) {
    svg.innerHTML = '<text x="10" y="20" fill="currentColor" font-size="12">Sem dados ainda.</text>';
    return;
  }
  // a escala segue preço + grid; o SL (normalmente bem abaixo) é desenhado preso na borda com o valor
  let lo = Math.min(...all), hi = Math.max(...all);
  const pad = (hi - lo) * 0.04 || hi * 0.01;
  lo -= pad; hi += pad;
  const y = (v) => H - P - ((v - lo) / (hi - lo)) * (H - 2 * P);
  const x = (i) => P + (i / Math.max(1, closes.length - 1)) * (W - 2 * P);
  let out = lines
    .map((l) => `<line x1="0" x2="${W}" y1="${y(l.v)}" y2="${y(l.v)}" stroke="${l.cls}" stroke-width="1" ${l.dash ? `stroke-dasharray="${l.dash}"` : ''} vector-effect="non-scaling-stroke"/>`)
    .join('');
  const sl = g ? (state.position?.stopLoss ?? g.stopLoss) : null;
  if (Number.isFinite(sl)) {
    const ys = Math.min(H - 2, Math.max(2, y(sl)));
    out += `<line x1="0" x2="${W}" y1="${ys}" y2="${ys}" stroke="var(--red)" stroke-width="1.5" vector-effect="non-scaling-stroke"/>`;
    out += `<text x="${W - P}" y="${ys - 4}" text-anchor="end" fill="var(--red)" font-size="11">SL ${usd(sl)}</text>`;
  }
  if (closes.length > 1) {
    const d = closes.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
    out += `<path d="${d}" fill="none" stroke="var(--text)" stroke-width="1.6" vector-effect="non-scaling-stroke"/>`;
    out += `<circle cx="${x(closes.length - 1)}" cy="${y(closes[closes.length - 1])}" r="3" fill="var(--link)"/>`;
  }
  svg.innerHTML = out;
}

// ---------- pares ----------
async function loadPairs() {
  $('#pairs').textContent = 'Carregando…';
  try {
    contracts = (await call('contracts')).contracts;
    renderPairs();
  } catch (e) {
    $('#pairs').textContent = e.message;
  }
}

function renderPairs() {
  const q = $('#q').value.trim().toUpperCase();
  const onlyOk = $('#only-liquid').checked;
  const list = contracts.filter((c) => (!q || c.market.includes(q)) && (!onlyOk || c.allowed));
  $('#pairs').innerHTML =
    list
      .map(
        (c) => `<div class="item ${c.allowed ? '' : 'blocked'}" data-market="${esc(c.market)}">
      <div><div class="name">${esc(c.market)}</div>
      <div class="meta">vol 24h ${usd(c.volume24hUsd, 0)} · funding ${fmt((c.fundingRateHourly ?? 0) * 100, 4)}%/h · até ${c.maxLeverage}x</div></div>
      <div class="tag">${c.allowed ? '›' : c.liquid ? 'bloqueado' : 'pouca liquidez'}</div></div>`,
      )
      .join('') || '<div class="card">Nenhum par encontrado.</div>';
}
$('#q').addEventListener('input', renderPairs);
$('#only-liquid').addEventListener('change', renderPairs);
$('#pairs').addEventListener('click', async (ev) => {
  const item = ev.target.closest('.item');
  if (!item) return;
  const market = item.dataset.market;
  const box = $('#pair-detail');
  box.classList.remove('hidden');
  box.textContent = `Carregando ${market}…`;
  window.scrollTo({ top: 0, behavior: 'smooth' });
  try {
    const p = await call('price', { market, leverage: 3 });
    const c = contracts.find((x) => x.market === market);
    box.innerHTML = `<h3>${esc(market)}</h3>
      <div class="row"><span>Preço</span><b>${usd(p.price, 6)}</b></div>
      <div class="row"><span>Margem mínima a ${p.leverage}x</span><b>${usd(p.minMargin)}</b></div>
      <div class="row"><span>Faixa sugerida (−6% / +2%)</span><b>${usd(p.suggestion.low, 6)} – ${usd(p.suggestion.high, 6)}</b></div>
      <div class="row"><span>Taxa taker</span><b>${fmt((c?.takerFeePct ?? 0) * 100, 3)}%</b></div>
      ${c?.allowed ? '<button id="use-pair">Usar no grid</button>' : '<p class="meta">Par fora dos critérios de liquidez/whitelist do bot.</p>'}`;
    const btn = $('#use-pair');
    if (btn)
      btn.onclick = () => {
        const f = $('#grid-form');
        f.market.value = market;
        f.low.value = p.suggestion.low;
        f.high.value = p.suggestion.high;
        f.marginUsd.value = Math.max(+f.marginUsd.value || 0, Math.ceil(p.minMargin * 1.1 * 100) / 100);
        f.leverage.value = p.leverage;
        document.querySelector('nav button[data-tab="ctrl"]').click();
      };
  } catch (e) {
    box.textContent = e.message;
  }
});

// ---------- histórico ----------
async function loadHistory() {
  try {
    const h = await call('trades');
    drawEquity(h.equity);
    $('#trades').innerHTML = h.trades.length
      ? `<table><tr><th>Quando</th><th>Evento</th><th>Preço</th><th>PnL</th></tr>${h.trades
          .map((t) => {
            const when = new Date(t.at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
            const ev = t.event === 'open' ? `🔵 long ${esc(t.market)}` : t.reason === 'tp' ? '🟢 TP' : t.reason === 'sl' ? '🛑 SL' : '✋ manual';
            const pnl = t.pnl === undefined ? '' : `<span class="${t.pnl >= 0 ? 'up' : 'down'}">${usd(t.pnl, 4)}</span>`;
            return `<tr><td>${when}${t.mode === 'paper' ? ' <small>(paper)</small>' : ''}</td><td>${ev}</td><td>${usd(t.price)}</td><td>${pnl}</td></tr>`;
          })
          .join('')}</table>`
      : 'Nenhum trade ainda.';
  } catch (e) {
    $('#trades').textContent = e.message;
  }
}

function drawEquity(points) {
  const svg = $('#equity');
  if (!points || points.length < 2) {
    svg.innerHTML = '<text x="10" y="20" fill="currentColor" font-size="12">Curva aparece após algumas horas de bot rodando.</text>';
    return;
  }
  const W = 360, H = 140, P = 6;
  const vs = points.map((p) => p[1]);
  const lo = Math.min(...vs), hi = Math.max(...vs) || 1;
  const span = hi - lo || hi * 0.01 || 1;
  const t0 = points[0][0], t1 = points[points.length - 1][0] || t0 + 1;
  const x = (t) => P + ((t - t0) / (t1 - t0 || 1)) * (W - 2 * P);
  const y = (v) => H - P - ((v - lo) / span) * (H - 2 * P);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join('');
  const up = vs[vs.length - 1] >= vs[0];
  svg.innerHTML = `<path d="${d}" fill="none" stroke="${up ? 'var(--green)' : 'var(--red)'}" stroke-width="1.8" vector-effect="non-scaling-stroke"/>
    <text x="${W - P}" y="14" text-anchor="end" fill="currentColor" font-size="12">${usd(vs[vs.length - 1])}</text>`;
}

// ---------- controles ----------
function ctrlMessage(text) {
  const box = $('#ctrl-msg');
  box.textContent = text;
  box.classList.remove('hidden');
}

function confirm(text) {
  return new Promise((resolve) => tg.showConfirm(text, resolve));
}

$('#grid-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const input = {
    market: f.market.value.trim().toUpperCase(),
    low: +f.low.value,
    high: +f.high.value,
    levels: +f.levels.value,
    marginUsd: +f.marginUsd.value,
    leverage: +f.leverage.value,
  };
  try {
    const r = await call('configure', input);
    ctrlMessage(r.message);
    loadState();
  } catch (e) {
    ctrlMessage(`❌ ${e.message}`);
  }
});

document.querySelectorAll('[data-action]').forEach((b) =>
  b.addEventListener('click', async () => {
    const action = b.dataset.action;
    const input = { action };
    if (action === 'mode') {
      input.mode = b.dataset.mode;
      if (input.mode === 'live') {
        if (!(await confirm('Modo LIVE usa dinheiro real em perpétuos alavancados. Confirmar?'))) return;
        input.confirm = true;
      }
    }
    if (action === 'closeall' && !(await confirm('Fechar a posição do grid agora e parar o bot?'))) return;
    try {
      tg.HapticFeedback?.impactOccurred('light');
      const r = await call('control', input);
      ctrlMessage(r.message);
      loadState();
    } catch (e) {
      ctrlMessage(`❌ ${e.message}`);
    }
  }),
);

// preenche o formulário com o grid atual
function fillForm() {
  const g = state?.grid;
  if (!g) return;
  const f = $('#grid-form');
  f.market.value = g.market;
  f.low.value = g.low;
  f.high.value = g.high;
  f.levels.value = g.levels;
  f.marginUsd.value = g.marginUsd;
  f.leverage.value = g.leverage;
}

loadState().then(fillForm);
setInterval(loadState, 30_000);
