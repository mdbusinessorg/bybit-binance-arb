import { rsiScore, elderScore, macdScore, bollingerScore, momentumScore, candleScore, orderBookScore } from './indicators.js';

/**
 * MEGABRAIN — motor de confluência: combina estratégias de livros clássicos de
 * análise técnica num score único em [-1, +1] com a contribuição de cada "livro".
 * score > 0 => CALL (sobe), < 0 => PUT (desce). |score| fraco => sem operação.
 */
export const BOOKS = [
  { id: 'wilder', name: 'Wilder (RSI)', weight: 0.18, fn: ({ candles }) => rsiScore(candles) },
  { id: 'elder', name: 'Elder (EMA/Impulse)', weight: 0.2, fn: ({ candles }) => elderScore(candles) },
  { id: 'macd', name: 'MACD Momentum', weight: 0.16, fn: ({ candles }) => macdScore(candles) },
  { id: 'bollinger', name: 'Bollinger (Reversão)', weight: 0.14, fn: ({ candles }) => bollingerScore(candles) },
  { id: 'murphy', name: 'Murphy (ROC/Volume)', weight: 0.14, fn: ({ candles }) => momentumScore(candles) },
  { id: 'nison', name: 'Nison (Velas)', weight: 0.1, fn: ({ candles }) => candleScore(candles) },
  { id: 'orderflow', name: 'Order Book Flow', weight: 0.08, fn: ({ orderBook }) => orderBookScore(orderBook) },
];

export function analyze({ candles, orderBook }) {
  const parts = BOOKS.map((b) => ({ book: b.name, id: b.id, score: round3(b.fn({ candles, orderBook })), weight: b.weight }));
  const score = parts.reduce((a, p) => a + p.score * p.weight, 0) / parts.reduce((a, p) => a + p.weight, 0);
  // concordância: fração dos livros que concordam com a direção do score
  const sign = Math.sign(score) || 1;
  const agree = parts.filter((p) => Math.sign(p.score) === sign && Math.abs(p.score) > 0.05).length / parts.length;
  return {
    score: round3(score),
    direction: score > 0 ? 'CALL' : score < 0 ? 'PUT' : null,
    agreement: round3(agree),
    parts,
  };
}

function round3(x) {
  return Math.round(x * 1000) / 1000;
}
