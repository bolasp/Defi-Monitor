/*
 * Leitura on-chain direto do navegador, sem backend:
 *  - EVM (Ethereum/Polygon): JSON-RPC público + Multicall3 (aggregate3).
 *    Uniswap v3 lê slot0/liquidity/tickBitmap/ticks no contrato da pool;
 *    Uniswap v4 lê o PoolManager pelo StateView (getSlot0, getLiquidity,
 *    getTickBitmap, getTickLiquidity).
 *  - Solana: getMultipleAccounts nas contas Whirlpool, nos vaults SPL e nos
 *    tick arrays (endereços PDA derivados aqui mesmo).
 *  - Histórico OHLCV (para análise técnica): GeckoTerminal, que indexa os
 *    swaps on-chain dessas mesmas pools.
 */
(function () {
  const { CHAINS } = window.RADAR_CONFIG;

  const MIN_TICK = -887272;
  const MAX_TICK = 887272;
  const LS_RPC = 'radar.rpc.v1';
  const LS_GT = 'radar.gt.v2:';

  const SEL = {
    slot0: '0x3850c7bd',
    liquidity: '0x1a686502',
    balanceOf: '0x70a08231',
    tickBitmap: '0x5339c296',
    ticks: '0xf30dba93',
    getSlot0: '0xc815641c',
    getLiquidity: '0xfa6793d5',
    getTickBitmap: '0x1c7ccb4c',
    getTickLiquidity: '0xcaedab54',
    aggregate3: '0x82ad56cb',
  };

  /* ---------------------------------------------------------------- RPC */

  const health = {};
  const healthListeners = new Set();
  function setHealth(chain, patch) {
    health[chain] = { ...(health[chain] || {}), ...patch, at: Date.now() };
    healthListeners.forEach((fn) => fn(chain, health[chain]));
  }

  function customRpcs() {
    try {
      return JSON.parse(localStorage.getItem(LS_RPC) || '{}') || {};
    } catch (e) {
      return {};
    }
  }
  function saveCustomRpcs(obj) {
    try {
      localStorage.setItem(LS_RPC, JSON.stringify(obj));
    } catch (e) {
      /* armazenamento indisponível: segue com os padrões */
    }
  }
  function rpcList(chain) {
    const custom = (customRpcs()[chain] || '').trim();
    const base = CHAINS[chain].rpcs;
    return custom ? [custom, ...base.filter((u) => u !== custom)] : base;
  }

  // Limita chamadas simultâneas por rede para não estourar rate limit dos RPCs públicos.
  const gates = {};
  async function gated(chain, fn) {
    const g = (gates[chain] = gates[chain] || { n: 0, q: [] });
    if (g.n >= 4) await new Promise((r) => g.q.push(r));
    g.n++;
    try {
      return await fn();
    } finally {
      g.n--;
      const next = g.q.shift();
      if (next) next();
    }
  }

  async function postJson(url, body, timeoutMs) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  const cursor = {};
  let rpcId = 0;
  async function rpc(chain, method, params, timeoutMs = 20000) {
    return gated(chain, async () => {
      const list = rpcList(chain);
      const start = cursor[chain] || 0;
      let lastErr;
      for (let i = 0; i < list.length; i++) {
        const idx = (start + i) % list.length;
        const url = list[idx];
        const t0 = performance.now();
        try {
          const j = await postJson(url, { jsonrpc: '2.0', id: ++rpcId, method, params }, timeoutMs);
          if (j.error) throw new Error(j.error.message || 'erro no RPC');
          cursor[chain] = idx;
          setHealth(chain, { ok: true, url, ms: Math.round(performance.now() - t0), err: null });
          return j.result;
        } catch (e) {
          lastErr = e;
        }
      }
      setHealth(chain, { ok: false, err: lastErr && lastErr.name === 'AbortError' ? 'tempo esgotado' : String((lastErr && lastErr.message) || lastErr) });
      throw lastErr;
    });
  }

  /* ---------------------------------------------------------------- ABI */

  const strip = (h) => (h.startsWith('0x') ? h.slice(2) : h);
  const encUint = (n) => BigInt(n).toString(16).padStart(64, '0');
  const encInt = (n) => {
    let b = BigInt(n);
    if (b < 0n) b += 1n << 256n;
    return b.toString(16).padStart(64, '0');
  };
  const encAddr = (a) => strip(a).toLowerCase().padStart(64, '0');
  const word = (h, i) => h.slice(i * 64, i * 64 + 64);
  const u256 = (w) => BigInt('0x' + (w || '0'));
  const i256 = (w) => {
    let v = u256(w);
    if (v >= 1n << 255n) v -= 1n << 256n;
    return v;
  };

  function encodeAggregate3(calls) {
    const elems = calls.map((c) => {
      const d = strip(c.data);
      const padded = d.padEnd(Math.ceil(d.length / 64) * 64, '0');
      return encAddr(c.target) + encUint(1) + encUint(96) + encUint(d.length / 2) + padded;
    });
    let offsets = '';
    let off = 32 * calls.length;
    for (const e of elems) {
      offsets += encUint(off);
      off += e.length / 2;
    }
    return SEL.aggregate3 + encUint(32) + encUint(calls.length) + offsets + elems.join('');
  }

  function decodeAggregate3(hex) {
    const h = strip(hex);
    const W = (i) => word(h, i);
    const arr = Number(u256(W(0))) / 32;
    const n = Number(u256(W(arr)));
    const base = arr + 1;
    const out = [];
    for (let i = 0; i < n; i++) {
      const e = base + Number(u256(W(base + i))) / 32;
      const success = u256(W(e)) === 1n;
      const d = e + Number(u256(W(e + 1))) / 32;
      const len = Number(u256(W(d)));
      out.push({ success, data: h.slice((d + 1) * 64, (d + 1) * 64 + len * 2) });
    }
    return out;
  }

  async function multicall(chain, calls, chunk = 200) {
    const target = CHAINS[chain].multicall;
    const batches = [];
    for (let i = 0; i < calls.length; i += chunk) batches.push(calls.slice(i, i + chunk));
    const results = await Promise.all(
      batches.map((b) => rpc(chain, 'eth_call', [{ to: target, data: encodeAggregate3(b) }, 'latest']).then(decodeAggregate3))
    );
    return results.flat();
  }

  /* ---------------------------------------------------- Uniswap v3 / v4 */

  async function readEvmPools(chain, pools) {
    const c = CHAINS[chain];
    const calls = [];
    for (const p of pools) {
      if (p.proto === 'v3') {
        calls.push({ target: p.address, data: SEL.slot0 });
        calls.push({ target: p.address, data: SEL.liquidity });
        calls.push({ target: p.token0.addr, data: SEL.balanceOf + encAddr(p.address) });
        calls.push({ target: p.token1.addr, data: SEL.balanceOf + encAddr(p.address) });
      } else {
        calls.push({ target: c.stateView, data: SEL.getSlot0 + strip(p.address) });
        calls.push({ target: c.stateView, data: SEL.getLiquidity + strip(p.address) });
      }
    }
    const [res, head] = await Promise.all([multicall(chain, calls), rpc(chain, 'eth_blockNumber', [])]);
    setHealth(chain, { head: parseInt(head, 16), headLabel: 'bloco' });
    const out = {};
    let k = 0;
    for (const p of pools) {
      if (p.proto === 'v3') {
        const [s0, l, b0, b1] = [res[k++], res[k++], res[k++], res[k++]];
        if (!s0.success || !l.success || !b0.success || !b1.success) {
          out[p.key] = { error: 'chamada on-chain falhou' };
          continue;
        }
        out[p.key] = {
          sqrtPriceX96: u256(word(s0.data, 0)),
          tick: Number(i256(word(s0.data, 1))),
          liquidity: u256(word(l.data, 0)),
          lpFee: p.fee,
          raw0: u256(word(b0.data, 0)),
          raw1: u256(word(b1.data, 0)),
          block: parseInt(head, 16),
        };
      } else {
        const [s0, l] = [res[k++], res[k++]];
        if (!s0.success || !l.success || u256(word(s0.data, 0)) === 0n) {
          out[p.key] = { error: 'pool não inicializada ou chamada falhou' };
          continue;
        }
        out[p.key] = {
          sqrtPriceX96: u256(word(s0.data, 0)),
          tick: Number(i256(word(s0.data, 1))),
          lpFee: Number(u256(word(s0.data, 3))),
          liquidity: u256(word(l.data, 0)),
          block: parseInt(head, 16),
        };
      }
    }
    return out;
  }

  // Varre o tickBitmap em ±words palavras ao redor do tick atual e lê o liquidityNet de cada tick inicializado.
  async function scanTicksEvm(chain, p, tick, tickRadius = 10000) {
    const c = CHAINS[chain];
    const ts = p.tickSpacing;
    const wordsEachSide = Math.min(80, Math.ceil(tickRadius / (256 * ts)));
    const w0 = Math.floor(tick / ts) >> 8;
    const minW = Math.floor(MIN_TICK / ts) >> 8;
    const maxW = Math.floor(MAX_TICK / ts) >> 8;
    const ws = [];
    for (let w = w0 - wordsEachSide; w <= w0 + wordsEachSide; w++) if (w >= minW && w <= maxW) ws.push(w);
    const bmCalls = ws.map((w) =>
      p.proto === 'v3'
        ? { target: p.address, data: SEL.tickBitmap + encInt(w) }
        : { target: c.stateView, data: SEL.getTickBitmap + strip(p.address) + encInt(w) }
    );
    const bm = await multicall(chain, bmCalls, 250);
    const ticks = [];
    bm.forEach((r, i) => {
      if (!r.success) return;
      const h = word(r.data, 0);
      if (!/[1-9a-f]/.test(h)) return;
      for (let j = 0; j < 64; j++) {
        const nib = parseInt(h[j], 16);
        if (!nib) continue;
        for (let q = 0; q < 4; q++) {
          if (nib & (1 << q)) ticks.push((ws[i] * 256 + (63 - j) * 4 + q) * ts);
        }
      }
    });
    ticks.sort((a, b) => a - b);
    const tCalls = ticks.map((t) =>
      p.proto === 'v3'
        ? { target: p.address, data: SEL.ticks + encInt(t) }
        : { target: c.stateView, data: SEL.getTickLiquidity + strip(p.address) + encInt(t) }
    );
    const tr = tCalls.length ? await multicall(chain, tCalls, 200) : [];
    return {
      ticks: ticks.map((t, i) => ({ tick: t, net: tr[i] && tr[i].success ? i256(word(tr[i].data, 1)) : 0n })),
      windowLo: Math.max(MIN_TICK, ws[0] * 256 * ts),
      windowHi: Math.min(MAX_TICK, (ws[ws.length - 1] + 1) * 256 * ts - 1),
      centerTick: tick,
      at: Date.now(),
    };
  }

  /* -------------------------------------------- matemática de liquidez */

  const sqrtAtTick = (t) => Math.pow(1.0001, t / 2);

  // Intervalos de liquidez constante entre ticks inicializados, a partir da liquidez ativa atual.
  function buildSegments(ticks, currentTick, liquidity) {
    const n = ticks.length;
    let idx = ticks.findIndex((t) => t.tick > currentTick);
    if (idx === -1) idx = n;
    const bounds = [MIN_TICK, ...ticks.map((t) => t.tick), MAX_TICK];
    const Ls = new Array(n + 1);
    const L0 = BigInt(liquidity);
    Ls[idx] = L0;
    let cur = L0;
    for (let i = idx + 1; i <= n; i++) {
      cur += ticks[i - 1].net;
      Ls[i] = cur;
    }
    cur = L0;
    for (let i = idx - 1; i >= 0; i--) {
      cur -= ticks[i].net;
      Ls[i] = cur;
    }
    const segs = [];
    for (let i = 0; i <= n; i++) {
      const lo = bounds[i];
      const hi = bounds[i + 1];
      if (hi <= lo) continue;
      segs.push({ lo, hi, sLo: sqrtAtTick(lo), sHi: sqrtAtTick(hi), L: Ls[i] > 0n ? Number(Ls[i]) : 0 });
    }
    return segs;
  }

  // Quantidade bruta de token0/token1 entre os preços (raiz, unidade bruta) sA e sB.
  function amountsBetween(segs, sqrtP, sA = 0, sB = Infinity) {
    let a0 = 0;
    let a1 = 0;
    for (const s of segs) {
      if (!s.L) continue;
      const lo = Math.max(s.sLo, sA);
      const hi = Math.min(s.sHi, sB);
      if (hi <= lo) continue;
      const uLo = Math.max(lo, sqrtP);
      if (hi > uLo) a0 += s.L * (1 / uLo - 1 / hi);
      const dHi = Math.min(hi, sqrtP);
      if (dHi > lo) a1 += s.L * (dHi - lo);
    }
    return { a0, a1 };
  }

  /* ------------------------------------------------------------ Solana */

  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  function b58encode(bytes) {
    let n = 0n;
    for (const x of bytes) n = n * 256n + BigInt(x);
    let s = '';
    while (n > 0n) {
      s = B58[Number(n % 58n)] + s;
      n /= 58n;
    }
    for (const x of bytes) {
      if (x === 0) s = '1' + s;
      else break;
    }
    return s;
  }
  function b58decode(str) {
    let n = 0n;
    for (const ch of str) {
      const v = B58.indexOf(ch);
      if (v < 0) throw new Error('base58 inválido');
      n = n * 58n + BigInt(v);
    }
    const out = [];
    while (n > 0n) {
      out.unshift(Number(n & 255n));
      n >>= 8n;
    }
    for (const ch of str) {
      if (ch === '1') out.unshift(0);
      else break;
    }
    return Uint8Array.from(out);
  }
  const b64bytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const utf8 = (s) => new TextEncoder().encode(s);
  const rdU16 = (b, o) => b[o] | (b[o + 1] << 8);
  const rdI32 = (b, o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);
  function rdUint(b, o, n) {
    let v = 0n;
    for (let i = n - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[o + i]);
    return v;
  }
  function rdI128(b, o) {
    let v = rdUint(b, o, 16);
    if (v >= 1n << 127n) v -= 1n << 128n;
    return v;
  }
  const hex8 = (b) => Array.from(b.slice(0, 8), (x) => x.toString(16).padStart(2, '0')).join('');

  // SHA-256 síncrono (necessário para derivar PDAs dos tick arrays).
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  function sha256(bytes) {
    const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const l = bytes.length;
    const total = ((l + 9 + 63) >> 6) << 6;
    const m = new Uint8Array(total);
    m.set(bytes);
    m[l] = 0x80;
    const dv = new DataView(m.buffer);
    dv.setUint32(total - 4, (l * 8) >>> 0);
    dv.setUint32(total - 8, Math.floor((l * 8) / 2 ** 32));
    const w = new Uint32Array(64);
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let off = 0; off < total; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
        const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        h = g;
        g = f;
        f = e;
        e = (d + t1) | 0;
        d = c;
        c = b;
        b = a;
        a = (t1 + t2) | 0;
      }
      H[0] += a;
      H[1] += b;
      H[2] += c;
      H[3] += d;
      H[4] += e;
      H[5] += f;
      H[6] += g;
      H[7] += h;
    }
    const out = new Uint8Array(32);
    const odv = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) odv.setUint32(i * 4, H[i]);
    return out;
  }

  // Um PDA precisa estar fora da curva ed25519.
  const FP = (1n << 255n) - 19n;
  function modpow(b, e, m) {
    let r = 1n;
    b %= m;
    while (e > 0n) {
      if (e & 1n) r = (r * b) % m;
      b = (b * b) % m;
      e >>= 1n;
    }
    return r;
  }
  const ED_D = (((-121665n * modpow(121666n, FP - 2n, FP)) % FP) + FP) % FP;
  function isOnCurve(bytes) {
    let y = 0n;
    for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes[i]);
    y = (y & ((1n << 255n) - 1n)) % FP;
    const y2 = (y * y) % FP;
    const u = (y2 - 1n + FP) % FP;
    const v = (ED_D * y2 + 1n) % FP;
    const x2 = (u * modpow(v, FP - 2n, FP)) % FP;
    if (x2 === 0n) return true;
    return modpow(x2, (FP - 1n) / 2n, FP) === 1n;
  }
  function findPda(seeds, programId) {
    const pid = b58decode(programId);
    const tail = utf8('ProgramDerivedAddress');
    const seedLen = seeds.reduce((s, x) => s + x.length, 0);
    for (let bump = 255; bump >= 0; bump--) {
      const buf = new Uint8Array(seedLen + 1 + pid.length + tail.length);
      let o = 0;
      for (const s of seeds) {
        buf.set(s, o);
        o += s.length;
      }
      buf[o++] = bump;
      buf.set(pid, o);
      o += pid.length;
      buf.set(tail, o);
      const h = sha256(buf);
      if (!isOnCurve(h)) return b58encode(h);
    }
    throw new Error('PDA não encontrado');
  }

  async function getMultipleAccounts(addrs) {
    const out = [];
    const chunks = [];
    for (let i = 0; i < addrs.length; i += 10) chunks.push(addrs.slice(i, i + 10));
    const res = await Promise.all(
      chunks.map((c) => rpc('solana', 'getMultipleAccounts', [c, { encoding: 'base64', commitment: 'confirmed' }]))
    );
    res.forEach((r) => r.value.forEach((v) => out.push(v ? b64bytes(v.data[0]) : null)));
    return out;
  }

  function parseWhirlpool(b) {
    return {
      tickSpacing: rdU16(b, 41),
      feeRate: rdU16(b, 45),
      liquidity: rdUint(b, 49, 16),
      sqrtPrice: rdUint(b, 65, 16),
      tick: rdI32(b, 81),
      mintA: b58encode(b.slice(101, 133)),
      vaultA: b58encode(b.slice(133, 165)),
      mintB: b58encode(b.slice(181, 213)),
      vaultB: b58encode(b.slice(213, 245)),
    };
  }

  const vaultCache = {};
  async function readOrcaPools(pools) {
    const [accs, slot] = await Promise.all([getMultipleAccounts(pools.map((p) => p.address)), rpc('solana', 'getSlot', [{ commitment: 'confirmed' }])]);
    setHealth('solana', { head: slot, headLabel: 'slot' });
    const parsed = {};
    pools.forEach((p, i) => {
      if (!accs[i] || accs[i].length < 245) return;
      parsed[p.key] = parseWhirlpool(accs[i]);
    });
    const vaults = [];
    for (const p of pools) {
      const w = parsed[p.key];
      if (w) vaults.push(w.vaultA, w.vaultB);
    }
    const vAccs = await getMultipleAccounts(vaults);
    vaults.forEach((v, i) => (vaultCache[v] = vAccs[i] ? rdUint(vAccs[i], 64, 8) : null));
    const out = {};
    for (const p of pools) {
      const w = parsed[p.key];
      if (!w) {
        out[p.key] = { error: 'conta Whirlpool não encontrada' };
        continue;
      }
      if (w.mintA !== p.token0.addr || w.mintB !== p.token1.addr) {
        out[p.key] = { error: 'mints da pool não conferem' };
        continue;
      }
      out[p.key] = {
        sqrtPriceX64: w.sqrtPrice,
        tick: w.tick,
        liquidity: w.liquidity,
        lpFee: w.feeRate,
        tickSpacing: w.tickSpacing,
        raw0: vaultCache[w.vaultA],
        raw1: vaultCache[w.vaultB],
        vaultA: w.vaultA,
        vaultB: w.vaultB,
        block: slot,
      };
    }
    return out;
  }

  const DISC_DYNAMIC = '11d8f68ee1c7da38';
  const DISC_FIXED = '4561bdbe6e0742bb';
  function parseTickArray(b, ts) {
    const disc = hex8(b);
    const start = rdI32(b, 8);
    const ticks = [];
    if (disc === DISC_DYNAMIC) {
      let off = 60;
      for (let i = 0; i < 88 && off < b.length; i++) {
        const tag = b[off];
        off += 1;
        if (tag === 1) {
          ticks.push({ tick: start + i * ts, net: rdI128(b, off) });
          off += 112;
        }
      }
    } else if (disc === DISC_FIXED) {
      for (let i = 0; i < 88; i++) {
        const off = 12 + i * 113;
        if (b[off] === 1) ticks.push({ tick: start + i * ts, net: rdI128(b, off + 1) });
      }
    }
    return ticks;
  }

  async function scanTicksOrca(p, tick, arraysEachSide = 4) {
    const ts = p.tickSpacing;
    const span = 88 * ts;
    const start0 = Math.floor(tick / span) * span;
    const starts = [];
    for (let k = -arraysEachSide; k <= arraysEachSide; k++) starts.push(start0 + k * span);
    const program = CHAINS.solana.whirlpoolProgram;
    const poolKey = b58decode(p.address);
    const pdas = starts.map((s) => findPda([utf8('tick_array'), poolKey, utf8(String(s))], program));
    const accs = await getMultipleAccounts(pdas);
    const ticks = [];
    accs.forEach((a) => {
      if (a) ticks.push(...parseTickArray(a, ts));
    });
    ticks.sort((a, b) => a.tick - b.tick);
    return {
      ticks,
      windowLo: starts[0],
      windowHi: starts[starts.length - 1] + span - 1,
      centerTick: tick,
      at: Date.now(),
      arrays: accs.filter(Boolean).length,
    };
  }

  /* ------------------------------------------- histórico (GeckoTerminal) */

  const gtQueue = [];
  const gtPending = new Map();
  let gtRunning = false;
  let gtLast = 0;
  const GT_SPACING = 6500;
  const GT_TTL = 20 * 60 * 1000;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function readGtCache(key) {
    try {
      const raw = localStorage.getItem(LS_GT + key);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (Date.now() - obj.at > GT_TTL) return null;
      return obj;
    } catch (e) {
      return null;
    }
  }
  function writeGtCache(key, obj) {
    try {
      localStorage.setItem(LS_GT + key, JSON.stringify(obj));
    } catch (e) {
      /* cota cheia ou armazenamento bloqueado: segue sem cache */
    }
  }

  async function gtFetch(p) {
    const base = p.base === 0 ? p.token0 : p.token1;
    const net = CHAINS[p.chain].gt;
    const url = `https://api.geckoterminal.com/api/v2/networks/${net}/pools/${p.address}/ohlcv/hour?aggregate=1&limit=720&currency=token&token=${base.addr}`;
    // A API pública aceita poucas chamadas por minuto; quando estoura, responde 429
    // sem cabeçalho CORS e o fetch falha como erro de rede. Nos dois casos: esperar e repetir.
    for (let attempt = 0; attempt < 4; attempt++) {
      const wait = gtLast + GT_SPACING - Date.now();
      if (wait > 0) await sleep(wait);
      gtLast = Date.now();
      let res;
      try {
        res = await fetch(url, { headers: { accept: 'application/json' } });
      } catch (e) {
        await sleep(15000 * (attempt + 1));
        continue;
      }
      if (res.status === 429) {
        await sleep(15000 * (attempt + 1));
        continue;
      }
      if (res.status === 404) return { at: Date.now(), candles: [], note: 'pool sem histórico indexado' };
      if (!res.ok) throw new Error(`GeckoTerminal HTTP ${res.status}`);
      const j = await res.json();
      const list = ((j.data && j.data.attributes && j.data.attributes.ohlcv_list) || []).slice().reverse();
      const metaBase = j.meta && j.meta.base && j.meta.base.address;
      const same = !metaBase || metaBase.toLowerCase() === base.addr.toLowerCase();
      const candles = list
        .map(([t, o, h, l, c, v]) =>
          same ? { t: t * 1000, o, h, l, c, v } : { t: t * 1000, o: 1 / o, h: 1 / l, l: 1 / h, c: 1 / c, v }
        )
        .filter((k) => isFinite(k.c) && k.c > 0);
      return { at: Date.now(), candles };
    }
    throw new Error('GeckoTerminal limitou as requisições; nova tentativa em instantes');
  }

  async function pumpGt() {
    if (gtRunning) return;
    gtRunning = true;
    while (gtQueue.length) {
      const job = gtQueue.shift();
      try {
        const data = await gtFetch(job.pool);
        writeGtCache(job.pool.key, data);
        job.resolve(data);
      } catch (e) {
        job.reject(e);
      } finally {
        gtPending.delete(job.pool.key);
      }
    }
    gtRunning = false;
  }

  function loadHistory(pool, { priority = false } = {}) {
    const cached = readGtCache(pool.key);
    if (cached) return Promise.resolve(cached);
    if (gtPending.has(pool.key)) {
      const pending = gtPending.get(pool.key);
      if (priority) {
        const i = gtQueue.indexOf(pending.job);
        if (i > 0) gtQueue.unshift(gtQueue.splice(i, 1)[0]);
      }
      return pending.promise;
    }
    let job;
    const promise = new Promise((resolve, reject) => {
      job = { pool, resolve, reject };
    });
    if (priority) gtQueue.unshift(job);
    else gtQueue.push(job);
    gtPending.set(pool.key, { job, promise });
    pumpGt();
    return promise;
  }

  window.Onchain = {
    MIN_TICK,
    MAX_TICK,
    health,
    onHealth: (fn) => healthListeners.add(fn),
    rpcList,
    customRpcs,
    saveCustomRpcs,
    readEvmPools,
    readOrcaPools,
    scanTicksEvm,
    scanTicksOrca,
    buildSegments,
    amountsBetween,
    sqrtAtTick,
    loadHistory,
    _test: { sha256, findPda, b58encode, b58decode, encodeAggregate3, decodeAggregate3 },
  };
})();
