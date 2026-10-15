// Preenche os preços de fecho de fim de ano em falta (price_snapshots) para
// todos os títulos que estavam em carteira a 31/12 de cada ano — a folha só
// tinha essas colunas para alguns anos/títulos, e o painel "Valor da Carteira
// por Ano" precisa delas todas.
//
// Corre no GitHub Actions (workflow "Backfill preços de fim de ano", manual).
// Fontes: Yahoo Finance (chart API, sem chave) com recurso ao Stooq.
// Só insere o que falta; nunca altera preços já existentes.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Opcional: FROM_YEAR (defeito: ano da 1.ª compra), DRY_RUN=1.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY_RUN = process.env.DRY_RUN === '1';
if(!SUPABASE_URL || !SERVICE_KEY){ console.error('Faltam SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.'); process.exit(1); }

// Símbolos do Yahoo para os tickers que não são US (ou que mudaram de nome).
// Formato: ticker da app -> { y: símbolo Yahoo, s: símbolo Stooq, div: divisor (pence -> libras) }
const SYMBOLS = {
  'BCP':    { y: 'BCP.LS',   s: 'bcp.pt' },
  'BPI':    { y: 'BPI.LS',   s: 'bpi.pt' },          // retirado de bolsa em 2017; pode não haver dados
  'IFX':    { y: 'IFX.DE',   s: 'ifx.de' },
  'NOVO-B': { y: 'NOV.DE',   s: 'nov.de' },          // Novo Nordisk em EUR (Frankfurt), consistente com a moeda do lote
  'ABI':    { y: 'ABI.BR',   s: 'abi.be' },
  'HKD':    { y: 'BABA',     s: 'baba.us' },         // "HKD" na folha = Alibaba (ADR, USD)
  'RMV':    { y: 'RMV.L',    s: 'rmv.uk', div: 100 }, // Yahoo devolve pence
  'XYZ':    { y: 'XYZ',      s: 'xyz.us' },
  'META':   { y: 'META',     s: 'meta.us' },
  'VUSA':   { y: 'VUSA.AS',  s: 'vusa.nl' },
  'CSPX':   { y: 'CSPX.L',   s: 'cspx.uk' },
  'IWDA':   { y: 'IWDA.AS',  s: 'iwda.nl' },
};

async function sb(method, path, body, prefer = 'return=minimal'){
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method, headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: prefer }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if(!res.ok) throw new Error(`Supabase ${method} ${path} → HTTP ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}
async function sbAll(path){ let out = [], from = 0; for(;;){ const sep = path.includes('?') ? '&' : '?'; const d = await sb('GET', `${path}${sep}offset=${from}&limit=1000`); out = out.concat(d || []); if(!d || d.length < 1000) break; from += 1000; } return out; }

const iso = (d) => d.toISOString().slice(0, 10);
const lastDayStr = (y) => `${y}-12-31`;

// --- 1. O que falta: (ticker, ano) em carteira a 31/12 sem preço nesse ano ---
const tx = await sbAll('transactions?select=ticker,currency,units,buy_date,sell_date');
const snaps = await sbAll('price_snapshots?select=ticker,price_date');
const haveYear = new Set(snaps.map(s => `${s.ticker.toUpperCase()}|${s.price_date.slice(0, 4)}`));
const currentYear = new Date().getFullYear();
const firstYear = process.env.FROM_YEAR ? +process.env.FROM_YEAR : Math.min(...tx.filter(t => t.buy_date).map(t => +t.buy_date.slice(0, 4)));
const missing = new Map(); // ticker -> { currency, years: Set }
for(let y = firstYear; y < currentYear; y++){
  const end = lastDayStr(y);
  tx.forEach(t => {
    if(!t.buy_date || t.buy_date > end) return;
    if(t.sell_date && t.sell_date <= end) return;
    const tk = t.ticker.toUpperCase();
    if(haveYear.has(`${tk}|${y}`)) return;
    if(!missing.has(tk)) missing.set(tk, { currency: (t.currency || 'EUR').toUpperCase(), years: new Set() });
    missing.get(tk).years.add(y);
  });
}
console.log(`Anos ${firstYear}–${currentYear - 1}: ${missing.size} tickers com fechos de fim de ano em falta.`);

// --- 1b. Splits registados como lotes a custo zero (ex.: NVDA 10:1 em 2024) ---
// O Yahoo devolve preços ajustados a splits posteriores; como esses splits
// estão modelados na app como lotes extra a custo zero (as unidades antigas
// não foram ajustadas), os preços ANTERIORES ao lote a custo zero têm de ser
// "des-ajustados": multiplica-se pelo fator do split.
const splitAdjust = new Map(); // ticker -> [{ date, factor }]
const byTicker = new Map();
tx.forEach(t => { const k = t.ticker.toUpperCase(); if(!byTicker.has(k)) byTicker.set(k, []); byTicker.get(k).push(t); });
byTicker.forEach((lots, tk) => {
  lots.filter(l => !(Number(l.buy_price) > 0) && l.buy_date).forEach(zc => {
    const before = lots.filter(l => l.buy_date < zc.buy_date && (!l.sell_date || l.sell_date >= zc.buy_date)).reduce((s, l) => s + Number(l.units), 0);
    if(before > 0){
      const factor = (before + Number(zc.units)) / before;
      if(factor > 1.5){ if(!splitAdjust.has(tk)) splitAdjust.set(tk, []); splitAdjust.get(tk).push({ date: zc.buy_date, factor: Math.round(factor * 100) / 100 }); }
    }
  });
});
splitAdjust.forEach((v, k) => console.log(`Split via lote a custo zero: ${k} ${v.map(x => `×${x.factor} antes de ${x.date}`).join(', ')}`));
const unadjust = (ticker, date, price) => (splitAdjust.get(ticker) || []).reduce((p, sp) => date < sp.date ? p * sp.factor : p, price);

// --- 2. Fontes ---
async function yahooDaily(symbol, fromYear){
  const p1 = Math.floor(Date.UTC(fromYear, 0, 1) / 1000), p2 = Math.floor(Date.now() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${p1}&period2=${p2}&interval=1d&events=history`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; carteira-automacao/1.0)', Accept: 'application/json' } });
  if(!res.ok) throw new Error(`Yahoo ${symbol} HTTP ${res.status}`);
  const j = await res.json();
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  if(!r || !r.timestamp) throw new Error(`Yahoo ${symbol}: sem dados`);
  const closes = r.indicators.quote[0].close;
  const out = [];
  r.timestamp.forEach((ts, i) => { if(closes[i] != null) out.push({ d: iso(new Date(ts * 1000)), p: closes[i] }); });
  return out;
}
async function stooqDaily(symbol, fromYear){
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(symbol)}&d1=${fromYear}0101&d2=${currentYear}1231&i=d`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; carteira-automacao/1.0)' } });
  if(!res.ok) throw new Error(`Stooq ${symbol} HTTP ${res.status}`);
  const text = await res.text();
  const lines = text.trim().split('\n'); if(lines.length < 2 || !/^Date/.test(lines[0])) throw new Error(`Stooq ${symbol}: sem dados`);
  return lines.slice(1).map(l => { const c = l.split(','); return { d: c[0], p: parseFloat(c[4]) }; }).filter(x => !isNaN(x.p));
}
async function dailySeries(ticker, fromYear){
  const m = SYMBOLS[ticker] || { y: ticker, s: `${ticker.toLowerCase()}.us` };
  const errors = [];
  for(const [name, fn, sym] of [['Yahoo', yahooDaily, m.y], ['Stooq', stooqDaily, m.s]]){
    try{ const s = await fn(sym, fromYear); if(s.length){ return { series: s.map(x => ({ d: x.d, p: m.div ? x.p / m.div : x.p })), source: `${name} ${sym}` }; } }
    catch(e){ errors.push(e.message); }
  }
  throw new Error(errors.join(' | '));
}

// --- 3. Preenche ---
const rows = []; const failures = [];
for(const [ticker, info] of missing){
  const years = [...info.years].sort();
  try{
    const { series, source } = await dailySeries(ticker, years[0]);
    const got = [];
    years.forEach(y => {
      const end = lastDayStr(y);
      const inYear = series.filter(x => x.d.startsWith(String(y)) && x.d <= end);
      if(!inYear.length) return;
      const last = inYear[inYear.length - 1];
      const price = unadjust(ticker, last.d, last.p);
      rows.push({ ticker, price_date: last.d, price: Math.round(price * 10000) / 10000, currency: info.currency, source: 'backfill' });
      got.push(`${y}=${price.toFixed(2)}@${last.d}${price !== last.p ? '*' : ''}`);
    });
    const notFound = years.filter(y => !got.some(g => g.startsWith(`${y}=`)));
    console.log(`${ticker.padEnd(7)} ${source.padEnd(18)} ${got.join(' ')}${notFound.length ? `  (sem dados: ${notFound.join(',')})` : ''}`);
    if(notFound.length) failures.push(`${ticker}: sem dados para ${notFound.join(', ')}`);
  }catch(e){
    console.log(`${ticker.padEnd(7)} FALHOU: ${e.message}`);
    failures.push(`${ticker}: ${e.message}`);
  }
  await new Promise(r => setTimeout(r, 400)); // não martelar as APIs
}

console.log(`\n${rows.length} fechos de fim de ano a inserir.`);
if(DRY_RUN){ console.log('DRY_RUN=1 — nada gravado.'); }
else if(rows.length){
  for(let i = 0; i < rows.length; i += 200) await sb('POST', 'price_snapshots?on_conflict=ticker,price_date', rows.slice(i, i + 200), 'resolution=ignore-duplicates,return=minimal'); // nunca altera preços já existentes
  console.log('Gravado.');
}
if(failures.length){ console.log(`\nSem resolução automática (${failures.length}):\n - ` + failures.join('\n - ')); }
