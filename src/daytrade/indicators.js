/**
 * Indicadores técnicos puros para o megabrain de day-trade.
 * Cada função recebe arrays de candles [{t,o,h,l,c,v}] (mais antigo -> mais recente)
 * e devolve um score normalizado em [-1, +1] (+ = pressão compradora/CALL).
 */

export function ema(values, period) {
  const k = 2 / (period + 1);
  let e = values[0];
  const out = [e];
  for (let i = 1; i < values.length; i++) out.push((e = values[i] * k + e * (1 - k)));
  return out;
}

function sma(values, period) {
  if (values.length < period) return null;
  let s = 0;
  for (let i = values.length - period; i < values.length; i++) s += values[i];
  return s / period;
}

const closes = (candles) => candles.map((c) => c.c);

/** Wilder — RSI(14): compra quando sobrevendido a recuperar, venda quando sobrecomprado a ceder. */
export function rsiScore(candles, period = 14) {
  const cs = closes(candles);
  if (cs.length < period + 2) return 0;
  let gains = 0;
  let losses = 0;
  for (let i = cs.length - period; i < cs.length; i++) {
    const d = cs[i] - cs[i - 1];
    if (d > 0) gains += d;
    else losses -= d;
  }
  if (losses === 0) return -0.6;
  const rs = gains / losses;
  const rsi = 100 - 100 / (1 + rs);
  // 50 -> 0 ; <30 oversold -> positivo ; >70 overbought -> negativo
  return clamp((50 - rsi) / 50);
}

/** Elder — cruzamento EMA9/EMA21 + inclinação da EMA21. */
export function elderScore(candles) {
  const cs = closes(candles);
  if (cs.length < 25) return 0;
  const f = ema(cs, 9);
  const s = ema(cs, 21);
  const cross = (f.at(-1) - s.at(-1)) / s.at(-1);
  const slope = (s.at(-1) - s.at(-6)) / s.at(-6);
  return clamp(cross * 400 + slope * 200);
}

/** Elder/MACD — histograma MACD(12,26,9): momentum da diferença. */
export function macdScore(candles) {
  const cs = closes(candles);
  if (cs.length < 40) return 0;
  const fast = ema(cs, 12);
  const slow = ema(cs, 26);
  const macd = fast.map((v, i) => v - slow[i]);
  const signal = ema(macd.slice(-35), 9);
  const hist = macd.at(-1) - signal.at(-1);
  const prev = macd.at(-2) - signal.at(-2);
  const price = cs.at(-1);
  return clamp((hist / price) * 40_000 + (hist - prev) / price * 20_000);
}

/** Bollinger — posição do fecho dentro das bandas(20,2): extremo superior vende, inferior compra. */
export function bollingerScore(candles, period = 20, k = 2) {
  const cs = closes(candles);
  if (cs.length < period) return 0;
  const m = sma(cs, period);
  let v = 0;
  for (let i = cs.length - period; i < cs.length; i++) v += (cs[i] - m) ** 2;
  const sd = Math.sqrt(v / period);
  if (!sd) return 0;
  const z = (cs.at(-1) - m) / (k * sd);
  return clamp(-z); // mean-reversion
}

/** Murphy — ROC/momentum de n períodos + confirmação por volume. */
export function momentumScore(candles, period = 10) {
  const cs = closes(candles);
  if (cs.length < period + 1) return 0;
  const roc = (cs.at(-1) - cs.at(-1 - period)) / cs.at(-1 - period);
  const volNow = sma(candles.map((c) => c.v), 5) || 0;
  const volAvg = sma(candles.map((c) => c.v), 20) || 1;
  const volBoost = clamp((volNow / volAvg - 1) / 2, -0.5, 0.5);
  return clamp(roc * 150 + volBoost * Math.sign(roc));
}

/** Nison — corpos de vela recentes: força e direção das últimas 3 velas. */
export function candleScore(candles) {
  if (candles.length < 4) return 0;
  let score = 0;
  for (const c of candles.slice(-3)) {
    const range = c.h - c.l;
    if (!range) continue;
    const body = (c.c - c.o) / range; // -1..1 corpo relativo
    score += body;
  }
  return clamp(score / 3);
}

/** Order-flow — imbalance do top do order book: (bidVol - askVol) / (bidVol + askVol). */
export function orderBookScore(ob) {
  if (!ob?.bids?.length || !ob?.asks?.length) return 0;
  const depth = 5;
  const b = ob.bids.slice(0, depth).reduce((a, x) => a + x[1], 0);
  const a = ob.asks.slice(0, depth).reduce((x, y) => x + y[1], 0);
  return b + a ? clamp((b - a) / (b + a)) : 0;
}

function clamp(x, lo = -1, hi = 1) {
  return Math.max(lo, Math.min(hi, x));
}
