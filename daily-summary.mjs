// Resumo diário da carteira — versão Supabase (Fase 4).
// Corre via GitHub Actions (disparado pelo cron-job.org aos dias úteis, ao
// fecho do mercado americano). O que faz:
//   1. lê as posições abertas da base de dados (Supabase);
//   2. lê as cotações do dia no Yahoo Finance (fecho e fecho anterior por ticker);
//      a folha GOOGLEFINANCE só é usada se USE_SHEET=1;
//   3. grava as cotações do dia em price_snapshots (histórico diário) e o câmbio em fx_rates;
//   4. calcula a variação do dia, movimentos ≥5% e (às segundas) notícias;
//   5. grava tudo em app_settings (summary_json, report_json, news_json) + news_items,
//      escreve docs/*.json (para o Apple Watch) e envia o email via Resend.
//
// Variáveis de ambiente (GitHub Secrets):
//   SUPABASE_URL               - https://xxxx.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY  - service role key (só aqui, nunca na app)
//   SHEET_ID / SHEET_GID       - (opcional, só com USE_SHEET=1) folha com as cotações GOOGLEFINANCE
//   PRICES_ONLY=1              - execução intradiária: grava cotações + resumo, sem email
//   RESEND_API_KEY, EMAIL_TO, EMAIL_FROM

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SHEET_ID = process.env.SHEET_ID;
const SHEET_GID = process.env.SHEET_GID;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_TO = process.env.EMAIL_TO;
const EMAIL_FROM = process.env.EMAIL_FROM || 'onboarding@resend.dev';
const NEWS_TICKER_COUNT = 5; // quantas das maiores posições incluir nas notícias semanais
const NEWS_PER_TICKER = 2;   // quantas manchetes por ação

function requireEnv(name, value){
  if(!value){
    console.error(`Falta a variável de ambiente ${name}. Configura-a nos GitHub Secrets do repositório.`);
    process.exit(1);
  }
}
requireEnv('SUPABASE_URL', SUPABASE_URL);
requireEnv('SUPABASE_SERVICE_ROLE_KEY', SERVICE_KEY);
requireEnv('RESEND_API_KEY', RESEND_API_KEY);
requireEnv('EMAIL_TO', EMAIL_TO);

// --- 0. Supabase via PostgREST (sem dependências) ---
async function sb(method, path, body, extraHeaders = {}){
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  if(!res.ok) throw new Error(`Supabase ${method} ${path} → HTTP ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}
async function sbAll(path){
  const PAGE = 1000; let from = 0, out = [];
  for(let i = 0; i < 200; i++){
    const sep = path.includes('?') ? '&' : '?';
    const data = await sb('GET', `${path}${sep}offset=${from}&limit=${PAGE}`);
    out = out.concat(data || []);
    if(!data || data.length < PAGE) break;
    from += PAGE;
  }
  return out;
}
const upsert = (table, rows, onConflict) => rows.length ? sb('POST', `${table}?on_conflict=${encodeURIComponent(onConflict)}`, rows, { Prefer: 'resolution=merge-duplicates,return=minimal' }) : null;
const todayIso = new Date().toISOString().slice(0, 10);

// --- 1. Só corre perto das 16:00 (hora de Nova Iorque) e em dias úteis ---
// O workflow é agendado duas vezes (para cobrir horário de verão/inverno
// dos EUA); esta verificação garante que só uma das duas execuções envia
// o email de facto, e nunca aos fins de semana.
const nyFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: 'numeric',
  hour12: false,
  weekday: 'short'
});
const nyParts = nyFormatter.formatToParts(new Date());
const nyHour = parseInt(nyParts.find(p => p.type === 'hour').value, 10);
const nyWeekday = nyParts.find(p => p.type === 'weekday').value;
const isWeekday = !['Sat', 'Sun'].includes(nyWeekday);

if(!isWeekday){
  console.log(`Hoje é ${nyWeekday} em Nova Iorque — mercado fechado, não envio email.`);
  process.exit(0);
}
// PRICES_ONLY=1: execução intradiária — só grava cotações e o resumo (sem email, notícias ou relatório).
const PRICES_ONLY = process.env.PRICES_ONLY === '1';
if(!PRICES_ONLY && nyHour !== 16){
  console.log(`São ${nyHour}h em Nova Iorque, não são 16h — esta execução não envia (a outra, ajustada ao horário de verão/inverno, é que envia hoje).`);
  process.exit(0);
}

// --- 2. Vai buscar os dados da Google Sheet ---
function tableToRows(data){
  const cols = data.table.cols.map(c => (c.label || c.id || '').trim());
  const rows = data.table.rows.map(r => r.c.map(cell => {
    if(!cell) return '';
    if(cell.v === null || cell.v === undefined) return '';
    return cell.f !== undefined && cell.f !== null ? cell.f : cell.v;
  }));
  return [cols, ...rows];
}

function num(v){
  if(v === undefined || v === null) return NaN;
  let s = String(v).trim();
  if(s === '') return NaN;
  s = s.replace(/[^\d.,-]/g, '');
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if(lastComma > lastDot){
    s = s.replace(/\./g, '').replace(',', '.');
  } else {
    s = s.replace(/,/g, '');
  }
  return parseFloat(s);
}

async function fetchSheet(){
  if(!SHEET_ID || !SHEET_GID) throw new Error('SHEET_ID/SHEET_GID não definidos.');
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?gid=${SHEET_GID}&headers=1&tqx=out:json`;
  const res = await fetch(url);
  if(!res.ok) throw new Error(`Falha ao ler a Google Sheet (HTTP ${res.status}). Confirma o SHEET_ID/SHEET_GID e a partilha "Qualquer pessoa com o link".`);
  const text = await res.text();
  const match = text.match(/google\.visualization\.Query\.setResponse\(([\s\S]*)\);?\s*$/);
  if(!match) throw new Error('Não consegui interpretar a resposta da Google Sheet.');
  const data = JSON.parse(match[1]);
  return tableToRows(data);
}

async function fetchUsdEurRate(){
  const res = await fetch('https://api.frankfurter.dev/v1/latest?from=USD&to=EUR');
  if(!res.ok) throw new Error('Falha ao obter a taxa de câmbio (Frankfurter API).');
  const json = await res.json();
  const rate = json && json.rates && json.rates.EUR;
  if(typeof rate !== 'number' || isNaN(rate)) throw new Error('Taxa de câmbio inválida.');
  return rate;
}

// --- 2b. Recurso: cotações do Yahoo Finance (quando a folha falha ou lhe faltam tickers) ---
// Símbolos para tickers não-US (mesma tabela do normalize-prices.mjs); div = pence → libras
const YAHOO_SYMBOLS = {
  'BCP': { y: 'BCP.LS' }, 'BPI': { y: 'BPI.LS' }, 'IFX': { y: 'IFX.DE' }, 'NOVO-B': { y: 'NOV.DE' }, 'ABI': { y: 'ABI.BR' },
  'HKD': { y: 'BABA' }, 'RMV': { y: 'RMV.L', div: 100 }, 'VUSA': { y: 'VUSA.AS' }, 'CSPX': { y: 'SXR8.DE' }, 'IWDA': { y: 'IWDA.AS' },
  'IS3K': { y: 'IS3K.DE' }, 'IS3C': { y: 'IS3C.DE' }, 'EXI2': { y: 'EXI2.DE' }, 'IBCD': { y: 'IBCD.DE' }, 'QDVY': { y: 'QDVY.DE' },
};
async function fetchYahooQuote(ticker){
  const m = YAHOO_SYMBOLS[ticker] || { y: ticker };
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(m.y)}?range=10d&interval=1d`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; carteira-automacao/1.0)', Accept: 'application/json' } });
  if(!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  if(!r || !r.timestamp) throw new Error('sem dados');
  const closes = r.indicators.quote[0].close.map((c, i) => ({ c, t: r.timestamp[i] })).filter(x => x.c != null);
  if(!closes.length) throw new Error('sem fechos');
  const div = m.div || 1;
  const current = closes[closes.length - 1].c / div;
  const previous = closes.length > 1 ? closes[closes.length - 2].c / div : null;
  return { current, previous };
}
async function fetchYahooQuotes(tickers){
  const out = new Map(); const failed = [];
  for(const t of tickers){
    try{ out.set(t, await fetchYahooQuote(t)); }
    catch(e){ failed.push(`${t} (${e.message})`); }
    await new Promise(r => setTimeout(r, 250));
  }
  console.log(`Cotações do Yahoo: ${out.size} tickers${failed.length ? `; sem dados: ${failed.join(', ')}` : ''}.`);
  return out;
}

// --- 3. Posições da base de dados + cotações do dia; grava o histórico ---
async function fetchPriceFeed(){
  // Map ticker -> { current, previous } a partir da folha GOOGLEFINANCE.
  // Desde 2026-10 a fonte principal é o Yahoo Finance (ver computeDailyChange);
  // a folha só é lida se USE_SHEET=1 (recurso manual).
  const out = new Map();
  if(process.env.USE_SHEET !== '1') return out;
  try{
    const rows = await fetchSheet();
    const norm = (x) => (x || '').toString().replace(/\s+/g, '').toUpperCase();
    const header = rows[0].map(norm);
    const iT = header.indexOf('TICKER'), iC = header.indexOf('CURRENTPRICE(O)'), iP = header.indexOf('PREVIOUSPRICE(O)'), iS = header.indexOf('STATUS');
    if(iT === -1 || iC === -1) throw new Error('colunas TICKER / CURRENT PRICE (O) em falta');
    rows.slice(1).forEach(r => {
      const t = String(r[iT] || '').trim().toUpperCase();
      if(!t || out.has(t)) return;
      if(iS > -1 && String(r[iS] || '').trim().toLowerCase() !== 'open') return;
      const cur = num(r[iC]), prev = iP > -1 ? num(r[iP]) : NaN;
      if(isNaN(cur) || cur <= 0) return;
      out.set(t, { current: cur, previous: isNaN(prev) ? null : prev });
    });
    console.log(`Cotações lidas da folha: ${out.size} tickers.`);
  }catch(e){
    console.warn(`Folha de cotações indisponível (${e.message}) — uso os últimos preços guardados na base de dados.`);
  }
  return out;
}

async function computeDailyChange(){
  const [positions, feed, usdEurRate] = await Promise.all([
    sbAll('transactions?select=ticker,units,currency,status&status=eq.open'),
    fetchPriceFeed(),
    fetchUsdEurRate()
  ]);
  if(positions.length === 0) throw new Error('Não há posições abertas na base de dados.');

  // Últimos dois snapshots por ticker (para "ontem" e como recurso quando a folha falha)
  const tickers = [...new Set(positions.map(p => p.ticker.toUpperCase()))];

  // Fonte principal das cotações: Yahoo Finance (independente da Google Sheet).
  const toFetch = tickers.filter(t => !feed.has(t));
  if(toFetch.length){
    const y = await fetchYahooQuotes(toFetch);
    y.forEach((v, t) => feed.set(t, v));
  }
  const semCotacao = tickers.filter(t => !feed.has(t));
  if(semCotacao.length) console.warn(`Sem cotação de hoje para: ${semCotacao.join(', ')} — fica o último fecho guardado.`);
  const snaps = await sbAll(`price_snapshots?select=ticker,price_date,price&ticker=in.(${tickers.map(t => `"${t}"`).join(',')})&order=price_date.asc`);
  const hist = new Map();
  snaps.forEach(s => { const t = s.ticker.toUpperCase(); if(!hist.has(t)) hist.set(t, []); hist.get(t).push({ d: s.price_date, p: Number(s.price) }); });

  const priceOf = (t) => {
    const h = hist.get(t) || [];
    const before = h.filter(x => x.d < todayIso);
    const lv = feed.get(t);
    const current = lv ? lv.current : (h.length ? h[h.length - 1].p : NaN);
    const previous = lv && lv.previous !== null ? lv.previous : (before.length ? before[before.length - 1].p : NaN);
    return { current, previous };
  };

  // Guarda as cotações do dia (uma por ticker) e o câmbio
  const currencyOf = new Map(); positions.forEach(p => currencyOf.set(p.ticker.toUpperCase(), (p.currency || 'EUR').toUpperCase()));
  const snapRows = tickers.filter(t => feed.has(t)).map(t => ({ ticker: t, price_date: todayIso, price: feed.get(t).current, currency: currencyOf.get(t) || 'EUR', source: 'feed' }));
  await upsert('price_snapshots', snapRows, 'ticker,price_date');
  await upsert('fx_rates', [{ rate_date: todayIso, base: 'USD', quote: 'EUR', rate: +usdEurRate.toFixed(6) }], 'rate_date,base,quote');
  console.log(`price_snapshots: ${snapRows.length} cotações gravadas para ${todayIso}.`);

  const BIG_MOVE_THRESHOLD_PCT = 5; // variação diária (%) a partir da qual um ticker é sinalizado — limiar arbitrário, sem juízo de valor

  let totalToday = 0, totalYesterday = 0;
  const valueByTicker = new Map();
  const tickerMoves = new Map();
  positions.forEach(p => {
    const ticker = p.ticker.toUpperCase();
    const qty = Number(p.units);
    const { current, previous } = priceOf(ticker);
    if(isNaN(qty) || isNaN(current) || isNaN(previous)) return;
    const fx = currencyOf.get(ticker) === 'USD' ? usdEurRate : 1;
    const valueEur = qty * current * fx;
    const valueYesterdayEur = qty * previous * fx;
    totalToday += valueEur;
    totalYesterday += valueYesterdayEur;
    valueByTicker.set(ticker, (valueByTicker.get(ticker) || 0) + valueEur);
    if(!tickerMoves.has(ticker)) tickerMoves.set(ticker, { valueToday: 0, valueYesterday: 0 });
    const tm = tickerMoves.get(ticker);
    tm.valueToday += valueEur;
    tm.valueYesterday += valueYesterdayEur;
  });

  const changeValue = totalToday - totalYesterday;
  const changePct = totalYesterday !== 0 ? (changeValue / totalYesterday) * 100 : 0;

  const topTickers = [...valueByTicker.entries()].sort((a, b) => b[1] - a[1]).slice(0, NEWS_TICKER_COUNT).map(([ticker]) => ticker);

  // Movimentos de preço fora do normal — puramente factual (só a variação % de cada ticker).
  const bigMoves = [...tickerMoves.entries()]
    .map(([ticker, v]) => ({ ticker, changePct: Math.round((v.valueYesterday !== 0 ? ((v.valueToday - v.valueYesterday) / v.valueYesterday) * 100 : 0) * 100) / 100 }))
    .filter(m => Math.abs(m.changePct) >= BIG_MOVE_THRESHOLD_PCT)
    .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));

  return { totalToday, totalYesterday, changeValue, changePct, topTickers, bigMoves };
}

// --- 4. Constrói um pequeno gráfico (via QuickChart, grátis, sem chave) ---
function buildChartUrl(totalYesterday, totalToday, positive){
  const chartConfig = {
    type: 'bar',
    data: {
      labels: ['Ontem', 'Hoje'],
      datasets: [{
        data: [totalYesterday, totalToday],
        backgroundColor: [positive ? 'rgba(51,209,122,0.35)' : 'rgba(239,87,87,0.35)', positive ? '#33d17a' : '#ef5757']
      }]
    },
    options: {
      plugins: { legend: { display: false }, title: { display: false } },
      scales: { y: { ticks: { callback: 'function(v){ return "€" + v.toLocaleString(); }' } } }
    }
  };
  return `https://quickchart.io/chart?width=400&height=220&backgroundColor=white&c=${encodeURIComponent(JSON.stringify(chartConfig))}`;
}

// --- 4b. Notícias semanais (só às segundas-feiras) — via Google News RSS,
// que é grátis e não precisa de nenhuma chave de API. Isto só funciona
// aqui porque corre no servidor (GitHub Actions); no browser a maioria
// destas fontes bloqueia pedidos diretos por CORS.
function isMonday(){
  return nyWeekday === 'Mon';
}

function decodeXmlEntities(s){
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

async function fetchNewsForTicker(ticker){
  const query = encodeURIComponent(`${ticker} stock`);
  const url = `https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`;
  try{
    const res = await fetch(url);
    if(!res.ok) return [];
    const xml = await res.text();
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, NEWS_PER_TICKER);
    return items.map(m => {
      const block = m[1];
      const titleMatch = block.match(/<title>([\s\S]*?)<\/title>/);
      const linkMatch = block.match(/<link>([\s\S]*?)<\/link>/);
      const title = titleMatch ? decodeXmlEntities(titleMatch[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim()) : null;
      const link = linkMatch ? linkMatch[1].trim() : null;
      return (title && link) ? { title, link } : null;
    }).filter(Boolean);
  }catch(e){
    return []; // sem notícias para este ticker; não bloqueia o resto do email
  }
}

async function fetchWeeklyNews(topTickers){
  if(!isMonday() || !topTickers || topTickers.length === 0) return null;
  const results = await Promise.all(topTickers.map(async ticker => ({
    ticker,
    headlines: await fetchNewsForTicker(ticker)
  })));
  const withNews = results.filter(r => r.headlines.length > 0);
  return withNews.length > 0 ? withNews : null;
}

// --- 5. Envia o email via Resend ---
async function sendEmail({ changeValue, changePct, totalToday, totalYesterday }){
  const positive = changeValue >= 0;
  const sign = positive ? '+' : '-';
  const color = positive ? '#178a4c' : '#c73535';
  const fmtEur = (n) => Math.abs(n).toLocaleString('pt-PT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const chartUrl = buildChartUrl(totalYesterday, totalToday, positive);
  const today = new Intl.DateTimeFormat('pt-PT', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date());

  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px">
      <h2 style="margin:0 0 4px;color:#111">Resumo do dia — ${today}</h2>
      <p style="color:#666;margin:0 0 20px;font-size:13px">Fecho do mercado americano</p>
      <div style="font-size:32px;font-weight:700;color:${color};margin-bottom:4px">
        ${sign}€${fmtEur(changeValue)} (${sign}${Math.abs(changePct).toFixed(2).replace('.', ',')}%)
      </div>
      <p style="color:#666;font-size:13px;margin:0 0 20px">Valor atual da carteira: €${fmtEur(totalToday)}</p>
      <img src="${chartUrl}" alt="Gráfico ontem vs hoje" style="width:100%;max-width:400px;border-radius:8px" />
    </div>
  `;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: EMAIL_FROM,
      to: EMAIL_TO,
      subject: `${sign}${Math.abs(changePct).toFixed(2)}% hoje — Resumo da carteira`,
      html
    })
  });

  if(!res.ok){
    const errText = await res.text();
    throw new Error(`Falha ao enviar o email via Resend (HTTP ${res.status}): ${errText}`);
  }
  console.log('Email enviado com sucesso.');
}

// --- 6. Escreve um pequeno resumo público (docs/summary.json), para o
// Atalho do Apple Watch conseguir ler sem expor mais nada da carteira ---
import { writeFile, mkdir } from 'node:fs/promises';

async function writeSummaryJson({ totalToday, changeValue, changePct }){
  const fmtEur = (n) => Math.abs(n).toLocaleString('pt-PT', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: true });
  const sign = changeValue >= 0 ? '+' : '-';

  const summary = {
    updatedAt: new Date().toISOString(),
    totalToday: Math.round(totalToday * 100) / 100,
    changeValue: Math.round(changeValue * 100) / 100,
    changePct: Math.round(changePct * 100) / 100,
    currency: 'EUR',
    // Versões já formatadas (com separador de milhares), prontas a usar
    // diretamente no Atalho do Apple Watch — sem precisares de formatar
    // nada lá.
    totalTodayFormatted: `€${fmtEur(totalToday)}`,
    changeValueFormatted: `${sign}€${fmtEur(changeValue)}`,
    changePctFormatted: `${sign}${Math.abs(changePct).toFixed(2).replace('.', ',')}%`
  };
  await mkdir('docs', { recursive: true });
  await writeFile('docs/summary.json', JSON.stringify(summary, null, 2));
  await upsert('app_settings', [{ key: 'summary_json', value: summary, updated_at: new Date().toISOString() }], 'key');
  console.log('docs/summary.json e app_settings.summary_json atualizados.');
}

// Escreve as notícias semanais num ficheiro público (docs/news.json), para
// a app conseguir mostrá-las no tab Research, sem precisar de as ir buscar
// diretamente do browser (a maioria das fontes de notícias bloqueia isso).
// Só escreve quando há notícias novas (segundas-feiras); nos outros dias,
// o ficheiro simplesmente não é tocado — a app continua a mostrar as da
// última segunda-feira.
async function writeNewsJson(weeklyNews){
  if(!weeklyNews) return;
  const payload = {
    updatedAt: new Date().toISOString(),
    tickers: weeklyNews.map(({ ticker, headlines }) => ({ ticker, headlines }))
  };
  await mkdir('docs', { recursive: true });
  await writeFile('docs/news.json', JSON.stringify(payload, null, 2));
  await upsert('app_settings', [{ key: 'news_json', value: payload, updated_at: new Date().toISOString() }], 'key');
  await upsert('news_items', weeklyNews.flatMap(({ ticker, headlines }) => headlines.map(h => ({ ticker, title: h.title, link: h.link, fetched_at: new Date().toISOString() }))), 'ticker,link');
  console.log('docs/news.json, app_settings.news_json e news_items atualizados.');
}

// Escreve um relatório diário só com factos (movimentos de preço fora do
// normal) — sem qualquer avaliação de risco/oportunidade da minha parte.
// A app decide como apresentar isto; o script só regista o que aconteceu.
async function writeReportJson(bigMoves){
  const payload = {
    updatedAt: new Date().toISOString(),
    bigMoves: bigMoves || []
  };
  await mkdir('docs', { recursive: true });
  await writeFile('docs/report.json', JSON.stringify(payload, null, 2));
  await upsert('app_settings', [{ key: 'report_json', value: payload, updated_at: new Date().toISOString() }], 'key');
  console.log('docs/report.json e app_settings.report_json atualizados.');
}

// --- Main ---
try{
  const data = await computeDailyChange();
  if(PRICES_ONLY){
    await writeSummaryJson(data);
    console.log('PRICES_ONLY=1 — cotações e resumo gravados; sem email.');
  } else {
    const weeklyNews = await fetchWeeklyNews(data.topTickers);
    await sendEmail(data);
    await writeSummaryJson(data);
    await writeNewsJson(weeklyNews);
    await writeReportJson(data.bigMoves);
  }
}catch(err){
  console.error('Erro:', err.message);
  process.exit(1);
}
