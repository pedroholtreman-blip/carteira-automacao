// Normaliza o histórico de preços e os lotes para uma base consistente de splits.
//
// Problema: a folha guardava os preços de fim de ano ajustados aos splits
// (GOOGLEFINANCE), mas as unidades dos lotes são as "da altura" — umas
// ajustadas (ex.: AMZN comprada a 38 $), outras não (ex.: NOW comprada a 392 $
// e vendida antes do split 5:1), e os splits recentes estão registados como
// lotes extra a custo zero (NVDA, CTAS, DECK, SMCI). Resultado: o valor da
// carteira por ano saía errado.
//
// Solução (corre no GitHub Actions, manualmente ou 1x/mês):
//  1. Para cada ticker, vai buscar ao Yahoo a série diária ajustada a splits
//     (base = hoje) e reescreve TODOS os preços guardados em price_snapshots
//     para essa base (e acrescenta os fechos de fim de ano que faltarem).
//  2. Para cada lote calcula unit_factor = preço de compra registado ÷ preço
//     ajustado do dia da compra, arredondado ao rácio de split mais próximo
//     (1, 2, 3, 4, 5, 10, 20, 25…). Unidades × unit_factor = ações na base de hoje.
//     Lotes a custo zero que representam splits ficam com unit_factor = 0
//     (excluídos do histórico, porque o fator dos lotes originais já os inclui).
//  3. A app usa unidades × unit_factor nos painéis históricos (valor por ano,
//     evolução mensal, "desde 31/12"); o painel de posições atuais continua a
//     usar as unidades tal como registadas (que é o que bate certo com a corretora).
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Opcional: DRY_RUN=1, ONLY=TICKER1,TICKER2

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY_RUN = process.env.DRY_RUN === '1';
const ONLY = (process.env.ONLY || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
if(!SUPABASE_URL || !SERVICE_KEY){ console.error('Faltam SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.'); process.exit(1); }

// Símbolos Yahoo/Stooq para tickers que não são US; div = divisor (pence → libras)
const SYMBOLS = {
  'BCP':    { y: 'BCP.LS',  s: 'bcp.pt' },
  'BPI':    { y: 'BPI.LS',  s: 'bpi.pt' },
  'IFX':    { y: 'IFX.DE',  s: 'ifx.de' },
  'NOVO-B': { y: 'NOV.DE',  s: 'nov.de' },
  'ABI':    { y: 'ABI.BR',  s: 'abi.be' },
  'HKD':    { y: 'BABA',    s: 'baba.us' },
  'RMV':    { y: 'RMV.L',   s: 'rmv.uk', div: 100 },
  'VUSA':   { y: 'VUSA.AS', s: 'vusa.nl' },
  'CSPX':   { y: 'SXR8.DE', s: 'sxr8.de' },          // iShares Core S&P 500 em EUR (Xetra); CSPX.L cota em USD
  'IWDA':   { y: 'IWDA.AS', s: 'iwda.nl' },
  'IS3K':   { y: 'IS3K.DE' }, 'IS3C': { y: 'IS3C.DE' }, 'EXI2': { y: 'EXI2.DE' }, 'IBCD': { y: 'IBCD.DE' }, 'QDVY': { y: 'QDVY.DE' },
};
const SPLIT_RATIOS = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 8, 10, 15, 20, 25, 30, 40, 50, 75, 100];
SPLIT_RATIOS.push(...SPLIT_RATIOS.filter(r => r > 1).map(r => 1 / r)); // reverse splits (ex.: LCID 1:10)
const isCleanRatio = (r) => SPLIT_RATIOS.some(c => Math.abs(r / c - 1) <= 0.025);

async function sb(method, path, body, prefer = 'return=minimal'){
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method, headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: prefer }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if(!res.ok) throw new Error(`Supabase ${method} ${path} → HTTP ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}
async function sbAll(path){ let out = [], from = 0; for(;;){ const sep = path.includes('?') ? '&' : '?'; const d = await sb('GET', `${path}${sep}offset=${from}&limit=1000`); out = out.concat(d || []); if(!d || d.length < 1000) break; from += 1000; } return out; }
const iso = (d) => d.toISOString().slice(0, 10);
const currentYear = new Date().getFullYear();

async function yahooDaily(symbol, fromYear){
  const p1 = Math.floor(Date.UTC(fromYear, 0, 1) / 1000), p2 = Math.floor(Date.now() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${p1}&period2=${p2}&interval=1d&events=splits`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; carteira-automacao/1.0)', Accept: 'application/json' } });
  if(!res.ok) throw new Error(`Yahoo ${symbol} HTTP ${res.status}`);
  const j = await res.json();
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  if(!r || !r.timestamp) throw new Error(`Yahoo ${symbol}: sem dados`);
  const closes = r.indicators.quote[0].close;
  const out = [];
  r.timestamp.forEach((ts, i) => { if(closes[i] != null) out.push({ d: iso(new Date(ts * 1000)), p: closes[i] }); });
  const splits = Object.values((r.events && r.events.splits) || {}).map(e => ({ d: iso(new Date(e.date * 1000)), ratio: Number(e.numerator) / Number(e.denominator) })).filter(e => e.ratio > 0 && e.ratio !== 1).sort((a, b) => a.d < b.d ? -1 : 1);
  out.splits = splits;
  return out;
}
async function stooqDaily(symbol, fromYear){
  const res = await fetch(`https://stooq.com/q/d/l/?s=${encodeURIComponent(symbol)}&d1=${fromYear}0101&d2=${currentYear}1231&i=d`, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; carteira-automacao/1.0)' } });
  if(!res.ok) throw new Error(`Stooq ${symbol} HTTP ${res.status}`);
  const lines = (await res.text()).trim().split('\n'); if(lines.length < 2 || !/^Date/.test(lines[0])) throw new Error(`Stooq ${symbol}: sem dados`);
  return lines.slice(1).map(l => { const c = l.split(','); return { d: c[0], p: parseFloat(c[4]) }; }).filter(x => !isNaN(x.p));
}
async function dailySeries(ticker, fromYear){
  const m = SYMBOLS[ticker] || { y: ticker, s: `${ticker.toLowerCase()}.us` };
  const errors = [];
  for(const [name, fn, sym] of [['Yahoo', yahooDaily, m.y], ['Stooq', stooqDaily, m.s]]){
    if(!sym) continue;
    try{ const s = await fn(sym, fromYear); if(s.length){ return { series: s.map(x => ({ d: x.d, p: m.div ? x.p / m.div : x.p })), splits: s.splits || [], source: `${name} ${sym}` }; } }
    catch(e){ errors.push(e.message); }
  }
  throw new Error(errors.join(' | '));
}
// preço ajustado no dia (ou último dia de negociação anterior)
function priceAt(series, dateIso){
  let last = null;
  for(const x of series){ if(x.d <= dateIso) last = x; else break; }
  return last;
}

// --- dados ---
const tx = await sbAll('transactions?select=id,ticker,currency,units,buy_date,sell_date,buy_price,unit_factor');
const snaps = await sbAll('price_snapshots?select=ticker,price_date,price,source');
const tickers = [...new Set(tx.map(t => t.ticker.toUpperCase()))].filter(t => !ONLY.length || ONLY.includes(t)).sort();
console.log(`${tickers.length} tickers, ${tx.length} lotes, ${snaps.length} snapshots.`);

const priceUpdates = [], newYearEnds = [], lotUpdates = [], report = [], failures = [];

for(const ticker of tickers){
  const lots = tx.filter(t => t.ticker.toUpperCase() === ticker);
  const currency = (lots[0].currency || 'EUR').toUpperCase();
  const firstYear = Math.min(...lots.filter(l => l.buy_date).map(l => +l.buy_date.slice(0, 4)));
  let series, source, splits;
  try{ ({ series, splits, source } = await dailySeries(ticker, Math.max(2000, firstYear - 1))); }
  catch(e){ failures.push(`${ticker}: ${e.message}`); console.log(`${ticker.padEnd(7)} FALHOU: ${e.message}`); continue; }

  // Eventos do Yahoo que NÃO são splits "limpos" (ex.: YUM 1.355:1 pelo spin-off da YUMC)
  // ajustam os preços antigos sem mexer nas unidades do acionista → desfaz-se esse
  // ajustamento (preços antes do evento × rácio) e o evento não conta para o unit_factor.
  const pseudo = splits.filter(sp => !isCleanRatio(sp.ratio));
  const realSplits = splits.filter(sp => isCleanRatio(sp.ratio));
  if(pseudo.length){
    series = series.map(x => ({ d: x.d, p: pseudo.reduce((p, sp) => x.d < sp.d ? p * sp.ratio : p, x.p) }));
  }
  const splitsInfo = realSplits.map(sp => `${sp.d.slice(0, 7)} ${sp.ratio >= 1 ? `${+sp.ratio.toFixed(3)}:1` : `1:${+(1 / sp.ratio).toFixed(3)}`}`).concat(pseudo.map(sp => `${sp.d.slice(0, 7)} ~${sp.ratio.toFixed(3)} (spin-off, desfeito)`));

  // 1. reescreve snapshots guardados para a base ajustada de hoje
  let changed = 0;
  snaps.filter(s => s.ticker.toUpperCase() === ticker).forEach(s => {
    const y = priceAt(series, s.price_date); if(!y) return;
    const diff = Math.abs(y.p / Number(s.price) - 1);
    if(diff > 0.005 && diff < 200){ // ignora diferenças ínfimas; >1% reescreve (splits, pence, etc.)
      priceUpdates.push({ ticker, price_date: s.price_date, price: Math.round(y.p * 10000) / 10000, currency, source: s.source });
      changed++;
    }
  });
  // 1b. fechos de fim de ano em falta para os anos em carteira
  for(let yr = firstYear; yr < currentYear; yr++){
    const end = `${yr}-12-31`;
    const held = lots.some(l => l.buy_date && l.buy_date <= end && (!l.sell_date || l.sell_date > end));
    if(!held) continue;
    if(snaps.some(s => s.ticker.toUpperCase() === ticker && s.price_date.startsWith(String(yr)))) continue;
    const inYear = series.filter(x => x.d.startsWith(String(yr)));
    if(inYear.length){ const last = inYear[inYear.length - 1]; newYearEnds.push({ ticker, price_date: last.d, price: Math.round(last.p * 10000) / 10000, currency, source: 'backfill' }); }
  }

  // 2. unit_factor por lote
  const factors = [];
  lots.forEach(l => {
    let f;
    if(!(Number(l.buy_price) > 0)){
      // custo zero: split (há lotes anteriores do mesmo ticker) → 0; senão (spin-off, oferta) → 1
      const earlier = lots.some(o => o !== l && Number(o.buy_price) > 0 && o.buy_date < l.buy_date);
      f = earlier ? 0 : 1;
    } else {
      const adj = l.buy_date ? priceAt(series, l.buy_date) : null;
      if(!adj){ f = 1; }
      else {
        const raw = Number(l.buy_price) / adj.p;
        // Splits (eventos do Yahoo) ocorridos depois da compra — incluindo depois da venda, porque o Yahoo
        // ajusta toda a série aos splits posteriores (ex.: NOW vendida em 2023, split 5:1 em 2025). O utilizador pode ter
        // ajustado alguns deles "à mão" (unidades × n, preço ÷ n) e outros não (ex.: NVDA: o 4:1 de 2021
        // foi ajustado, o 10:1 de 2024 ficou como lote a custo zero), por isso o fator pode ser o produto
        // de QUALQUER subconjunto desses splits — escolhe-se o subconjunto cujo produto bate com o rácio
        // observado (tolerância 12%: o preço de compra não é o fecho do dia). Sem correspondência → 1 e "?".
        // Nunca se inventa um fator a partir do rácio sozinho (ex.: COF a 46 $ de custo herdado da DFS ≠ split).
        const after = realSplits.filter(sp => sp.d > l.buy_date).map(sp => sp.ratio);
        const candidates = after.reduce((acc, r) => acc.concat(acc.map(p => p * r)), [1]); // produtos de todos os subconjuntos
        let best = null, bestErr = Infinity;
        candidates.forEach(c => { const err = Math.abs(raw / c - 1); if(err < bestErr){ bestErr = err; best = c; } });
        if(bestErr <= 0.12) f = best;
        else { f = 1; factors.push(`?${l.buy_date}:${raw.toFixed(2)}`); }
        f = Math.round(f * 10000) / 10000;
      }
    }
    if(Number(l.unit_factor ?? 1) !== f) lotUpdates.push({ id: l.id, unit_factor: f, ticker, buy_date: l.buy_date });
    factors.push(`${f}`);
  });
  const ends = [firstYear, currentYear - 1].map(yr => { const p = priceAt(series, `${yr}-12-31`); return p ? `${yr}=${p.p.toFixed(2)}` : `${yr}=–`; });
  console.log(`${ticker.padEnd(7)} ${source.padEnd(16)} snapshots reescritos: ${String(changed).padStart(3)} | fatores: ${[...new Set(factors)].join(',')} | ${ends.join(' ')}${splitsInfo.length ? ` | splits: ${splitsInfo.join('; ')}` : ''}`);
  await new Promise(r => setTimeout(r, 350));
}

console.log(`\nA gravar: ${priceUpdates.length} preços reescritos, ${newYearEnds.length} fechos novos, ${lotUpdates.length} lotes com unit_factor alterado.`);
if(lotUpdates.length) console.log('Lotes: ' + lotUpdates.map(u => `${u.ticker} ${u.buy_date}→×${u.unit_factor}`).join(', '));
if(DRY_RUN){ console.log('DRY_RUN=1 — nada gravado.'); }
else {
  const all = [...priceUpdates, ...newYearEnds];
  for(let i = 0; i < all.length; i += 200) await sb('POST', 'price_snapshots?on_conflict=ticker,price_date', all.slice(i, i + 200), 'resolution=merge-duplicates,return=minimal');
  for(const u of lotUpdates) await sb('PATCH', `transactions?id=eq.${u.id}`, { unit_factor: u.unit_factor });
  console.log('Gravado.');
}
if(failures.length) console.log(`\nSem dados (${failures.length}):\n - ` + failures.join('\n - '));
