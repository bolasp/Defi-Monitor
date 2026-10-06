(function () {
  const { CHAINS, POOLS, PROTOCOLS } = window.RADAR_CONFIG;
  const A = window.Analysis;
  const O = window.Onchain;
  const F = A.fmt;

  const REFRESH_MS = 30000;
  const SCAN_TTL = 5 * 60 * 1000;
  const HIST_TTL = 20 * 60 * 1000;
  const LS_PREFS = 'radar.prefs.v1';

  const state = {
    pools: POOLS.map((p) => ({ ...p, live: null, d: null, scan: null, hist: null, ta: null, sig: null, rg: null, livePts: [] })),
    filter: { chain: 'all', proto: 'all' },
    showAll: false,
    selectedKey: null,
    tier: 'conservative',
    capital: 10000,
    busy: false,
    lastUpdate: null,
    nextAt: 0,
    errors: {},
  };
  const byKey = Object.fromEntries(state.pools.map((p) => [p.key, p]));

  try {
    const prefs = JSON.parse(localStorage.getItem(LS_PREFS) || '{}');
    if (prefs.filter) state.filter = { ...state.filter, ...prefs.filter };
    if (prefs.tier) state.tier = prefs.tier;
    if (prefs.capital > 0) state.capital = prefs.capital;
    if (prefs.selectedKey && byKey[prefs.selectedKey]) state.selectedKey = prefs.selectedKey;
  } catch (e) {
    /* sem preferências salvas */
  }
  function savePrefs() {
    try {
      localStorage.setItem(
        LS_PREFS,
        JSON.stringify({ filter: state.filter, tier: state.tier, capital: state.capital, selectedKey: state.selectedKey })
      );
    } catch (e) {
      /* armazenamento indisponível */
    }
  }

  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const short = (a) => (a.length > 16 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
  const pairLabel = (p) => `${A.baseTok(p).sym} / ${A.quoteTok(p).sym}`;
  const tvlOf = (p) => (p.d && isFinite(p.d.tvl) ? p.d.tvl : -1);
  const selected = () => byKey[state.selectedKey];

  /* ------------------------------------------------------------ dados */

  function recompute(p) {
    if (!p.live) return;
    try {
      p.d = A.derive(p, p.live, p.scan);
      p.ta = p.hist && p.hist.candles ? A.technical(p.hist.candles, p.d.price) : null;
      p.sig = A.signal(p, p.d, p.ta);
      p.rg = A.ranges(p, p.d, p.ta, state.capital);
    } catch (e) {
      console.error('recompute', p.key, e);
    }
  }

  function pushLive(p) {
    const s = p.proto === 'orca' ? Number(p.live.sqrtPriceX64) / 2 ** 64 : Number(p.live.sqrtPriceX96) / 2 ** 96;
    const price = A.toBQ(p, s * s * Math.pow(10, p.token0.dec - p.token1.dec));
    p.livePts.push({ t: Date.now(), price, block: p.live.block });
    if (p.livePts.length > 240) p.livePts.shift();
  }

  function ranked() {
    const list = state.pools.filter(
      (p) => (state.filter.chain === 'all' || p.chain === state.filter.chain) && (state.filter.proto === 'all' || p.proto === state.filter.proto)
    );
    list.sort((a, b) => tvlOf(b) - tvlOf(a));
    return list;
  }

  async function loadEvm(chain, pools) {
    try {
      const res = await O.readEvmPools(chain, pools);
      state.errors[chain] = null;
      for (const p of pools) {
        const r = res[p.key];
        if (!r || r.error) {
          p.err = r ? r.error : 'sem resposta';
          continue;
        }
        p.err = null;
        p.live = r;
        pushLive(p);
        recompute(p);
      }
      scheduleRender();
      const need = pools.filter(
        (p) =>
          p.live &&
          (p.proto === 'v4' || p.key === state.selectedKey) &&
          (!p.scan || Date.now() - p.scan.at > SCAN_TTL || Math.abs(p.live.tick - p.scan.centerTick) > 1500 * p.tickSpacing)
      );
      await Promise.allSettled(
        need.map(async (p) => {
          try {
            p.scan = await O.scanTicksEvm(chain, p, p.live.tick, p.proto === 'v4' ? 10000 : 3000);
            p.scanErr = null;
          } catch (e) {
            p.scanErr = e.message;
          }
          recompute(p);
          scheduleRender();
        })
      );
    } catch (e) {
      state.errors[chain] = e.message || String(e);
    }
  }

  async function loadOrca(pools) {
    try {
      const res = await O.readOrcaPools(pools);
      state.errors.solana = null;
      for (const p of pools) {
        const r = res[p.key];
        if (!r || r.error) {
          p.err = r ? r.error : 'sem resposta';
          continue;
        }
        p.err = null;
        p.live = r;
        pushLive(p);
        recompute(p);
      }
      scheduleRender();
      const p = selected();
      if (p && p.chain === 'solana') await scanOrca(p);
    } catch (e) {
      state.errors.solana = e.message || String(e);
    }
  }

  async function scanOrca(p) {
    if (!p.live) return;
    try {
      p.scan = await O.scanTicksOrca(p, p.live.tick);
      p.scanErr = null;
    } catch (e) {
      p.scanErr = e.message;
    }
    recompute(p);
    scheduleRender();
  }

  async function scanSelectedIfNeeded() {
    const p = selected();
    if (!p || !p.live || p.scan) return;
    if (p.chain === 'solana') await scanOrca(p);
    else {
      try {
        p.scan = await O.scanTicksEvm(p.chain, p, p.live.tick, p.proto === 'v4' ? 10000 : 3000);
        p.scanErr = null;
      } catch (e) {
        p.scanErr = e.message;
      }
      recompute(p);
      scheduleRender();
    }
  }

  function requestHistories() {
    const top = ranked()
      .filter((p) => tvlOf(p) > 0)
      .slice(0, 10);
    const sel = selected();
    const list = sel ? [sel, ...top.filter((p) => p !== sel)] : top;
    list.forEach((p) => {
      if (p.histLoading || (p.hist && Date.now() - p.hist.at < HIST_TTL)) return;
      p.histLoading = true;
      O.loadHistory(p, { priority: p === sel })
        .then((h) => {
          p.hist = h;
          p.histErr = null;
        })
        .catch((e) => {
          p.histErr = e.message;
        })
        .finally(() => {
          p.histLoading = false;
          recompute(p);
          scheduleRender();
        });
    });
  }

  async function refresh() {
    if (state.busy) return;
    state.busy = true;
    renderHeader();
    const groups = { ethereum: [], polygon: [], solana: [] };
    state.pools.forEach((p) => groups[p.chain].push(p));
    await Promise.allSettled([loadEvm('ethereum', groups.ethereum), loadEvm('polygon', groups.polygon), loadOrca(groups.solana)]);
    state.busy = false;
    state.lastUpdate = Date.now();
    state.nextAt = Date.now() + REFRESH_MS;
    if (!state.selectedKey || !byKey[state.selectedKey]) {
      const first = ranked()[0];
      if (first) selectPool(first.key, false);
    }
    requestHistories();
    scanSelectedIfNeeded();
    scheduleRender();
  }

  /* ---------------------------------------------------------- render */

  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    // setTimeout em vez de requestAnimationFrame: a aba segue atualizando mesmo em segundo plano.
    setTimeout(() => {
      renderQueued = false;
      for (const fn of [renderHeader, renderSummary, renderTable, renderDetail]) {
        try {
          fn();
        } catch (e) {
          console.error(`Falha ao desenhar (${fn.name})`, e);
        }
      }
    }, 30);
  }

  const ICON = {
    ok: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="var(--good)"/><path d="M4.6 8.2l2.2 2.2 4.6-4.8" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    warn: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.2l7 13H1z" fill="var(--warn)"/><path d="M8 6v3.6" stroke="#3b2a00" stroke-width="1.7" stroke-linecap="round"/><circle cx="8" cy="11.8" r="1" fill="#3b2a00"/></svg>',
    crit: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.1 1h5.8L15 5.1v5.8L10.9 15H5.1L1 10.9V5.1z" fill="var(--crit)"/><path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/></svg>',
  };
  const SIG_LABEL = { ok: 'Estável', warn: 'Atenção', crit: 'Alerta' };
  const sigPill = (lv) => `<span class="sig sig-${lv}">${ICON[lv]}<span>${SIG_LABEL[lv]}</span></span>`;

  function renderHeader() {
    const el = $('#chain-status');
    el.innerHTML = Object.entries(CHAINS)
      .map(([k, c]) => {
        const h = O.health[k] || {};
        const err = state.errors[k];
        const status = err || h.ok === false ? 'err' : h.ok ? 'ok' : 'wait';
        const host = h.url ? new URL(h.url).host : '';
        const head = h.head ? `${h.headLabel} ${new Intl.NumberFormat('pt-BR').format(h.head)}` : status === 'err' ? 'sem resposta' : 'conectando…';
        const title = status === 'err' ? `Falha nos RPCs: ${err || h.err}` : host ? `RPC ${host} · ${h.ms} ms` : 'Conectando';
        return `<div class="chain-chip" title="${esc(title)}"><span class="dot dot-${status}"></span><span class="chain-name">${c.name}</span><span class="chain-head">${esc(head)}</span></div>`;
      })
      .join('');
    $('#btn-refresh').disabled = state.busy;
    $('#btn-refresh').textContent = state.busy ? 'Lendo a blockchain…' : 'Atualizar agora';
    updateCountdown();
  }

  function updateCountdown() {
    const el = $('#countdown');
    if (!state.lastUpdate) {
      el.textContent = 'Primeira leitura em andamento';
      return;
    }
    const t = new Date(state.lastUpdate).toLocaleTimeString('pt-BR');
    const left = Math.max(0, Math.ceil((state.nextAt - Date.now()) / 1000));
    el.textContent = state.busy ? `Leitura de ${t} · atualizando` : `Leitura de ${t} · próxima em ${left} s`;
  }

  function renderSummary() {
    const top = ranked()
      .filter((p) => tvlOf(p) > 0)
      .slice(0, 10);
    const all = state.pools.filter((p) => tvlOf(p) > 0);
    const tvlTop = top.reduce((s, p) => s + p.d.tvl, 0);
    const tvlAll = all.reduce((s, p) => s + p.d.tvl, 0);
    const worst = top.reduce((w, p) => (!w || Math.abs(p.d.devBps) > Math.abs(w.d.devBps) ? p : w), null);
    const counts = { ok: 0, warn: 0, crit: 0 };
    top.forEach((p) => p.sig && counts[p.sig.level]++);
    const withVol = top.filter((p) => p.ta);
    const vol = withVol.reduce((s, p) => s + p.ta.vol24, 0);
    const scope = state.filter.chain === 'all' ? 'nas 3 redes' : `em ${CHAINS[state.filter.chain].name}`;
    $('#summary').innerHTML = `
      <div class="stat"><span class="stat-label">TVL das 10 maiores</span><span class="stat-value">${top.length ? F.usd(tvlTop) : '—'}</span><span class="stat-sub">${all.length} de ${state.pools.length} pools lidas · ${F.usd(tvlAll)} no total</span></div>
      <div class="stat"><span class="stat-label">Maior desvio do peg</span><span class="stat-value">${worst ? F.bp(worst.d.devBps) : '—'}</span><span class="stat-sub">${worst ? esc(pairLabel(worst)) + ' · ' + PROTOCOLS[worst.proto].name : 'aguardando leitura'}</span></div>
      <div class="stat"><span class="stat-label">Sinais no top 10</span><span class="stat-value stat-signals"><span>${counts.ok}</span><small>estáveis</small><span>${counts.warn}</span><small>atenção</small><span>${counts.crit}</span><small>alerta</small></span><span class="stat-sub">Desvio, composição, volatilidade e RSI</span></div>
      <div class="stat"><span class="stat-label">Volume 24h do top 10</span><span class="stat-value">${withVol.length ? F.usd(vol) : '—'}</span><span class="stat-sub">${withVol.length < top.length ? `histórico carregado em ${withVol.length} de ${top.length}` : 'swaps indexados pelo GeckoTerminal'} · ${scope}</span></div>`;
  }

  function sparkline(p) {
    const c = p.hist && p.hist.candles;
    if (!c || c.length < 24) return `<span class="muted small">${p.histLoading ? 'carregando…' : '—'}</span>`;
    const pts = c.slice(-168).map((k) => k.c);
    const W = 104;
    const H = 30;
    const srt = [...pts].sort((a, b) => a - b);
    let lo = srt[Math.floor((srt.length - 1) * 0.02)];
    let hi = srt[Math.ceil((srt.length - 1) * 0.98)];
    if (hi - lo < 1e-6) {
      lo -= 5e-5;
      hi += 5e-5;
    }
    const x = (i) => (i / (pts.length - 1)) * (W - 6) + 1;
    const y = (v) => Math.min(H - 2, Math.max(2, H - 4 - ((v - lo) / (hi - lo)) * (H - 8)));
    const d = pts.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
    const area = `${d}L${x(pts.length - 1).toFixed(1)},${H}L${x(0)},${H}Z`;
    const peg = 1 >= lo && 1 <= hi ? `<line x1="0" x2="${W}" y1="${y(1).toFixed(1)}" y2="${y(1).toFixed(1)}" class="spark-peg"/>` : '';
    const last = pts[pts.length - 1];
    return `<svg class="spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Preço em 7 dias, de ${F.num(pts[0], 5)} a ${F.num(last, 5)}">${peg}<path d="${area}" class="spark-area"/><path d="${d}" class="spark-line"/><circle cx="${x(pts.length - 1).toFixed(1)}" cy="${y(last).toFixed(1)}" r="2.6" class="spark-end"/></svg>`;
  }

  function compBar(p) {
    if (!p.d || !isFinite(p.d.baseShare)) return '<span class="muted small">—</span>';
    const b = p.d.baseShare;
    const w = Math.round(b * 100);
    return `<div class="comp" title="${F.pct(b, 1)} ${esc(A.baseTok(p).sym)} · ${F.pct(1 - b, 1)} ${esc(A.quoteTok(p).sym)}">
      <div class="comp-bar"><span class="comp-base" style="width:${w}%"></span><span class="comp-quote" style="width:${100 - w}%"></span></div>
      <span class="small">${w}% ${esc(A.baseTok(p).sym)}</span></div>`;
  }

  function renderTable() {
    const list = ranked();
    const known = list.filter((p) => tvlOf(p) > 0);
    const rows = state.showAll ? list : known.slice(0, 10);
    const body = $('#rank-body');
    if (!rows.length) {
      body.innerHTML = `<tr><td colspan="10" class="empty">${state.busy || !state.lastUpdate ? 'Lendo o estado das pools direto da blockchain…' : 'Nenhuma pool com leitura válida para este filtro. Verifique os RPCs nas configurações abaixo.'}</td></tr>`;
    } else {
      body.innerHTML = rows
        .map((p, i) => {
          const d = p.d;
          const cons = p.rg && p.rg.find((r) => r.key === 'conservative');
          const sel = p.key === state.selectedKey ? ' is-selected' : '';
          const tvl = d && isFinite(d.tvl) ? F.usd(d.tvl) : p.err ? `<span class="muted small" title="${esc(p.err)}">indisponível</span>` : '<span class="muted small">calculando…</span>';
          const aprPool = d && p.ta && d.feeRate != null && d.tvl > 0 ? F.pct((p.ta.vol24 * d.feeRate * 365) / d.tvl, 2) : p.dynamicFee ? '<span class="muted small">taxa dinâmica</span>' : '—';
          return `<tr class="row${sel}" data-key="${esc(p.key)}" tabindex="0" aria-selected="${!!sel}">
            <td class="c-rank">${tvlOf(p) > 0 ? i + 1 : '·'}</td>
            <td class="c-pool"><span class="pair">${esc(pairLabel(p))}</span><span class="meta"><span class="proto proto-${p.proto}">${PROTOCOLS[p.proto].name}</span><span class="chain chain-${p.chain}">${CHAINS[p.chain].name}</span><span>${F.fee(p, d)}</span></span></td>
            <td class="num">${tvl}</td>
            <td>${compBar(p)}</td>
            <td class="num">${d ? `<span class="mono">${F.num(d.price, 6)}</span><span class="sub">${F.bp(d.devBps)}</span>` : '—'}</td>
            <td>${sparkline(p)}</td>
            <td class="num">${p.ta ? F.usd(p.ta.vol24) : p.histLoading ? '<span class="muted small">…</span>' : '—'}</td>
            <td class="num">${aprPool}</td>
            <td>${p.sig ? sigPill(p.sig.level) : '—'}</td>
            <td class="num c-range">${cons ? `<span class="mono">${F.num(cons.lo, 5)} – ${F.num(cons.hi, 5)}</span><span class="sub">${F.num(cons.widthBps, 1)} bp${cons.timeInRange != null ? ' · ' + F.pct(cons.timeInRange, 1) + ' no range' : ''}</span>` : '—'}</td>
          </tr>`;
        })
        .join('');
    }
    $('#rank-count').textContent = state.showAll ? `${list.length} pools candidatas neste filtro` : `${Math.min(10, known.length)} de ${list.length} pools candidatas`;
    $('#btn-showall').textContent = state.showAll ? 'Mostrar só o top 10' : `Ver todas as ${list.length} candidatas`;
    document.querySelectorAll('[data-filter]').forEach((b) => {
      const [k, v] = b.dataset.filter.split(':');
      b.setAttribute('aria-pressed', String(state.filter[k] === v));
    });
  }

  /* ---------------------------------------------------------- detalhe */

  let detailKey = null;
  function selectPool(key, scroll = true) {
    state.selectedKey = key;
    savePrefs();
    detailKey = null;
    const p = selected();
    scheduleRender();
    if (p) {
      requestHistories();
      if (!p.scan || p.chain === 'solana') scanSelectedIfNeeded();
    }
    if (scroll) $('#detail').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  }

  function poolLinks(p) {
    const c = CHAINS[p.chain];
    if (p.chain === 'solana')
      return `<a href="https://www.orca.so/pools/${p.address}" target="_blank" rel="noopener">Abrir na Orca ↗</a><a href="${c.explorer}/account/${p.address}" target="_blank" rel="noopener">Solscan ↗</a>`;
    const uni = `<a href="https://app.uniswap.org/explore/pools/${c.uniswapSlug}/${p.address}" target="_blank" rel="noopener">Abrir no Uniswap ↗</a>`;
    const exp = p.proto === 'v3' ? `${c.explorer}/address/${p.address}` : `${c.explorer}/address/${c.poolManager}`;
    return `${uni}<a href="${exp}" target="_blank" rel="noopener">${p.proto === 'v3' ? 'Contrato da pool ↗' : 'PoolManager ↗'}</a>`;
  }

  function renderDetailShell(p) {
    $('#detail').innerHTML = `
      <div class="d-head">
        <div class="d-title">
          <p class="eyebrow">Pool selecionada</p>
          <h2 id="d-pair"></h2>
          <p class="d-meta" id="d-meta"></p>
        </div>
        <div class="d-actions">
          <code class="addr" title="${esc(p.address)}">${esc(short(p.address))}</code>
          <button type="button" class="btn-ghost" id="btn-copy">Copiar ${p.proto === 'v4' ? 'poolId' : 'endereço'}</button>
          ${poolLinks(p)}
        </div>
      </div>
      <dl class="kpis" id="d-kpis"></dl>
      <div class="d-grid">
        <div class="d-col">
          <section class="card">
            <header class="card-head">
              <div><h3>Preço ${esc(pairLabel(p))} · 30 dias</h3><p class="card-sub">Velas de 1 hora, Bandas de Bollinger (20h, 2σ) e pontos ao vivo lidos on-chain</p></div>
              <div class="seg" role="group" aria-label="Range exibido">
                ${A.TIERS.map((t) => `<button type="button" data-tier="${t.key}" aria-pressed="${state.tier === t.key}">${t.name}</button>`).join('')}
              </div>
            </header>
            <div class="chart" id="chart-price"></div>
            <div class="legend" id="legend-price"></div>
          </section>
          <section class="card">
            <header class="card-head">
              <div><h3>Distribuição de liquidez on-chain</h3><p class="card-sub" id="liq-sub">Liquidez ativa (L) por faixa de preço, lida dos ticks inicializados</p></div>
            </header>
            <div class="chart" id="chart-liq"></div>
            <div class="legend" id="legend-liq"></div>
          </section>
          <section class="card">
            <header class="card-head"><div><h3>Ranges sugeridos</h3><p class="card-sub">Limites já ajustados ao tick spacing da pool</p></div></header>
            <div class="table-wrap"><table class="rtable" id="range-table"></table></div>
            <div class="sim">
              <label for="capital">Capital simulado (US$)</label>
              <input id="capital" type="number" min="100" step="100" inputmode="decimal" value="${state.capital}">
            </div>
            <p class="sim-out" id="sim-out"></p>
          </section>
        </div>
        <div class="d-col">
          <section class="card" id="ta-card"></section>
        </div>
      </div>`;
    $('#btn-copy').addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      try {
        await navigator.clipboard.writeText(p.address);
        btn.textContent = 'Copiado';
      } catch (e) {
        const r = document.createRange();
        r.selectNodeContents($('.addr'));
        getSelection().removeAllRanges();
        getSelection().addRange(r);
        btn.textContent = 'Selecionado: use Ctrl+C';
      }
      setTimeout(() => (btn.textContent = `Copiar ${p.proto === 'v4' ? 'poolId' : 'endereço'}`), 2000);
    });
    $('#detail').querySelectorAll('[data-tier]').forEach((b) =>
      b.addEventListener('click', () => {
        state.tier = b.dataset.tier;
        savePrefs();
        $('#detail').querySelectorAll('[data-tier]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.tier === state.tier)));
        renderDetailBody(p);
      })
    );
    $('#capital').addEventListener('input', (ev) => {
      const v = parseFloat(ev.target.value);
      if (v > 0) {
        state.capital = v;
        savePrefs();
        recompute(p);
        renderRanges(p);
      }
    });
  }

  function renderDetail() {
    const p = selected();
    if (!p) {
      $('#detail').innerHTML = '<p class="empty">Selecione uma pool na tabela para ver a análise.</p>';
      detailKey = null;
      return;
    }
    if (detailKey !== p.key) {
      renderDetailShell(p);
      detailKey = p.key;
    }
    renderDetailBody(p);
  }

  function renderDetailBody(p) {
    const d = p.d;
    $('#d-pair').textContent = pairLabel(p);
    $('#d-meta').innerHTML = `<span class="proto proto-${p.proto}">${PROTOCOLS[p.proto].name}</span><span class="chain chain-${p.chain}">${CHAINS[p.chain].name}</span><span>Taxa ${F.fee(p, d)}</span><span>Tick spacing ${p.tickSpacing}</span>${p.hooks && !/^0x0+$/.test(p.hooks) ? `<span title="${esc(p.hooks)}">Hook ${esc(short(p.hooks))}</span>` : ''}`;
    if (!d) {
      $('#d-kpis').innerHTML = `<div class="kpi"><dt>Estado</dt><dd>${p.err ? esc(p.err) : 'Lendo on-chain…'}</dd></div>`;
      return;
    }
    const kpi = (label, value, sub = '') => `<div class="kpi"><dt>${label}</dt><dd>${value}</dd>${sub ? `<span class="kpi-sub">${sub}</span>` : ''}</div>`;
    const SUP = { '-': '⁻', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };
    const exp = d.L > 0 ? Math.floor(Math.log10(d.L)) : 0;
    const Lfmt = exp >= 6 ? `${F.num(d.L / Math.pow(10, exp), 2)} × 10${String(exp).replace(/./g, (c) => SUP[c])}` : F.num(d.L, 0);
    $('#d-kpis').innerHTML =
      kpi('Preço on-chain', `<span class="mono">${F.num(d.price, 6)}</span>`, `${esc(A.quoteTok(p).sym)} por ${esc(A.baseTok(p).sym)}`) +
      kpi('Desvio do peg', F.bp(d.devBps), p.sig ? sigPill(p.sig.level) : '') +
      kpi('TVL on-chain', isFinite(d.tvl) ? F.usd(d.tvl) : 'calculando…', esc(d.tvlMethod || '')) +
      kpi('Composição', isFinite(d.baseShare) ? `${F.pct(d.baseShare, 1)} ${esc(A.baseTok(p).sym)}` : '—', isFinite(d.baseShare) ? `${F.pct(1 - d.baseShare, 1)} ${esc(A.quoteTok(p).sym)}` : '') +
      kpi('Profundidade ±0,1%', d.depth ? F.usd(d.depth[0.001]) : '…', 'liquidez a até 0,1% do preço') +
      kpi('Profundidade ±0,5%', d.depth ? F.usd(d.depth[0.005]) : '…', 'liquidez a até 0,5% do preço') +
      kpi('Liquidez ativa', `<span class="mono">L ${Lfmt}</span>`, `tick ${new Intl.NumberFormat('pt-BR').format(p.live.tick)}`) +
      kpi(p.chain === 'solana' ? 'Slot lido' : 'Bloco lido', `<span class="mono">${new Intl.NumberFormat('pt-BR').format(p.live.block)}</span>`, new Date(p.livePts.at(-1).t).toLocaleTimeString('pt-BR'));
    priceChart($('#chart-price'), p);
    liqChart($('#chart-liq'), p);
    renderTA(p);
    renderRanges(p);
  }

  function renderTA(p) {
    const d = p.d;
    const t = p.ta;
    const el = $('#ta-card');
    const metric = (k, v, s = '') => `<div class="m"><dt>${k}</dt><dd>${v}${s ? `<span class="m-sub">${s}</span>` : ''}</dd></div>`;
    const histNote = p.histLoading
      ? 'Carregando o histórico horário…'
      : p.histErr
        ? `Histórico indisponível agora (${esc(p.histErr)}). Indicadores on-chain seguem ativos.`
        : p.hist && p.hist.candles && p.hist.candles.length < 48
          ? 'Pouco histórico de negociação nesta pool; os ranges usam pisos mínimos.'
          : '';
    const bp = (x) => F.bp((x - 1) * 1e4);
    let metrics = metric('Desvio agora', F.bp(d.devBps), 'preço on-chain');
    if (t) {
      metrics +=
        metric('Média 7d · 30d', `${bp(t.mean7)} · ${bp(t.mean30)}`) +
        metric('Mín. · máx. 30d', `${bp(t.min)} · ${bp(t.max)}`, 'fechamentos de 1h') +
        metric('Bollinger %B', F.num(t.pctB, 2), '0 = banda inferior, 1 = superior') +
        metric('RSI 14h', F.num(t.rsi, 0), t.rsi >= 70 ? 'sobrecomprado' : t.rsi <= 30 ? 'sobrevendido' : 'neutro') +
        metric('Tendência EMA 12h × 48h', F.bp(t.trendBps, 2)) +
        metric('Volatilidade realizada', `${F.num(t.volBpsH, 2)} bp/h`, `${F.num(t.volAnnual, 2)}% ao ano`) +
        metric('Z-score vs. 30d', F.num(t.z, 2)) +
        metric('Volume 24h · média 7d', `${F.usd(t.vol24)} · ${F.usd(t.vol7d)}`) +
        metric('APR médio da pool', d.feeRate != null && d.tvl > 0 ? F.pct((t.vol24 * d.feeRate * 365) / d.tvl, 2) : '—', 'taxas das últimas 24h ÷ TVL');
    }
    if (d.consensus) metrics += metric('Onde estão os LPs', `${F.num(d.consensus.lo, 5)} – ${F.num(d.consensus.hi, 5)}`, '80% da liquidez próxima');
    const reasons = p.sig ? p.sig.reasons.map((r) => `<li>${ICON[r.lv]}<span>${esc(r.why)}</span></li>`).join('') : '';
    const text = A.narrative(p, d, t, p.rg)
      .map((s) => `<p>${esc(s)}</p>`)
      .join('');
    el.innerHTML = `
      <header class="card-head"><div><h3>Análise técnica</h3><p class="card-sub">${t ? `${t.n} velas de 1h (${F.num(t.spanDays, 0)} dias) + estado on-chain` : 'Estado on-chain'}</p></div>${p.sig ? sigPill(p.sig.level) : ''}</header>
      <ul class="reasons">${reasons}</ul>
      ${histNote ? `<p class="note">${histNote}</p>` : ''}
      <dl class="metrics">${metrics}</dl>
      <div class="reading"><h4>Leitura</h4>${text}</div>`;
  }

  function renderRanges(p) {
    if (!p.rg || !p.d) return;
    const b = A.baseTok(p).sym;
    const q = A.quoteTok(p).sym;
    $('#range-table').innerHTML = `
      <thead><tr><th>Faixa</th><th class="num">Preço mín. – máx.</th><th class="num">Largura</th><th class="num">No range 30d</th><th class="num">Eficiência</th><th class="num">APR est.</th></tr></thead>
      <tbody>${p.rg
        .map(
          (r) => `<tr class="${r.key === 'conservative' ? 'is-rec' : ''}${r.key === state.tier ? ' is-shown' : ''}">
            <td><span class="tier">${r.name}</span>${r.key === 'conservative' ? '<span class="rec">recomendado</span>' : ''}<span class="sub">ticks ${r.tickLower} a ${r.tickUpper}</span></td>
            <td class="num mono">${F.num(r.lo, 5)} – ${F.num(r.hi, 5)}</td>
            <td class="num">${F.num(r.widthBps, 1)} bp</td>
            <td class="num">${r.timeInRange != null ? F.pct(r.timeInRange, 1) : '—'}</td>
            <td class="num">${r.efficiency ? F.num(r.efficiency, 0) + '×' : '—'}</td>
            <td class="num">${r.aprAdj != null ? F.pct(r.aprAdj, 2) : p.dynamicFee ? 'dinâmica' : '—'}</td>
          </tr>`
        )
        .join('')}</tbody>`;
    const cons = p.rg.find((r) => r.key === 'conservative');
    $('#sim-out').innerHTML = cons && cons.deposit
      ? `Para ${F.usd(state.capital)} no range conservador: <strong>${F.num(cons.deposit.base, 2)} ${esc(b)}</strong> + <strong>${F.num(cons.deposit.quote, 2)} ${esc(q)}</strong>. Eficiência de capital é a liquidez gerada por dólar comparada a uma posição full range. O APR estimado aplica sua fatia da liquidez ativa ao volume das últimas 24h e desconta o tempo fora do range nos últimos 30 dias.`
      : 'Aguardando leitura on-chain para simular o depósito.';
  }

  /* ---------------------------------------------------------- gráficos */

  function niceStep(span, n) {
    const raw = span / n;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / mag;
    return (f >= 5 ? 10 : f >= 2 ? 5 : f >= 1 ? 2 : 1) * mag;
  }
  const decimalsFor = (step) => Math.min(7, Math.max(2, Math.ceil(-Math.log10(step) - 1e-9)));
  const dayFmt = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short' });
  const tsFmt = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

  function tooltip(container) {
    let tip = container.querySelector('.tip');
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'tip';
      tip.hidden = true;
      container.appendChild(tip);
    }
    return {
      show(html, x, y) {
        tip.innerHTML = html;
        tip.hidden = false;
        const cw = container.clientWidth;
        const tw = tip.offsetWidth;
        tip.style.left = `${Math.min(cw - tw - 4, Math.max(4, x + 14))}px`;
        tip.style.top = `${Math.max(4, y - tip.offsetHeight - 10)}px`;
      },
      hide() {
        tip.hidden = true;
      },
    };
  }

  function priceChart(el, p) {
    const candles = (p.hist && p.hist.candles) || [];
    const tier = p.rg && p.rg.find((r) => r.key === state.tier);
    if (candles.length < 2) {
      el.innerHTML = `<div class="chart-empty">${p.histLoading ? 'Carregando velas de 1h…' : p.histErr ? 'Histórico indisponível no momento. Os pontos ao vivo aparecerão aqui a cada leitura.' : 'Sem histórico de negociação para esta pool.'}</div>`;
      $('#legend-price').innerHTML = '';
      return;
    }
    const W = Math.max(320, el.clientWidth);
    const H = W < 560 ? 240 : 300;
    const m = { l: 62, r: 14, t: 14, b: 26 };
    const live = p.livePts.filter((x) => x.t > candles[candles.length - 1].t);
    const t0 = candles[0].t;
    const t1 = Math.max(candles[candles.length - 1].t + 3600e3, live.length ? live[live.length - 1].t : 0);
    const boll = (p.ta && p.ta.boll) || [];
    // Domínio robusto: fechamentos fora dos percentis 0,5–99,5 ficam cortados pelo clipPath.
    const sorted = candles.map((c) => c.c).sort((a, b) => a - b);
    const q = (f) => sorted[Math.round((sorted.length - 1) * f)];
    const ys = [1, q(0.005), q(0.995), ...live.map((x) => x.price)];
    if (tier) ys.push(tier.lo, tier.hi);
    let y0 = Math.min(...ys);
    let y1 = Math.max(...ys);
    const pad = Math.max((y1 - y0) * 0.08, 2e-5);
    y0 -= pad;
    y1 += pad;
    const X = (t) => m.l + ((t - t0) / (t1 - t0)) * (W - m.l - m.r);
    const Y = (v) => m.t + (1 - (v - y0) / (y1 - y0)) * (H - m.t - m.b);
    const step = niceStep(y1 - y0, 5);
    const dec = decimalsFor(step);
    let grid = '';
    for (let v = Math.ceil(y0 / step) * step; v <= y1 + 1e-12; v += step) {
      grid += `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" class="grid"/><text x="${m.l - 8}" y="${(Y(v) + 4).toFixed(1)}" class="axis" text-anchor="end">${F.num(v, dec)}</text>`;
    }
    const spanDays = (t1 - t0) / 86400000;
    const every = spanDays > 20 ? 5 : spanDays > 8 ? 2 : 1;
    let xt = '';
    const first = new Date(t0);
    first.setHours(0, 0, 0, 0);
    for (let t = first.getTime() + 86400000; t < t1; t += 86400000 * every) {
      xt += `<line x1="${X(t).toFixed(1)}" x2="${X(t).toFixed(1)}" y1="${H - m.b}" y2="${H - m.b + 4}" class="tick"/><text x="${X(t).toFixed(1)}" y="${H - 6}" class="axis" text-anchor="middle">${dayFmt.format(t).replace('.', '')}</text>`;
    }
    let bandPath = '';
    const bi = boll.map((b, i) => (b ? i : -1)).filter((i) => i >= 0);
    if (bi.length > 1) {
      const up = bi.map((i) => `${X(candles[i].t).toFixed(1)},${Y(boll[i].up).toFixed(1)}`);
      const lo = bi.map((i) => `${X(candles[i].t).toFixed(1)},${Y(boll[i].lo).toFixed(1)}`).reverse();
      bandPath = `<path d="M${up.join('L')}L${lo.join('L')}Z" class="boll"/>`;
    }
    const line = candles.map((c, i) => `${i ? 'L' : 'M'}${X(c.t).toFixed(1)},${Y(c.c).toFixed(1)}`).join('');
    const range = tier
      ? `<rect x="${m.l}" y="${Y(tier.hi).toFixed(1)}" width="${W - m.l - m.r}" height="${Math.max(1, Y(tier.lo) - Y(tier.hi)).toFixed(1)}" class="range-band"/>
         <line x1="${m.l}" x2="${W - m.r}" y1="${Y(tier.hi).toFixed(1)}" y2="${Y(tier.hi).toFixed(1)}" class="range-edge"/>
         <line x1="${m.l}" x2="${W - m.r}" y1="${Y(tier.lo).toFixed(1)}" y2="${Y(tier.lo).toFixed(1)}" class="range-edge"/>
         <text x="${m.l + 8}" y="${(Y(tier.hi) - 5).toFixed(1)}" class="range-label">${tier.name} ${F.num(tier.hi, 5)}</text>
         <text x="${m.l + 8}" y="${(Y(tier.lo) + 13).toFixed(1)}" class="range-label">${F.num(tier.lo, 5)}</text>`
      : '';
    const peg = `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(1).toFixed(1)}" y2="${Y(1).toFixed(1)}" class="peg"/><text x="${W - m.r - 4}" y="${(Y(1) - 5).toFixed(1)}" class="peg-label" text-anchor="end">peg 1,0000</text>`;
    const lastLive = p.livePts[p.livePts.length - 1];
    const liveDots = live.map((x) => `<circle cx="${X(x.t).toFixed(1)}" cy="${Y(x.price).toFixed(1)}" r="2.5" class="live-dot"/>`).join('');
    const endX = X(lastLive.t > t0 ? Math.min(lastLive.t, t1) : t1);
    const end = `<circle cx="${endX.toFixed(1)}" cy="${Y(lastLive.price).toFixed(1)}" r="6" class="live-ring"/><circle cx="${endX.toFixed(1)}" cy="${Y(lastLive.price).toFixed(1)}" r="3.5" class="live-end"/>`;
    const clipId = `clip-${Math.random().toString(36).slice(2, 8)}`;
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Preço de ${esc(pairLabel(p))} nos últimos 30 dias">
      <defs><clipPath id="${clipId}"><rect x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}"/></clipPath></defs>
      ${grid}${xt}<g clip-path="url(#${clipId})">${range}${bandPath}${peg}<path d="${line}" class="price-line"/>${liveDots}${end}</g>
      <line class="cross" x1="0" x2="0" y1="${m.t}" y2="${H - m.b}" visibility="hidden"/><circle class="cross-dot" r="4" visibility="hidden"/>
      <rect x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}" fill="transparent" class="hit"/></svg>`;
    $('#legend-price').innerHTML = `<span><i class="lg lg-line"></i>Fechamento 1h</span><span><i class="lg lg-boll"></i>Bollinger 20h ±2σ</span><span><i class="lg lg-peg"></i>Peg</span>${tier ? `<span><i class="lg lg-range"></i>Range ${tier.name.toLowerCase()}</span>` : ''}<span><i class="lg lg-live"></i>Ao vivo on-chain (${p.livePts.length} leituras)</span>`;

    const svg = el.querySelector('svg');
    const cross = svg.querySelector('.cross');
    const dot = svg.querySelector('.cross-dot');
    const tip = tooltip(el);
    const hit = svg.querySelector('.hit');
    const move = (ev) => {
      const r = svg.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * W;
      const t = t0 + ((px - m.l) / (W - m.l - m.r)) * (t1 - t0);
      const lastC = candles[candles.length - 1];
      if (t > lastC.t + 1800e3 && live.length) {
        const lp = live.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));
        cross.setAttribute('x1', X(lp.t));
        cross.setAttribute('x2', X(lp.t));
        dot.setAttribute('cx', X(lp.t));
        dot.setAttribute('cy', Y(lp.price));
        cross.setAttribute('visibility', 'visible');
        dot.setAttribute('visibility', 'visible');
        tip.show(`<b>Ao vivo · ${new Date(lp.t).toLocaleTimeString('pt-BR')}</b><span>Preço on-chain <em>${F.num(lp.price, 6)}</em></span><span>Desvio <em>${F.bp((lp.price - 1) * 1e4, 2)}</em></span><span>${p.chain === 'solana' ? 'Slot' : 'Bloco'} <em>${new Intl.NumberFormat('pt-BR').format(lp.block)}</em></span>`, (X(lp.t) / W) * r.width, (Y(lp.price) / H) * r.height);
        return;
      }
      let i = Math.round(((t - t0) / (lastC.t - t0)) * (candles.length - 1));
      i = Math.max(0, Math.min(candles.length - 1, i));
      while (i > 0 && candles[i].t > t) i--;
      const c = candles[i];
      const b = boll[i];
      cross.setAttribute('x1', X(c.t));
      cross.setAttribute('x2', X(c.t));
      dot.setAttribute('cx', X(c.t));
      dot.setAttribute('cy', Y(c.c));
      cross.setAttribute('visibility', 'visible');
      dot.setAttribute('visibility', 'visible');
      tip.show(
        `<b>${tsFmt.format(c.t)}</b><span>Fechamento <em>${F.num(c.c, 6)}</em></span><span>Máx. · mín. <em>${F.num(c.h, 5)} · ${F.num(c.l, 5)}</em></span><span>Desvio <em>${F.bp((c.c - 1) * 1e4, 2)}</em></span>${b ? `<span>Bollinger <em>${F.num(b.lo, 5)} – ${F.num(b.up, 5)}</em></span>` : ''}<span>Volume <em>${F.usd(c.v)}</em></span>`,
        (X(c.t) / W) * r.width,
        (Y(c.c) / H) * r.height
      );
    };
    hit.addEventListener('pointermove', move);
    hit.addEventListener('pointerleave', () => {
      cross.setAttribute('visibility', 'hidden');
      dot.setAttribute('visibility', 'hidden');
      tip.hide();
    });
  }

  function liqChart(el, p) {
    const d = p.d;
    const tier = p.rg && p.rg.find((r) => r.key === state.tier);
    if (!d || !d.segs) {
      el.innerHTML = `<div class="chart-empty">${p.scanErr ? `Não foi possível ler os ticks agora (${esc(p.scanErr)}).` : 'Lendo ticks inicializados on-chain…'}</div>`;
      $('#legend-liq').innerHTML = '';
      return;
    }
    const W = Math.max(320, el.clientWidth);
    const H = W < 560 ? 200 : 230;
    const m = { l: 14, r: 14, t: 18, b: 26 };
    const P = d.price;
    const half = Math.max(tier ? ((tier.hi / tier.lo - 1) / 2) * 1.5 : 0, 0.0015, 6e-4 * p.tickSpacing);
    const tA = A.tickFromP01(p, A.fromBQ(p, P * (1 - half)));
    const tB = A.tickFromP01(p, A.fromBQ(p, P * (1 + half)));
    const ts = p.tickSpacing;
    let lo = Math.floor(Math.min(tA, tB) / ts) * ts;
    let hi = Math.ceil(Math.max(tA, tB) / ts) * ts;
    if (p.scan) {
      lo = Math.max(lo, Math.ceil(p.scan.windowLo / ts) * ts);
      hi = Math.min(hi, Math.floor(p.scan.windowHi / ts) * ts);
    }
    const nTicks = Math.max(1, (hi - lo) / ts);
    const per = Math.max(1, Math.ceil(nTicks / 72)) * ts;
    const buckets = [];
    for (let a = lo; a < hi; a += per) {
      const b = Math.min(hi, a + per);
      let mass = 0;
      for (const s of d.segs) {
        const ov = Math.min(s.hi, b) - Math.max(s.lo, a);
        if (ov > 0) mass += s.L * ov;
      }
      const pa = A.toBQ(p, A.p01FromTick(p, a));
      const pb = A.toBQ(p, A.p01FromTick(p, b));
      const am = O.amountsBetween(d.segs, d.sqrt, O.sqrtAtTick(a), O.sqrtAtTick(b));
      buckets.push({ x0: Math.min(pa, pb), x1: Math.max(pa, pb), L: mass / (b - a), val: A.valueQuote(p, d.p01, am.a0, am.a1).total });
    }
    buckets.sort((u, v) => u.x0 - v.x0);
    const maxL = Math.max(...buckets.map((b) => b.L), 1e-9);
    const x0 = buckets[0].x0;
    const x1 = buckets[buckets.length - 1].x1;
    const X = (v) => m.l + ((v - x0) / (x1 - x0)) * (W - m.l - m.r);
    const Yh = (L) => (L / maxL) * (H - m.t - m.b);
    const inR = (b) => tier && (b.x0 + b.x1) / 2 >= tier.lo && (b.x0 + b.x1) / 2 <= tier.hi;
    const bars = buckets
      .map((b, i) => {
        const x = X(b.x0) + 1;
        const w = Math.max(1, X(b.x1) - X(b.x0) - 2);
        const h = Yh(b.L);
        if (h < 0.5) return `<rect data-i="${i}" x="${x.toFixed(1)}" y="${m.t}" width="${w.toFixed(1)}" height="${H - m.t - m.b}" fill="transparent" class="bar-hit"/>`;
        const y = H - m.b - h;
        const r = Math.min(3, w / 2, h);
        const path = `M${x.toFixed(1)},${(H - m.b).toFixed(1)}V${(y + r).toFixed(1)}Q${x.toFixed(1)},${y.toFixed(1)} ${(x + r).toFixed(1)},${y.toFixed(1)}H${(x + w - r).toFixed(1)}Q${(x + w).toFixed(1)},${y.toFixed(1)} ${(x + w).toFixed(1)},${(y + r).toFixed(1)}V${(H - m.b).toFixed(1)}Z`;
        return `<path d="${path}" class="${inR(b) ? 'bar bar-in' : 'bar'}"/><rect data-i="${i}" x="${x.toFixed(1)}" y="${m.t}" width="${w.toFixed(1)}" height="${H - m.t - m.b}" fill="transparent" class="bar-hit"/>`;
      })
      .join('');
    const step = niceStep(x1 - x0, W < 560 ? 3 : 5);
    const dec = decimalsFor(step);
    let axis = '';
    for (let v = Math.ceil(x0 / step) * step; v <= x1; v += step)
      axis += `<line x1="${X(v).toFixed(1)}" x2="${X(v).toFixed(1)}" y1="${H - m.b}" y2="${H - m.b + 4}" class="tick"/><text x="${X(v).toFixed(1)}" y="${H - 6}" class="axis" text-anchor="middle">${F.num(v, dec)}</text>`;
    const edges = tier
      ? [tier.lo, tier.hi]
          .filter((v) => v > x0 && v < x1)
          .map((v) => `<line x1="${X(v).toFixed(1)}" x2="${X(v).toFixed(1)}" y1="${m.t}" y2="${H - m.b}" class="range-edge"/>`)
          .join('')
      : '';
    const now = `<line x1="${X(P).toFixed(1)}" x2="${X(P).toFixed(1)}" y1="${m.t - 6}" y2="${H - m.b}" class="now-line"/><text x="${X(P).toFixed(1)}" y="${m.t - 8}" class="now-label" text-anchor="${X(P) > W - 90 ? 'end' : X(P) < 90 ? 'start' : 'middle'}">preço ${F.num(P, 5)}</text>`;
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Distribuição de liquidez ao redor do preço atual">
      <line x1="${m.l}" x2="${W - m.r}" y1="${H - m.b}" y2="${H - m.b}" class="baseline"/>${bars}${edges}${now}${axis}</svg>`;
    $('#liq-sub').textContent = `Liquidez ativa (L) por faixa de preço, ${p.scan.ticks.length} ticks inicializados lidos ${p.chain === 'solana' ? `em ${p.scan.arrays} tick arrays` : 'do tickBitmap'}`;
    $('#legend-liq').innerHTML = `<span><i class="lg lg-bar-in"></i>Dentro do range ${tier ? tier.name.toLowerCase() : ''}</span><span><i class="lg lg-bar"></i>Fora do range</span><span><i class="lg lg-now"></i>Preço atual</span>`;
    const tip = tooltip(el);
    const svg = el.querySelector('svg');
    svg.querySelectorAll('.bar-hit').forEach((r) => {
      r.addEventListener('pointerenter', () => {
        const b = buckets[+r.dataset.i];
        const box = svg.getBoundingClientRect();
        const cx = ((X(b.x0) + X(b.x1)) / 2 / W) * box.width;
        tip.show(`<b>${F.num(b.x0, 5)} – ${F.num(b.x1, 5)}</b><span>Liquidez relativa <em>${F.pct(b.L / maxL, 0)}</em></span><span>Valor na faixa <em>${F.usd(b.val)}</em></span>`, cx, ((H - m.b - Yh(b.L)) / H) * box.height);
      });
      r.addEventListener('pointerleave', () => tip.hide());
    });
  }

  /* ----------------------------------------------------------- eventos */

  function bind() {
    $('#btn-refresh').addEventListener('click', () => refresh());
    $('#btn-showall').addEventListener('click', () => {
      state.showAll = !state.showAll;
      renderTable();
    });
    document.querySelectorAll('[data-filter]').forEach((b) =>
      b.addEventListener('click', () => {
        const [k, v] = b.dataset.filter.split(':');
        state.filter[k] = v;
        savePrefs();
        scheduleRender();
        requestHistories();
      })
    );
    const body = $('#rank-body');
    body.addEventListener('click', (ev) => {
      const tr = ev.target.closest('tr[data-key]');
      if (tr) selectPool(tr.dataset.key);
    });
    body.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      const tr = ev.target.closest('tr[data-key]');
      if (tr) {
        ev.preventDefault();
        selectPool(tr.dataset.key);
      }
    });
    // Configuração de RPC
    const custom = O.customRpcs();
    const form = $('#rpc-form');
    form.innerHTML =
      Object.entries(CHAINS)
        .map(
          ([k, c]) => `<label for="rpc-${k}">${c.name}</label><input id="rpc-${k}" type="url" placeholder="${esc(c.rpcs[0])}" value="${esc(custom[k] || '')}" spellcheck="false"><p class="small muted">Padrões: ${c.rpcs.map((u) => esc(new URL(u).host)).join(', ')}</p>`
        )
        .join('') + '<div class="rpc-actions"><button type="submit">Salvar e reler</button><span id="rpc-msg" class="small muted" role="status"></span></div>';
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const obj = {};
      for (const k of Object.keys(CHAINS)) {
        const v = $(`#rpc-${k}`).value.trim();
        if (v) {
          try {
            new URL(v);
            obj[k] = v;
          } catch (e) {
            $('#rpc-msg').textContent = `Endereço inválido para ${CHAINS[k].name}.`;
            return;
          }
        }
      }
      O.saveCustomRpcs(obj);
      $('#rpc-msg').textContent = 'RPCs salvos neste navegador. Relendo…';
      refresh();
    });
    O.onHealth(() => scheduleRender());
    let rz;
    addEventListener('resize', () => {
      clearTimeout(rz);
      rz = setTimeout(() => {
        const p = selected();
        if (p && p.d) {
          priceChart($('#chart-price'), p);
          liqChart($('#chart-liq'), p);
        }
      }, 150);
    });
    setInterval(() => {
      updateCountdown();
      if (!state.busy && state.nextAt && Date.now() >= state.nextAt && !document.hidden) refresh();
    }, 1000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && state.nextAt && Date.now() >= state.nextAt) refresh();
    });
  }

  bind();
  scheduleRender();
  refresh();
})();
