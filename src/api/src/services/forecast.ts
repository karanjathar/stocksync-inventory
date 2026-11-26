/**
 * Demand forecasting from order history: a level, a damped linear trend and a weekly pattern, estimated with plain arithmetic (no model service, fully
 * deterministic). A "series" is units sold per day, oldest first, ending with the last COMPLETE day; `startDow` is the weekday (0 = Sunday) of its first day.
 */
export const MIN_HISTORY_DAYS = 28;     // four weeks from the first sale
export const MIN_SELLING_DAYS = 8;      // and demand on at least eight different days: below that the pattern is noise

/** Drops the days before the first sale (a product that did not exist yet is not "zero demand"). */
export function trimLeadingZeros(series: number[], startDow: number): { series: number[]; startDow: number } {
  const first = series.findIndex((q) => q > 0);
  return first <= 0 ? { series, startDow } : { series: series.slice(first), startDow: (startDow + first) % 7 };
}

export function enoughHistory(series: number[]): boolean {
  return series.length >= MIN_HISTORY_DAYS && series.filter((q) => q > 0).length >= MIN_SELLING_DAYS;
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Weekly factors (average 1), pulled towards 1 while there are few weeks of data so one odd week cannot dominate. */
export function weeklyFactors(series: number[], startDow: number): number[] {
  const overall = mean(series);
  if (overall <= 0) return new Array<number>(7).fill(1);
  const weeks = Math.floor(series.length / 7);
  const shrink = weeks / (weeks + 3);
  const raw = Array.from({ length: 7 }, (_, d) => {
    const days = series.filter((_q, i) => (startDow + i) % 7 === d);
    return 1 + shrink * (mean(days) / overall - 1);
  });
  const norm = mean(raw);
  return raw.map((f) => f / norm);
}

/** Units expected on each of the next `horizon` days. */
export function forecastDaily(series: number[], startDow: number, horizon: number): number[] {
  if (!series.length || mean(series) <= 0) return new Array<number>(horizon).fill(0);
  const factors = weeklyFactors(series, startDow);
  const window = Math.min(series.length, 56);
  const offset = series.length - window;
  const y = series.slice(offset).map((q, i) => q / (factors[(startDow + offset + i) % 7] ?? 1)); // the weekly pattern taken out
  // Ordinary least squares line through the recent, de-seasonalised days.
  const mx = (window - 1) / 2; const my = mean(y);
  let sxy = 0; let sxx = 0;
  y.forEach((v, i) => { sxy += (i - mx) * (v - my); sxx += (i - mx) ** 2; });
  const slope = sxx > 0 ? sxy / sxx : 0;
  const level = my + slope * (window - 1 - mx);                    // the line's value on the last day
  const trend = Math.max(-0.02 * Math.max(level, 0), Math.min(0.02 * Math.max(level, 0), slope * 0.5)); // damped, and never more than ±2 % of the level per day
  return Array.from({ length: horizon }, (_, h) => Math.max(0, (level + trend * (h + 1)) * (factors[(startDow + series.length + h) % 7] ?? 1)));
}

export const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

/** The simplest sensible rival: tomorrow looks like the last seven days' average. */
export function naiveDaily(series: number[], horizon: number): number[] {
  return new Array<number>(horizon).fill(mean(series.slice(-7)));
}

export interface BacktestReport {
  folds: number; horizonDays: number; actualUnits: number;
  /** Weighted absolute percentage error of the forecast total over the horizon (lower is better). */
  modelError: number; naiveError: number;
  /** 1 − modelError / naiveError: positive means the forecast beat the baseline. */
  improvement: number;
}

/**
 * Rolling-origin back-test: for each of up to `folds` past dates, forecast the next `horizon` days from the history BEFORE that date only, and compare
 * the forecast total with what was actually sold, for the forecast and for the naive baseline.
 */
export function backtest(series: number[], startDow: number, horizon: number, folds = 8, step = 7): BacktestReport | undefined {
  let modelErr = 0; let naiveErr = 0; let actualTotal = 0; let used = 0;
  for (let k = 0; k < folds; k++) {
    const t = series.length - horizon - k * step;
    if (t < MIN_HISTORY_DAYS) break;
    const train = series.slice(0, t);
    const actual = sum(series.slice(t, t + horizon));
    modelErr += Math.abs(sum(forecastDaily(train, startDow, horizon)) - actual);
    naiveErr += Math.abs(sum(naiveDaily(train, horizon)) - actual);
    actualTotal += actual; used++;
  }
  if (!used || actualTotal <= 0) return undefined;
  const modelError = modelErr / actualTotal; const naiveError = naiveErr / actualTotal;
  return { folds: used, horizonDays: horizon, actualUnits: actualTotal, modelError, naiveError, improvement: naiveError > 0 ? 1 - modelError / naiveError : 0 };
}
