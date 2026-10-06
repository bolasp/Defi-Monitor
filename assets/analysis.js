/*
 * Métricas derivadas do estado on-chain, análise técnica sobre o histórico
 * horário (30 dias) e cálculo dos ranges.
 *
 * Convenção de preço: sempre "base em quote", em que quote é o token âncora
 * (USDC > USDT > USDS > DAI > PYUSD > USDG). Para um par de stablecoins o peg
 * é 1,0000 e o desvio é medido em pontos-base (1 bp = 0,01%).
 */
(function () {
  const { amountsBetween, buildSegments, sqrtAtTick } = window.Onchain;

  const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
  const stdev = (a) => {
    if (a.length < 2) return 0;
    const m = mean(a);
    return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
  };
  const quantile = (a, q) => {
    if (!a.length) return NaN;
    const s = [...a].sort((x, y) => x - y);
    const pos = (s.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return s[lo] + (s[hi] - s[lo]) * (pos - lo);
  };
  const median = (a) => quantile(a, 0.5);
  function emaSeries(a, n) {
    const k = 2 / (n + 1);
    const out = [];
    let e = a[0];
    for (let i = 0; i < a.length; i++) {
      e = i === 0 ? a[0] : a[i] * k + e * (1 - k);
      out.push(e);
    }
    return out;
  }

  /* ----------------------------------------------- conversões de preço */

  const decShift = (p) => Math.pow(10, p.token0.dec - p.token1.dec);
  const p01FromTick = (p, t) => Math.pow(1.0001, t) * decShift(p);
  const tickFromP01 = (p, x) => Math.log(x / decShift(p)) / Math.log(1.0001);
  const toBQ = (p, p01) => (p.quote === 1 ? p01 : 1 / p01);
  const fromBQ = (p, bq) => (p.quote === 1 ? bq : 1 / bq);
  const baseTok = (p) => (p.base === 0 ? p.token0 : p.token1);
  const quoteTok = (p) => (p.quote === 0 ? p.token0 : p.token1);

  function sqrtRaw(p, live) {
    if (p.proto === 'orca') return Number(live.sqrtPriceX64) / 2 ** 64;
    return Number(live.sqrtPriceX96) / 2 ** 96;
  }

  // Valor (em unidades do token quote) de quantidades brutas de token0/token1.
  function valueQuote(p, p01, a0raw, a1raw) {
    const a0 = a0raw / Math.pow(10, p.token0.dec);
    const a1 = a1raw / Math.pow(10, p.token1.dec);
    const v0 = p.quote === 1 ? a0 * p01 : a0;
    const v1 = p.quote === 1 ? a1 : a1 / p01;
    return { a0, a1, v0, v1, total: v0 + v1 };
  }

  /* ------------------------------------------------ estado on-chain */

  function derive(p, live, scan) {
    const s = sqrtRaw(p, live);
    const p01 = s * s * decShift(p);
    const price = toBQ(p, p01);
    let segs = null;
    if (scan) segs = buildSegments(scan.ticks, live.tick, live.liquidity);
    let raw0;
    let raw1;
    let tvlMethod;
    if (live.raw0 != null && live.raw1 != null) {
      raw0 = Number(live.raw0);
      raw1 = Number(live.raw1);
      tvlMethod = p.proto === 'orca' ? 'saldo dos vaults SPL' : 'saldo ERC-20 da pool';
    } else if (segs) {
      const am = amountsBetween(segs, s);
      raw0 = am.a0;
      raw1 = am.a1;
      tvlMethod = 'liquidez integrada por tick (PoolManager)';
    }
    const out = { sqrt: s, p01, price, devBps: (price - 1) * 1e4, segs, tvlMethod };
    if (raw0 != null) {
      const v = valueQuote(p, p01, raw0, raw1);
      out.amount0 = v.a0;
      out.amount1 = v.a1;
      out.tvl = v.total;
      out.baseShare = v.total > 0 ? (p.base === 0 ? v.v0 : v.v1) / v.total : NaN;
    }
    const feeUnits = p.proto === 'v3' ? p.fee : live.lpFee;
    out.feeRate = p.dynamicFee && !feeUnits ? null : feeUnits / 1e6;
    out.L = Number(live.liquidity);
    if (segs) {
      out.depth = {};
      for (const x of [0.001, 0.005]) {
        const am = amountsBetween(segs, s, s * Math.sqrt(1 - x), s * Math.sqrt(1 + x));
        out.depth[x] = valueQuote(p, p01, am.a0, am.a1).total;
      }
      out.consensus = consensusBand(p, segs, live.tick);
    }
    return out;
  }

  // Menor faixa ao redor do preço que concentra 80% da liquidez (L x ticks) próxima.
  function consensusBand(p, segs, tick) {
    const ts = p.tickSpacing;
    const radius = 300 * ts;
    const lo = tick - radius;
    const hi = tick + radius;
    const cells = [];
    for (let t = Math.floor(lo / ts) * ts; t < hi; t += ts) cells.push({ t, m: 0 });
    let si = 0;
    for (const c of cells) {
      while (si < segs.length && segs[si].hi <= c.t) si++;
      if (si < segs.length && segs[si].lo <= c.t) c.m = segs[si].L;
    }
    const total = cells.reduce((s, c) => s + c.m, 0);
    if (!total) return null;
    let i = cells.findIndex((c) => c.t + ts > tick);
    if (i < 0) return null;
    let j = i;
    let acc = cells[i].m;
    while (acc < total * 0.8 && (i > 0 || j < cells.length - 1)) {
      const left = i > 0 ? cells[i - 1].m : -1;
      const right = j < cells.length - 1 ? cells[j + 1].m : -1;
      if (left >= right) acc += cells[--i].m;
      else acc += cells[++j].m;
    }
    const a = toBQ(p, p01FromTick(p, cells[i].t));
    const b = toBQ(p, p01FromTick(p, cells[j].t + ts));
    return { lo: Math.min(a, b), hi: Math.max(a, b), share: acc / total };
  }

  /* ------------------------------------------------- análise técnica */

  function technical(candles, priceNow) {
    if (!candles || candles.length < 48) return null;
    const closes = candles.map((c) => c.c);
    const highs = candles.map((c) => c.h);
    const lows = candles.map((c) => c.l);
    const n = closes.length;

    const boll = closes.map((_, i) => {
      if (i < 19) return null;
      const w = closes.slice(i - 19, i + 1);
      const m = mean(w);
      const sd = stdev(w);
      return { m, up: m + 2 * sd, lo: m - 2 * sd };
    });

    let gain = 0;
    let loss = 0;
    for (let i = 1; i <= 14; i++) {
      const d = closes[i] - closes[i - 1];
      if (d > 0) gain += d;
      else loss -= d;
    }
    gain /= 14;
    loss /= 14;
    for (let i = 15; i < n; i++) {
      const d = closes[i] - closes[i - 1];
      gain = (gain * 13 + Math.max(d, 0)) / 14;
      loss = (loss * 13 + Math.max(-d, 0)) / 14;
    }
    const rsi = loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss);

    const rets = [];
    for (let i = 1; i < n; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
    const volH = stdev(rets);

    const e12 = emaSeries(closes, 12);
    const e48 = emaSeries(closes, 48);
    const trendBps = ((e12[n - 1] - e48[n - 1]) / e48[n - 1]) * 1e4;

    // Pavios de velas de stablecoin trazem ruído (swaps de poeira, rotas multi-hop),
    // por isso extremos e dispersão saem dos fechamentos, com desvio robusto (MAD).
    const mean30 = mean(closes);
    const med30 = median(closes);
    const sd30 = 1.4826 * median(closes.map((x) => Math.abs(x - med30)));
    const last7 = closes.slice(-168);
    const lastBoll = boll[n - 1];
    const vols = candles.map((c) => c.v || 0);
    const vol24 = vols.slice(-24).reduce((s, x) => s + x, 0);
    const days = Math.min(7, n / 24);
    const vol7d = vols.slice(-168).reduce((s, x) => s + x, 0) / days;

    return {
      n,
      closes,
      boll,
      rsi,
      volBpsH: volH * 1e4,
      volAnnual: volH * Math.sqrt(8760) * 100,
      trendBps,
      mean30,
      sd30,
      mean7: mean(last7),
      median7: median(last7),
      min: Math.min(...closes),
      max: Math.max(...closes),
      p005: quantile(closes, 0.005),
      p995: quantile(closes, 0.995),
      wickMin: quantile(lows, 0.02),
      wickMax: quantile(highs, 0.98),
      z: sd30 > 0 ? (priceNow - med30) / sd30 : 0,
      pctB: lastBoll && lastBoll.up > lastBoll.lo ? (priceNow - lastBoll.lo) / (lastBoll.up - lastBoll.lo) : 0.5,
      vol24,
      vol7d,
      spanDays: (candles[n - 1].t - candles[0].t) / 86400000,
    };
  }

  /* --------------------------------------------------------- sinal */

  const LEVEL = { ok: 0, warn: 1, crit: 2 };
  function signal(p, d, t) {
    const reasons = [];
    let level = 'ok';
    const raise = (lv, why) => {
      if (LEVEL[lv] > LEVEL[level]) level = lv;
      reasons.push({ lv, why });
    };
    const dev = Math.abs(d.devBps);
    const b = baseTok(p).sym;
    const q = quoteTok(p).sym;
    if (dev >= 50) raise('crit', `Preço ${fmtBp(d.devBps)} fora do peg`);
    else if (dev >= 15) raise('warn', `Preço ${fmtBp(d.devBps)} fora do peg`);
    const skew = isFinite(d.baseShare) ? Math.max(d.baseShare, 1 - d.baseShare) : 0;
    const heavy = d.baseShare >= 0.5 ? b : q;
    if (skew >= 0.9 && dev >= 20) raise('crit', `Pool ${Math.round(skew * 100)}% em ${heavy} com o preço deslocado`);
    else if (skew >= 0.9 && dev >= 5) raise('warn', `Pool ${Math.round(skew * 100)}% em ${heavy}: pressão vendedora em ${heavy}`);
    if (t) {
      if (Math.abs(t.z) >= 3 && dev >= 3) raise('warn', `Preço a ${t.z.toFixed(1).replace('.', ',')}σ da média de 30 dias`);
      if (t.volBpsH >= 5) raise('warn', `Volatilidade alta para um par estável (${t.volBpsH.toFixed(1).replace('.', ',')} bp/h)`);
      if ((t.rsi >= 80 || t.rsi <= 20) && dev >= 3) raise('warn', `RSI em ${Math.round(t.rsi)}: movimento esticado`);
    }
    if (!reasons.length) reasons.push({ lv: 'ok', why: dev < 5 ? 'Preço colado no peg' : 'Desvio dentro do esperado' });
    return { level, reasons };
  }

  /* -------------------------------------------------------- ranges */

  const TIERS = [
    { key: 'narrow', name: 'Estreito', note: 'referência; sai do range com facilidade' },
    { key: 'conservative', name: 'Conservador', note: 'recomendado' },
    { key: 'wide', name: 'Amplo', note: 'proteção contra desvios raros' },
  ];

  function ranges(p, d, t, capital = 10000) {
    const P = d.price;
    const tickRel = 1e-4 * p.tickSpacing;
    const center = t ? t.median7 : P;
    const sig = t ? t.sd30 / center : 0;
    const ext = t ? Math.max(center - t.p005, t.p995 - center) / center : 0;
    const extRaw = t ? Math.max(center - t.min, t.max - center) / center : 0;
    const hwNarrow = Math.max(2 * sig, 2 * tickRel, 0.0002);
    const hwCons = Math.max(4 * sig, 1.25 * ext, 5 * tickRel, 0.001);
    const hwWide = Math.max(8 * sig, 1.5 * extRaw, 2 * hwCons, 0.005);
    const hw = { narrow: hwNarrow, conservative: hwCons, wide: hwWide };
    const margin = Math.max(tickRel, 0.0001);

    return TIERS.map((tier) => {
      let lo = Math.min(center * (1 - hw[tier.key]), P * (1 - margin));
      let hi = Math.max(center * (1 + hw[tier.key]), P * (1 + margin));
      const tA = tickFromP01(p, fromBQ(p, lo));
      const tB = tickFromP01(p, fromBQ(p, hi));
      const ts = p.tickSpacing;
      const tickLower = Math.floor(Math.min(tA, tB) / ts) * ts;
      let tickUpper = Math.ceil(Math.max(tA, tB) / ts) * ts;
      if (tickUpper <= tickLower) tickUpper = tickLower + ts;
      const pa = toBQ(p, p01FromTick(p, tickLower));
      const pb = toBQ(p, p01FromTick(p, tickUpper));
      lo = Math.min(pa, pb);
      hi = Math.max(pa, pb);

      const r = { ...tier, lo, hi, tickLower, tickUpper, widthBps: (hi / lo - 1) * 1e4 };
      r.inRangeNow = P >= lo && P <= hi;
      if (t) {
        const c = t.closes;
        r.timeInRange = c.filter((x) => x >= lo && x <= hi).length / c.length;
      }
      const sP = Math.sqrt(P);
      r.efficiency = r.inRangeNow ? (2 * sP) / (2 * sP - Math.sqrt(lo) - P / Math.sqrt(hi)) : null;

      // Divisão do capital simulado e participação estimada nas taxas.
      const s01 = Math.sqrt(d.p01);
      const sa = Math.sqrt(p01FromTick(p, tickLower));
      const sb = Math.sqrt(p01FromTick(p, tickUpper));
      const capital1 = p.quote === 1 ? capital : capital * d.p01;
      if (r.inRangeNow) {
        const Lh = capital1 / (2 * s01 - sa - d.p01 / sb);
        const amt0 = Lh * (1 / s01 - 1 / sb);
        const amt1 = Lh * (s01 - sa);
        r.deposit = p.base === 0 ? { base: amt0, quote: amt1 } : { base: amt1, quote: amt0 };
        const Lraw = Lh * Math.pow(10, (p.token0.dec + p.token1.dec) / 2);
        const vol = t ? t.vol24 : null;
        if (d.feeRate != null && vol != null && d.L >= 0) {
          const share = Lraw / (d.L + Lraw);
          const feesDay = vol * d.feeRate * share;
          r.apr = (feesDay * 365) / capital;
          r.aprAdj = r.timeInRange != null ? r.apr * r.timeInRange : r.apr;
        }
      }
      return r;
    });
  }

  /* ------------------------------------------------------ leitura */

  function narrative(p, d, t, rg) {
    const b = baseTok(p).sym;
    const q = quoteTok(p).sym;
    const out = [];
    out.push(
      `Preço on-chain de ${fmtNum(d.price, 6)} ${q} por ${b} (${fmtBp(d.devBps)} em relação ao peg).` +
        (t ? ` A média de 30 dias é ${fmtNum(t.mean30, 6)} e o desvio típico do preço (robusto, por MAD) é de ${fmtNum((t.sd30 / t.mean30) * 1e4, 2)} bp.` : '')
    );
    if (t) {
      const bandPos = t.pctB > 1 ? 'acima da banda superior' : t.pctB < 0 ? 'abaixo da banda inferior' : t.pctB > 0.8 ? 'perto da banda superior' : t.pctB < 0.2 ? 'perto da banda inferior' : 'no meio das bandas';
      const trend = Math.abs(t.trendBps) < Math.max(0.3, ((t.sd30 / t.mean30) * 1e4) / 4) ? 'lateral' : t.trendBps > 0 ? `de alta para ${b}` : `de baixa para ${b}`;
      out.push(
        `O preço está ${bandPos} de Bollinger (20h, 2σ), com RSI de 14h em ${Math.round(t.rsi)} e tendência ${trend} pelas médias móveis de 12h e 48h.`
      );
    }
    if (isFinite(d.baseShare)) {
      const heavy = d.baseShare >= 0.5 ? b : q;
      const pct = Math.round(Math.max(d.baseShare, 1 - d.baseShare) * 100);
      out.push(
        pct >= 75
          ? `A pool está ${pct}% em ${heavy}: houve mais venda de ${heavy} contra a pool, o que tende a puxar o preço de ${heavy} levemente para baixo.`
          : `A composição está equilibrada (${pct}% no lado maior), sem pressão relevante de um dos tokens.`
      );
    }
    const cons = rg && rg.find((r) => r.key === 'conservative');
    if (cons) {
      out.push(
        `O range conservador vai de ${fmtNum(cons.lo, 5)} a ${fmtNum(cons.hi, 5)} (${fmtNum(cons.widthBps, 1)} bp de largura)` +
          (cons.timeInRange != null ? ` e teria mantido o preço dentro em ${fmtPct(cons.timeInRange, 1)} das horas dos últimos 30 dias.` : '.')
      );
    }
    return out;
  }

  /* --------------------------------------------------- formatação */

  const nf = (d) => new Intl.NumberFormat('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
  function fmtNum(x, d = 2) {
    return isFinite(x) ? nf(d).format(x) : '—';
  }
  function fmtBp(x, d = 1) {
    if (!isFinite(x)) return '—';
    const v = Math.abs(x) < 0.05 ? 0 : x;
    return `${v > 0 ? '+' : v < 0 ? '−' : ''}${nf(d).format(Math.abs(v))} bp`;
  }
  function fmtPct(x, d = 1) {
    return isFinite(x) ? `${nf(d).format(x * 100)}%` : '—';
  }
  function fmtUsd(x) {
    if (!isFinite(x)) return '—';
    const a = Math.abs(x);
    if (a >= 1e9) return `US$ ${nf(2).format(x / 1e9)} bi`;
    if (a >= 1e6) return `US$ ${nf(a >= 1e8 ? 1 : 2).format(x / 1e6)} mi`;
    if (a >= 1e3) return `US$ ${nf(1).format(x / 1e3)} mil`;
    return `US$ ${nf(0).format(x)}`;
  }
  function fmtFee(p, d) {
    if (p.dynamicFee) return d && d.feeRate ? `${fmtNum(d.feeRate * 100, 4)}% (dinâmica)` : 'dinâmica (hook)';
    const units = d && d.feeRate != null ? d.feeRate * 1e6 : p.fee;
    const pct = units / 1e4;
    return `${new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 4 }).format(pct)}%`;
  }

  window.Analysis = {
    derive,
    technical,
    signal,
    ranges,
    narrative,
    TIERS,
    toBQ,
    fromBQ,
    p01FromTick,
    tickFromP01,
    baseTok,
    quoteTok,
    valueQuote,
    sqrtAtTick,
    fmt: { num: fmtNum, bp: fmtBp, pct: fmtPct, usd: fmtUsd, fee: fmtFee },
  };
})();
