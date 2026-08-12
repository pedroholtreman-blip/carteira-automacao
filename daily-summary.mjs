// Envia um email com o resumo do dia (variação total em valor e %) ao
// fecho do mercado americano. Pensado para correr via GitHub Actions
// (agendado), não precisa de nenhum browser aberto.
//
// Variáveis de ambiente necessárias (definidas como GitHub Secrets):
//   SHEET_ID        - ID da Google Sheet (a parte entre /d/ e /edit na URL)
//   SHEET_GID       - GID da aba "Dashboard"
//   RESEND_API_KEY  - chave da API da Resend (resend.com, grátis)
//   EMAIL_TO        - o teu email
//   EMAIL_FROM      - remetente (ver README para como configurar)

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
requireEnv('SHEET_ID', SHEET_ID);
requireEnv('SHEET_GID', SHEET_GID);
requireEnv('RESEND_API_KEY', RESEND_API_KEY);
requireEnv('EMAIL_TO', EMAIL_TO);

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
if(nyHour !== 16){
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

// --- 3. Calcula a variação do dia (mesma lógica do dashboard) ---
async function computeDailyChange(){
  const rows = await fetchSheet();
  if(rows.length < 2) throw new Error('A aba Dashboard está vazia.');

  const norm = (s) => (s || '').replace(/\s+/g, '').toUpperCase();
  const header = rows[0].map(norm);
  const idx = {
    ticker: header.indexOf('TICKER'),
    units: header.indexOf('UNITS'),
    status: header.indexOf('STATUS'),
    coin: header.indexOf('COIN'),
    currentO: header.indexOf('CURRENTPRICE(O)'),
    previousO: header.indexOf('PREVIOUSPRICE(O)')
  };
  if(idx.ticker === -1 || idx.units === -1 || idx.status === -1 || idx.currentO === -1 || idx.previousO === -1){
    throw new Error('Não encontrei as colunas TICKER, UNITS, STATUS, CURRENT PRICE (O) ou PREVIOUS PRICE (O) na aba Dashboard.');
  }

  const usdEurRate = await fetchUsdEurRate();

  let totalToday = 0, totalYesterday = 0;
  const valueByTicker = new Map(); // ticker -> valor atual (€), para saber as maiores posições
  rows.slice(1).forEach(r => {
    if(!r[idx.ticker] || !r[idx.ticker].trim()) return;
    if((r[idx.status] || '').trim().toLowerCase() !== 'open') return;
    const qty = num(r[idx.units]);
    const current = num(r[idx.currentO]);
    const previous = num(r[idx.previousO]);
    if(isNaN(qty) || isNaN(current) || isNaN(previous)) return;
    const currency = (r[idx.coin] || 'EUR').trim().toUpperCase();
    const fx = currency === 'USD' ? usdEurRate : 1;
    const valueEur = qty * current * fx;
    totalToday += valueEur;
    totalYesterday += qty * previous * fx;

    const ticker = r[idx.ticker].trim();
    valueByTicker.set(ticker, (valueByTicker.get(ticker) || 0) + valueEur);
  });

  const changeValue = totalToday - totalYesterday;
  const changePct = totalYesterday !== 0 ? (changeValue / totalYesterday) * 100 : 0;

  const topTickers = [...valueByTicker.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, NEWS_TICKER_COUNT)
    .map(([ticker]) => ticker);

  return { totalToday, totalYesterday, changeValue, changePct, topTickers };
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
  const summary = {
    updatedAt: new Date().toISOString(),
    totalToday: Math.round(totalToday * 100) / 100,
    changeValue: Math.round(changeValue * 100) / 100,
    changePct: Math.round(changePct * 100) / 100,
    currency: 'EUR'
  };
  await mkdir('docs', { recursive: true });
  await writeFile('docs/summary.json', JSON.stringify(summary, null, 2));
  console.log('docs/summary.json atualizado.');
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
  console.log('docs/news.json atualizado.');
}

// --- Main ---
try{
  const data = await computeDailyChange();
  const weeklyNews = await fetchWeeklyNews(data.topTickers);
  await sendEmail(data);
  await writeSummaryJson(data);
  await writeNewsJson(weeklyNews);
}catch(err){
  console.error('Erro:', err.message);
  process.exit(1);
}
