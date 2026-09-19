const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const INDEX = path.join(ROOT, 'index.html');

const PAIRS = ['EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD'];

// Premium-only instruments. The existing forex set above is intentionally preserved.
// Biquote uses compact MT5-style symbols for these markets.
const PREMIUM_MARKETS = [
  { symbol: 'US30', display: 'US30', name: 'Dow Jones 30', category: 'Index' },
  { symbol: 'US100', display: 'NAS100', name: 'NASDAQ 100', category: 'Index' },
  { symbol: 'US500', display: 'SPX500', name: 'S&P 500', category: 'Index' },
  { symbol: 'DE40', display: 'GER40', name: 'Germany 40 / DAX', category: 'Index' },
  { symbol: 'UK100', display: 'UK100', name: 'FTSE 100', category: 'Index' },
  { symbol: 'JP225', display: 'JP225', name: 'Nikkei 225', category: 'Index' },
  { symbol: 'HK50', display: 'HK50', name: 'Hang Seng 50', category: 'Index' },
  { symbol: 'AUS200', display: 'AUS200', name: 'Australia 200', category: 'Index' },
  { symbol: 'XAU/USD', display: 'XAUUSD', name: 'Gold', category: 'Metal' },
  { symbol: 'XAG/USD', display: 'XAGUSD', name: 'Silver', category: 'Metal' }
];

const PREMIUM_SYMBOLS = PREMIUM_MARKETS.map(m => m.symbol);
const cache = new Map();
const CACHE_MS = 60_000;
const HISTORY_CACHE_MS = 15 * 60_000;

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(body));
}

async function biquote(pathname, params = {}) {
  const url = new URL(`https://biquote.io/api${pathname}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.message || `Biquote returned HTTP ${response.status}`);
  }
  return data;
}

async function getQuote(symbol) {
  const key = `quote:${symbol}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const value = await biquote(`/${symbol.replace('/', '')}`);
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function getHistory(symbol) {
  const key = `history:${symbol}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < HISTORY_CACHE_MS) return cached.value;
  const value = await biquote(`/${symbol.replace('/', '')}/ohlc`, {
    interval: '1h',
    limit: 100
  });
  cache.set(key, { at: Date.now(), value });
  return value;
}

function atr(bars, period = 14) {
  if (!bars || bars.length < period + 1) return null;
  const chronological = [...bars].reverse();
  const trs = [];
  for (let i = 1; i < chronological.length; i++) {
    const b = chronological[i];
    const prev = chronological[i - 1];
    const high = Number(b.high), low = Number(b.low), prevClose = Number(prev.close);
    trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  const recent = trs.slice(-period);
  return recent.reduce((a, b) => a + b, 0) / recent.length;
}

function sma(values, period) {
  if (values.length < period) return null;
  const s = values.slice(-period);
  return s.reduce((a, b) => a + b, 0) / period;
}

function rsi(closes, period = 14) {
  if (closes.length <= period) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d; else losses -= d;
  }
  if (losses === 0) return 100;
  return 100 - (100 / (1 + gains / losses));
}

function decimals(symbol) {
  if (symbol.endsWith('/JPY')) return 3;
  if (['XAU/USD', 'XAG/USD'].includes(symbol)) return 2;
  if (['US30', 'US100', 'US500', 'DE40', 'UK100', 'JP225', 'HK50', 'AUS200'].includes(symbol)) return 2;
  return 5;
}

function round(value, places) {
  const p = 10 ** places;
  return Math.round(value * p) / p;
}

function analyze(symbol, quote, history) {
  const bars = history.bars || [];
  const closes = bars.map(b => Number(b.close)).reverse();
  const chronologicalBars = [...bars].reverse();
  const price = Number(quote.mid);
  const fast = sma(closes, 20);
  const slow = sma(closes, 50);
  const momentum = rsi(closes);
  const volatility = atr(bars);
  const places = decimals(symbol);
  const recentBars = chronologicalBars.slice(-20);
  const recentHigh = recentBars.length ? Math.max(...recentBars.map(b => Number(b.high))) : null;
  const recentLow = recentBars.length ? Math.min(...recentBars.map(b => Number(b.low))) : null;
  const previousClose = closes.length >= 2 ? closes[closes.length - 2] : null;
  const lastMove = previousClose != null ? price - previousClose : 0;

  // Each strategy is evaluated independently. The final signal is based on
  // the combined evidence, while Premium receives every strategy's evidence.
  const strategies = [];
  const add = (name, direction, score, evidence, status) => strategies.push({ name, direction, score, evidence, status });

  const trendBull = fast != null && slow != null && fast > slow;
  const trendBear = fast != null && slow != null && fast < slow;
  add('Trend-following', trendBull ? 'BUY' : trendBear ? 'SELL' : 'WAIT',
    trendBull ? 2 : trendBear ? -2 : 0,
    fast != null && slow != null ? `SMA20 ${trendBull ? 'is above' : trendBear ? 'is below' : 'equals'} SMA50 (${round(fast, places)} vs ${round(slow, places)}).` : 'SMA20/SMA50 data unavailable.',
    trendBull || trendBear ? 'active' : 'neutral');

  const momentumBull = momentum > 55;
  const momentumBear = momentum < 45;
  add('Momentum', momentumBull ? 'BUY' : momentumBear ? 'SELL' : 'WAIT',
    momentumBull ? 1 : momentumBear ? -1 : 0,
    `RSI is ${round(momentum, 1)}; ${momentumBull ? 'bullish momentum is present' : momentumBear ? 'bearish momentum is present' : 'momentum is neutral'}.`,
    momentumBull || momentumBear ? 'active' : 'neutral');

  const range = recentHigh != null && recentLow != null ? recentHigh - recentLow : null;
  const nearHigh = recentHigh != null && price >= recentHigh - (range || price * 0.002) * 0.08;
  const nearLow = recentLow != null && price <= recentLow + (range || price * 0.002) * 0.08;
  const breakoutBull = nearHigh && lastMove > 0;
  const breakoutBear = nearLow && lastMove < 0;
  add('Breakout / breakdown', breakoutBull ? 'BUY' : breakoutBear ? 'SELL' : 'WAIT',
    breakoutBull ? 2 : breakoutBear ? -2 : 0,
    recentHigh != null && recentLow != null
      ? `Price ${round(price, places)} is ${nearHigh ? 'near the recent high' : nearLow ? 'near the recent low' : 'inside the recent range'} (${round(recentLow, places)}–${round(recentHigh, places)}); latest move is ${lastMove > 0 ? 'up' : lastMove < 0 ? 'down' : 'flat'}.`
      : 'Recent range data unavailable.',
    breakoutBull || breakoutBear ? 'active' : 'watch');

  const supportBull = nearLow && lastMove > 0;
  const resistanceBear = nearHigh && lastMove < 0;
  add('Support / resistance reaction', supportBull ? 'BUY' : resistanceBear ? 'SELL' : 'WAIT',
    supportBull ? 1 : resistanceBear ? -1 : 0,
    recentHigh != null && recentLow != null
      ? `${supportBull ? 'Price is reacting upward from the recent low.' : resistanceBear ? 'Price is reacting downward near the recent high.' : 'No clear support/resistance reaction is confirmed.'}`
      : 'Support/resistance range unavailable.',
    supportBull || resistanceBear ? 'active' : 'neutral');

  const bullishCandle = chronologicalBars.length >= 2 && Number(chronologicalBars.at(-1).close) > Number(chronologicalBars.at(-1).open);
  const bearishCandle = chronologicalBars.length >= 2 && Number(chronologicalBars.at(-1).close) < Number(chronologicalBars.at(-1).open);
  add('Price action', bullishCandle ? 'BUY' : bearishCandle ? 'SELL' : 'WAIT',
    bullishCandle ? 1 : bearishCandle ? -1 : 0,
    `Latest hourly candle closed ${bullishCandle ? 'above' : bearishCandle ? 'below' : 'at'} its open.`,
    bullishCandle || bearishCandle ? 'active' : 'neutral');

  const totalScore = strategies.reduce((sum, s) => sum + s.score, 0);
  const signal = totalScore >= 3 ? 'BUY' : totalScore <= -3 ? 'SELL' : 'WAIT';
  const supporting = strategies.filter(s => (signal === 'BUY' && s.score > 0) || (signal === 'SELL' && s.score < 0));
  const opposing = strategies.filter(s => (signal === 'BUY' && s.score < 0) || (signal === 'SELL' && s.score > 0));
  const ranked = [...strategies].sort((a,b) => Math.abs(b.score) - Math.abs(a.score));
  const primary = ranked.find(s => s.score !== 0) || strategies[0];
  const strategy = primary && primary.score !== 0
    ? `${primary.name}${supporting.length > 1 ? ' + confirmation from ' + supporting.slice(1).map(s => s.name).join(' + ') : ''}`
    : 'No strategy has enough confirmation';

  const reasons = supporting.map(s => `${s.name}: ${s.evidence}`);
  if (opposing.length) reasons.push(`Opposing evidence: ${opposing.map(s => `${s.name} (${s.direction})`).join(', ')}.`);
  if (!reasons.length) reasons.push('The strategy scores are mixed, so there is no strong directional confirmation.');

  const direction = signal === 'SELL' ? -1 : signal === 'BUY' ? 1 : 0;
  const entry = price;
  const atrValue = volatility || price * 0.002;

  // Closer, structure-aware targets. The first target is intentionally
  // conservative, but no market target can be guaranteed.
  const risk = atrValue * 1.10;
  const sl = direction === 0 ? entry - risk : entry - direction * risk;

  const roomToStructure = direction === 1 && recentHigh != null && recentHigh > entry
    ? recentHigh - entry
    : direction === -1 && recentLow != null && recentLow < entry
      ? entry - recentLow
      : null;

  const targetAtR = r => entry + direction * (risk * r);
  const targetAtDistance = distance => entry + direction * distance;

  let tp1 = direction === 0 ? entry + risk * 0.80 : targetAtR(0.80);
  let tp2 = direction === 0 ? entry + risk * 1.20 : targetAtR(1.20);
  let tp3 = direction === 0 ? entry + risk * 1.80 : targetAtR(1.80);

  if (direction !== 0 && roomToStructure != null && roomToStructure > 0) {
    tp1 = targetAtDistance(Math.min(risk * 0.80, roomToStructure * 0.60));
    tp2 = targetAtDistance(Math.min(risk * 1.20, roomToStructure * 0.90));
    tp3 = targetAtDistance(Math.min(risk * 1.80, roomToStructure));
  }

  // Standard/free dashboard uses the conservative first target.
  const tp = tp1;
  const riskReward = direction === 0 ? '1 : 0.8' : '1 : 0.8 (TP1)';
  const confidence = Math.max(50, Math.min(94, Math.round(52 + Math.abs(totalScore) * 7 + Math.abs(momentum - 50) * 0.22)));

  const meta = PREMIUM_MARKETS.find(m => m.symbol === symbol);

  return {
    symbol,
    displaySymbol: meta?.display || symbol,
    marketName: meta?.name || symbol,
    category: meta?.category || 'Forex',
    signal, price: round(price, places),
    change: quote.dayDiffPercent != null ? Number(quote.dayDiffPercent) : null,
    entry: round(entry, places), stopLoss: round(sl, places), takeProfit: round(tp, places),
    takeProfit1: round(tp1, places), takeProfit2: round(tp2, places), takeProfit3: round(tp3, places),
    riskReward, confidence,
    indicators: {
      rsi: round(momentum, 1), sma20: fast ? round(fast, places) : null, sma50: slow ? round(slow, places) : null,
      atr: round(atrValue, places), recent20High: recentHigh != null ? round(recentHigh, places) : null,
      recent20Low: recentLow != null ? round(recentLow, places) : null
    },
    strategy, primaryStrategy: primary?.name || 'None',
    strategies, supportingStrategies: supporting.map(s => s.name), opposingStrategies: opposing.map(s => s.name),
    score: totalScore, reasons, updatedAt: new Date().toISOString()
  };
}
async function markets() {
  return Promise.all(PAIRS.map(async symbol => {
    const [quote, history] = await Promise.all([getQuote(symbol), getHistory(symbol)]);
    return analyze(symbol, quote, history);
  }));
}


function extractOutputText(data) {
  if (typeof data.output_text === 'string') return data.output_text.trim();
  const parts = [];
  for (const item of (data.output || [])) {
    for (const content of (item.content || [])) {
      if (content.type === 'output_text' && content.text) parts.push(content.text);
    }
  }
  return parts.join('\n').trim();
}

function findRelevant(question, marketsData) {
  const q = question.toLowerCase().replace(/\s+/g, ' ');
  return marketsData.find(m => {
    const aliases = [
      m.symbol,
      m.displaySymbol,
      m.marketName,
      ...(m.symbol === 'US30' ? ['dow', 'dow jones', 'us30'] : []),
      ...(m.symbol === 'US100' ? ['nasdaq', 'nasdaq 100', 'nas100', 'us100'] : []),
      ...(m.symbol === 'DE40' ? ['germany 40', 'german 30', 'german 40', 'ger30', 'ger40', 'dax'] : []),
      ...(m.symbol === 'XAU/USD' ? ['gold', 'xauusd', 'xau/usd'] : []),
      ...(m.symbol === 'XAG/USD' ? ['silver', 'xagusd', 'xag/usd'] : [])
    ];
    return aliases.some(a => q.includes(String(a).toLowerCase().replace('/', '')));
  }) || marketsData[0];
}

function basicFallback(question, marketsData) {
  const relevant = findRelevant(question, marketsData);
  if (!relevant) return "Ask me about a currency pair, forex concept, trend, price movement, or the live market dashboard.";
  const direction = relevant.signal === 'BUY' ? 'bullish' : relevant.signal === 'SELL' ? 'bearish' : 'mixed';
  return `Quick view for ${relevant.symbol}: the current dashboard signal is ${relevant.signal}. The market structure shown here is ${direction}. Current price is ${relevant.price}. RSI is ${relevant.indicators.rsi}. This is a basic market overview, not a guaranteed outcome.`;
}

function premiumFallback(question, marketsData) {
  const m = findRelevant(question, marketsData);
  if (!m) return basicFallback(question, marketsData);
  const i = m.indicators || {};
  const strategyLines = (m.strategies || []).map(s =>
    `• ${s.name}: ${s.direction} | score ${s.score > 0 ? '+' : ''}${s.score} | ${s.evidence}`
  ).join('\n');
  const support = (m.supportingStrategies || []).join(', ') || 'None';
  const oppose = (m.opposingStrategies || []).join(', ') || 'None';
  const opposite = m.signal === 'BUY' ? 'SELL' : m.signal === 'SELL' ? 'BUY' : 'a directional trade';
  return `PREMIUM MARKET ANALYSIS — ${m.symbol}\n\nSIGNAL: ${m.signal}\n\nWHY ${m.signal}?\n${(m.reasons || []).map(x => `• ${x}`).join('\n')}\n\nSTRATEGY ENGINE\nPrimary strategy: ${m.primaryStrategy}\nCombined strategy: ${m.strategy}\nTotal strategy score: ${m.score}\n\nSTRATEGY-BY-STRATEGY BREAKDOWN\n${strategyLines}\n\nWHY NOT ${opposite}?\nThe engine compared the independent strategies rather than using one fixed rule. Supporting strategies: ${support}. Opposing strategies: ${oppose}. If the opposing evidence strengthens, the signal can change.\n\nINDICATOR EVIDENCE\n• RSI: ${i.rsi ?? 'unavailable'}\n• SMA20: ${i.sma20 ?? 'unavailable'}\n• SMA50: ${i.sma50 ?? 'unavailable'}\n• Current price: ${m.price}\n• Recent 20-bar high: ${i.recent20High ?? 'unavailable'}\n• Recent 20-bar low: ${i.recent20Low ?? 'unavailable'}\n\nLEVELS & RISK\n• Entry/reference: ${m.entry}\n• Stop loss: ${m.stopLoss}\n• TP1 (conservative): ${m.takeProfit1 ?? m.takeProfit}\n• TP2 (main): ${m.takeProfit2 ?? 'unavailable'}\n• TP3 (extended): ${m.takeProfit3 ?? 'unavailable'}\n• Risk/reward: ${m.riskReward}\n\nCONFIDENCE\nDashboard confidence: ${m.confidence}/100. This is a signal-strength metric, not a probability of profit.\n\nThis analysis is educational and does not guarantee a trading result.`;
}
async function askAI(question, tier, marketsData) {
  const key = process.env.OPENAI_API_KEY;
  const premium = tier === 'premium' && process.env.PREMIUM_DEMO === 'true';
  const model = premium ? (process.env.PREMIUM_AI_MODEL || 'gpt-5.6-sol') :
    (process.env.FREE_AI_MODEL || 'gpt-5.6-luna');

  const marketContext = JSON.stringify(marketsData.map(m => ({
    symbol: m.symbol, signal: m.signal, price: m.price, change: m.change,
    entry: m.entry, stopLoss: m.stopLoss, takeProfit: m.takeProfit,
    takeProfit1: m.takeProfit1, takeProfit2: m.takeProfit2, takeProfit3: m.takeProfit3,
    riskReward: m.riskReward, confidence: m.confidence, indicators: m.indicators,
    strategy: m.strategy, primaryStrategy: m.primaryStrategy, score: m.score, strategies: m.strategies, supportingStrategies: m.supportingStrategies, opposingStrategies: m.opposingStrategies, reasons: m.reasons
  })));

  const instructions = premium
    ? `You are Forex Clause AI PREMIUM, a transparent forex market analysis engine.
Your most important job is to explain HOW and WHY the dashboard reached its signal, not merely repeat BUY/SELL/WAIT.
Use ONLY the supplied live dashboard data. Never invent indicators, prices, news, support/resistance levels, or events.

For every question about a trade, signal, or why the market is BUY/SELL/WAIT, structure the answer with these headings when relevant:
1. SIGNAL — state the current dashboard signal.
2. WHY — give the concrete evidence from the supplied data, including RSI, SMA20 vs SMA50, recent price movement, and recent 20-bar high/low when relevant.
3. STRATEGY USED — name the primary strategy and the confirming strategies from the independent strategy engine. Explain the actual conditions that triggered each one. Do not pretend that one hard-coded strategy was used.
4. WHY NOT THE OPPOSITE — explain which evidence argues against the opposite direction, or say that the data is mixed.
5. LEVELS & RISK — show the supplied entry, stop loss, and Premium TP1/TP2/TP3 when available. Explain that TP1 is the conservative first target, TP2 the main target, and TP3 the extended target. Do not present any level as a guarantee.
6. CONFIDENCE — report the supplied confidence as a dashboard metric and explain that it is not a probability of profit.

Do not hide the reasoning behind vague phrases like 'the market looks bullish'. Tie every conclusion to an actual supplied value.
If the data is insufficient, say exactly what is missing. Never claim certainty or guaranteed profits.
If asked for current news and no news data is supplied, say news data is not currently supplied.
This is educational market analysis, not personalized financial advice.`
    : `You are Forex Clause AI FREE, a concise forex education and market assistant.
Answer unlimited questions with short, clear, basic explanations. Use supplied live dashboard data when relevant.
You may mention the current signal and one or two simple reasons, but do not provide the Premium engine's full strategy breakdown,
detailed trade-plan reasoning, or multi-factor explanation. Never invent data or claim certainty or guaranteed profits.
This is educational information, not personalized financial advice.`;

  if (!key) {
    return premium ? premiumFallback(question, marketsData) : basicFallback(question, marketsData);
  }

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`
    },
    body: JSON.stringify({
      model,
      instructions,
      input: `Live Forex Clause dashboard data (this is the source of truth):\n${marketContext}\n\nUser question:\n${question}\n\nPREMIUM REQUIREMENT: If this is Premium, do not give a generic market summary. Directly identify the exact BUY/SELL/WAIT signal for the relevant pair, compare every independent strategy supplied in the data, identify the primary strategy and confirmations, explain each score/evidence item, and explain why the opposite signal was not selected.`,
      store: false
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error?.message || `AI service returned HTTP ${response.status}`);
  }

  return extractOutputText(data) || (premium ? premiumFallback(question, marketsData) : basicFallback(question, marketsData));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/api/markets') {
      return json(res, 200, { provider: 'Biquote', markets: await markets(), serverTime: new Date().toISOString() });
    }

    if (url.pathname === '/api/premium-markets') {
      const premiumResults = await Promise.all(PREMIUM_MARKETS.map(async meta => {
        try {
          const apiSymbol = meta.symbol.replace('/', '');
          const [quote, history] = await Promise.all([getQuote(apiSymbol), getHistory(apiSymbol)]);
          return analyze(meta.symbol, quote, history);
        } catch (err) {
          return {
            symbol: meta.symbol,
            displaySymbol: meta.display,
            marketName: meta.name,
            category: meta.category,
            unavailable: true,
            error: err.message
          };
        }
      }));
      return json(res, 200, {
        provider: 'Biquote',
        premiumOnly: true,
        markets: premiumResults,
        serverTime: new Date().toISOString()
      });
    }


    if (url.pathname === '/api/ai' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      let payload;
      try { payload = JSON.parse(body || '{}'); }
      catch { return json(res, 400, { error: 'Invalid JSON request.' }); }

      const question = String(payload.question || '').trim();
      const tier = payload.tier === 'premium' ? 'premium' : 'free';
      if (!question) return json(res, 400, { error: 'Please enter a question.' });
      if (question.length > 1200) return json(res, 400, { error: 'Question is too long.' });

      const currentMarkets = await markets();
      let aiMarkets = currentMarkets;

      if (tier === 'premium') {
        const premiumResults = await Promise.all(PREMIUM_MARKETS.map(async meta => {
          try {
            const apiSymbol = meta.symbol.replace('/', '');
            const [quote, history] = await Promise.all([getQuote(apiSymbol), getHistory(apiSymbol)]);
            return analyze(meta.symbol, quote, history);
          } catch {
            return null;
          }
        }));
        aiMarkets = [...currentMarkets, ...premiumResults.filter(Boolean)];
      }

      const answer = await askAI(question, tier, aiMarkets);
      return json(res, 200, {
        answer,
        tier,
        premiumActive: tier === 'premium' && process.env.PREMIUM_DEMO === 'true',
        premiumMarketsIncluded: tier === 'premium',
        generatedAt: new Date().toISOString()
      });
    }

    if (url.pathname === '/api/health') {
      return json(res, 200, { ok: true, configured: true, provider: 'Biquote' });
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(INDEX));
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  } catch (err) {
    console.error(err);
    json(res, 502, { error: err.message || 'Market data request failed.' });
  }
});

server.listen(PORT, () => {
  console.log(`Forex Clause running at http://localhost:${PORT}`);
  console.log('Using Biquote live market feed — no API key required.');
});
