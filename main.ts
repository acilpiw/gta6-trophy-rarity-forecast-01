// gta6-trophy-rarity-forecast-01 — trophy earn-rate forecaster.
//
// Model, in one paragraph: an earn rate grows toward a per-trophy
// ceiling roughly like a logistic curve in log-time (ln(1 + hours since
// release)). The median blends three candidates on the logit scale: a
// saturating logistic curve fitted per trophy in rate space (grid over
// midpoint and scale, asymptote by linear least squares, capped by
// tier), a logit-versus-log-time linear trend whose slope is shrunk
// toward its tier's median slope and whose extrapolation is damped and
// tanh-capped, and persistence itself. Fits run over the *distinct*
// snapshots in the case history only: Exophase refreshes its counts
// every few hours, so most reads are copies of the previous refresh and
// keeping the duplicates would overweight whichever regime happened to
// be sampled most. The trend is anchored on the trophy's latest observed
// logit, not on the fitted intercept, which drifts. The spread combines
// a random-walk term in sqrt(horizon), the trend fit's residual scale
// (shrunk toward the pooled residual), slope- and model-disagreement
// terms, and a floor for the jump risk of an Exophase refresh landing
// between the checkpoint and the target.
//
// One regime gets special handling: if the whole history is a single
// distinct snapshot (the tracked-player count never moved), the page has
// never refreshed inside the window we can see. The cohort behind such a
// page is a small pre-release group whose rates the first real refresh
// dilutes, so the median is shifted down on the logit scale and the
// spread is widened a lot. That is exactly the shape of the practice
// cases, and the same branch would fire on any case cut before the first
// refresh.
//
// Deterministic, standard library only, no network, no randomness.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
const Z = [-1.645, -0.674, 0, 0.674, 1.645];

// --- tunables -------------------------------------------------------------
const DELTA_CAP = 1.35; // tanh cap on the extrapolated logit move
const LINEAR_DAMP = 0.62; // extra damping on the logit-linear trend
const DILUTION_SHIFT = -0.85; // median shift when no refresh was ever seen
const RW_PER_SQRT_DAY = 0.42; // random-walk spread per sqrt(horizon day)
const SIGMA_FLOOR_LIVE = 0.38; // refresh-jump floor, history has refreshes
const SIGMA_FLOOR_STALE = 0.95; // refresh-jump floor, history never moved
const SIGMA_MIN = 0.22;
const SIGMA_MAX = 2.2;
// Generous ceilings for a one-week median, by tier: they only bite when a
// fitted trend would otherwise promise something no week-one game reaches.
const TIER_CEILING: Record<string, number> = {
  platinum: 20,
  gold: 65,
  silver: 80,
  bronze: 95,
};
const TIER_PRIOR: Record<string, number> = {
  platinum: 0.4,
  gold: 2.5,
  silver: 1.8,
  bronze: 1.2,
};

// --- types ----------------------------------------------------------------
interface TrophyMeta {
  id: number;
  tier: string;
}
interface ReadRec {
  at: string;
  players_tracked: number;
  rates: Array<number | null>;
}
interface CaseFile {
  id: string;
  at: string;
  target: string;
  horizon_minutes: number;
  levels: number[];
  game: { release_date?: string };
  trophies: TrophyMeta[];
  history: ReadRec[];
}
interface Snapshot {
  x: number; // ln(1 + hours since release midnight UTC)
  players: number;
  rates: Array<number | null>;
}

// --- small numeric helpers --------------------------------------------------
const clampPct = (v: number): number => Math.min(99.99, Math.max(0.01, v));
const logitOf = (pct: number): number => {
  const p = clampPct(pct) / 100;
  return Math.log(p / (1 - p));
};
const pctOf = (l: number): number => 100 / (1 + Math.exp(-l));
const round4 = (v: number): number => Math.round(v * 10000) / 10000;

function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Weighted least squares y ~ a + b*x. Returns null when the points cannot
// pin a slope down (too few points, or no spread in x).
function fitLine(
  pts: Array<{ x: number; y: number; w: number }>,
): { a: number; b: number; resid: number; xSpan: number } | null {
  if (pts.length < 3) return null;
  let sw = 0;
  let sx = 0;
  let sy = 0;
  for (const p of pts) {
    sw += p.w;
    sx += p.w * p.x;
    sy += p.w * p.y;
  }
  if (sw <= 0) return null;
  const mx = sx / sw;
  const my = sy / sw;
  let sxx = 0;
  let sxy = 0;
  let xMin = Infinity;
  let xMax = -Infinity;
  for (const p of pts) {
    const dx = p.x - mx;
    sxx += p.w * dx * dx;
    sxy += p.w * dx * (p.y - my);
    if (p.x < xMin) xMin = p.x;
    if (p.x > xMax) xMax = p.x;
  }
  const xSpan = xMax - xMin;
  if (sxx < 1e-9 || xSpan < 1e-6) return null;
  const b = sxy / sxx;
  const a = my - b * mx;
  let sr = 0;
  for (const p of pts) {
    const r = p.y - (a + b * p.x);
    sr += p.w * r * r;
  }
  return { a, b, resid: Math.sqrt(sr / sw), xSpan };
}

// Saturating curve in rate space: r(x) = A / (1 + exp(-(x - m) / s)) with
// x = ln(1 + hours since release). For fixed (m, s) the asymptote A is a
// one-parameter linear least-squares problem, so a coarse grid over
// (m, s) finds a good curve cheaply and deterministically. The grid is
// centred on the observed x-range and reaches past the target, because a
// trophy whose midpoint sits beyond the target is still on its rising
// limb at the checkpoint. Returns the fitted rate at xTarget, or null
// when the series is too short or too flat in x to identify a curve.
function fitSaturatingCurve(
  pts: Array<{ x: number; r: number; w: number }>,
  xTarget: number,
  ceiling: number,
): { rTarget: number; residRel: number } | null {
  if (pts.length < 5) return null;
  let xMin = Infinity;
  let xMax = -Infinity;
  let maxR = 0;
  let sw = 0;
  let sr = 0;
  for (const p of pts) {
    if (p.x < xMin) xMin = p.x;
    if (p.x > xMax) xMax = p.x;
    if (p.r > maxR) maxR = p.r;
    sw += p.w;
    sr += p.w * p.r;
  }
  if (xMax - xMin < 0.8 || sw <= 0) return null;
  const meanR = sr / sw;
  let best: { a: number; m: number; s: number; resid: number } | null = null;
  for (let m = xMin - 0.5; m <= xTarget + 1.5; m += 0.25) {
    for (let s = 0.3; s <= 1.61; s += 0.13) {
      let num = 0;
      let den = 0;
      const shape: number[] = [];
      for (const p of pts) {
        const g = 1 / (1 + Math.exp(-(p.x - m) / s));
        shape.push(g);
        num += p.w * p.r * g;
        den += p.w * g * g;
      }
      if (den < 1e-9) continue;
      let a = num / den;
      if (a < maxR * 0.98) a = maxR * 0.98;
      if (a > ceiling) a = ceiling;
      let err = 0;
      for (let k = 0; k < pts.length; k++) {
        const d = pts[k].r - a * shape[k];
        err += pts[k].w * d * d;
      }
      const resid = Math.sqrt(err / sw);
      if (best === null || resid < best.resid) best = { a, m, s, resid };
    }
  }
  if (best === null) return null;
  const gT = 1 / (1 + Math.exp(-(xTarget - best.m) / best.s));
  return {
    rTarget: best.a * gT,
    residRel: best.resid / Math.max(1, meanR),
  };
}

// --- per-case forecast ------------------------------------------------------
function forecastCase(c: CaseFile): Array<{ id: number; q: number[] }> {
  const trophies = c.trophies;
  const n = trophies.length;
  const originMs = Date.parse(`${c.game.release_date ?? '2026-11-19'}T00:00:00Z`);
  const hoursOf = (iso: string): number =>
    Math.max(0, (Date.parse(iso) - originMs) / 3600000);
  const xOf = (iso: string): number => Math.log(1 + hoursOf(iso));
  const xTarget = xOf(c.target);
  const horizonDays = Math.max(0, c.horizon_minutes) / 1440;

  // Collapse the history to distinct snapshots: a read counts only when
  // the tracked-player count or at least one rate actually changed.
  const snaps: Snapshot[] = [];
  for (const rec of c.history) {
    const prev = snaps.length > 0 ? snaps[snaps.length - 1] : null;
    if (prev !== null) {
      let changed = rec.players_tracked !== prev.players;
      if (!changed) {
        for (let i = 0; i < n; i++) {
          if (rec.rates[i] !== prev.rates[i]) {
            changed = true;
            break;
          }
        }
      }
      if (!changed) continue;
    }
    snaps.push({ x: xOf(rec.at), players: rec.players_tracked, rates: rec.rates });
  }
  const staleFlat = snaps.length <= 1;
  const lastSnap = snaps.length > 0 ? snaps[snaps.length - 1] : null;
  const lastPlayers = lastSnap !== null ? Math.max(1, lastSnap.players) : 1;
  const xLast = lastSnap !== null ? lastSnap.x : 0;
  const dx = Math.max(0, xTarget - xLast);

  // Cross-sectional tier medians of the last snapshot: the prior for any
  // trophy whose own series is missing or unusable.
  const tierLastRates = new Map<string, number[]>();
  if (lastSnap !== null) {
    for (let i = 0; i < n; i++) {
      const r = lastSnap.rates[i];
      if (r === null || r === undefined) continue;
      const arr = tierLastRates.get(trophies[i].tier) ?? [];
      arr.push(r);
      tierLastRates.set(trophies[i].tier, arr);
    }
  }
  const tierPriorPct = (tier: string): number => {
    const arr = tierLastRates.get(tier);
    if (arr !== undefined && arr.length > 0) return medianOf(arr);
    return TIER_PRIOR[tier] ?? 1;
  };

  // First pass: per-trophy fits over the distinct snapshots.
  interface Fit {
    slope: number | null;
    resid: number | null;
    anchor: number | null; // logit of the (smoothed) latest rate
    pts: number;
    xSpan: number;
    curve: { rTarget: number; residRel: number } | null;
  }
  const fits: Fit[] = [];
  for (let i = 0; i < n; i++) {
    const pts: Array<{ x: number; y: number; w: number }> = [];
    const rPts: Array<{ x: number; r: number; w: number }> = [];
    for (let k = 0; k < snaps.length; k++) {
      const r = snaps[k].rates[i];
      if (r === null || r === undefined) continue;
      const recency = snaps.length > 1 ? k / (snaps.length - 1) : 1;
      const sizeW = 0.5 + 0.5 * Math.sqrt(Math.min(1, snaps[k].players / lastPlayers));
      const w = (0.3 + 0.7 * recency) * sizeW;
      pts.push({ x: snaps[k].x, y: logitOf(r), w });
      rPts.push({ x: snaps[k].x, r, w });
    }
    // Anchor: weighted mean of the last up-to-three observed logits, so a
    // single noisy final read does not own the forecast.
    let anchor: number | null = null;
    if (pts.length > 0) {
      const tail = pts.slice(-3);
      const tw = [0.35, 0.6, 1].slice(3 - tail.length);
      let sw = 0;
      let sy = 0;
      for (let j = 0; j < tail.length; j++) {
        sw += tw[j];
        sy += tw[j] * tail[j].y;
      }
      anchor = sy / sw;
    }
    const fit = fitLine(pts);
    const curve = fitSaturatingCurve(
      rPts,
      xTarget,
      TIER_CEILING[trophies[i].tier] ?? 95,
    );
    fits.push({
      slope: fit !== null ? fit.b : null,
      resid: fit !== null ? fit.resid : null,
      anchor,
      pts: pts.length,
      xSpan: fit !== null ? fit.xSpan : 0,
      curve,
    });
  }

  // Pooled slopes and residual scales, per tier and overall.
  const slopesByTier = new Map<string, number[]>();
  const allSlopes: number[] = [];
  const allResids: number[] = [];
  for (let i = 0; i < n; i++) {
    if (fits[i].slope !== null) {
      const arr = slopesByTier.get(trophies[i].tier) ?? [];
      arr.push(fits[i].slope as number);
      slopesByTier.set(trophies[i].tier, arr);
      allSlopes.push(fits[i].slope as number);
    }
    if (fits[i].resid !== null) allResids.push(fits[i].resid as number);
  }
  const overallSlope = allSlopes.length > 0 ? medianOf(allSlopes) : 0;
  const pooledResid = allResids.length > 0 ? medianOf(allResids) : 0.3;
  const tierSlope = (tier: string): number => {
    const arr = slopesByTier.get(tier);
    return arr !== undefined && arr.length > 0 ? medianOf(arr) : overallSlope;
  };

  // Second pass: shrunk extrapolation + calibrated spread per trophy.
  const rows: Array<{ id: number; q: number[] }> = [];
  for (let i = 0; i < n; i++) {
    const tier = trophies[i].tier;
    const f = fits[i];
    const bTier = tierSlope(tier);
    let bUse = bTier;
    let disagree = 0;
    if (f.slope !== null) {
      const trust =
        (f.pts / (f.pts + 5)) * (f.xSpan / (f.xSpan + 0.8));
      bUse = trust * f.slope + (1 - trust) * bTier;
      disagree = Math.abs(f.slope - bUse);
    }
    const anchorLogit =
      f.anchor !== null ? f.anchor : logitOf(tierPriorPct(tier));
    // Three candidate medians, blended on the logit scale. Persistence is
    // the anchor itself. The logit-linear trend is damped twice (a factor
    // on the slope, then the tanh cap) because a saturating curve's local
    // log-time slope overstates its own move over a long horizon. The
    // saturating-curve fit carries the most weight when it fits well:
    // it is the only candidate that knows a trophy can run out of
    // headroom before the target.
    const linDelta =
      DELTA_CAP * Math.tanh((LINEAR_DAMP * bUse * dx) / DELTA_CAP);
    const yLinear = anchorLogit + linDelta;
    let yMed: number;
    let yCurveLogit: number | null = null;
    if (f.curve !== null && f.curve.residRel < 0.6 && !staleFlat) {
      yCurveLogit = logitOf(Math.max(0.01, f.curve.rTarget));
      yMed = 0.5 * yCurveLogit + 0.3 * yLinear + 0.2 * anchorLogit;
    } else {
      yMed = 0.55 * yLinear + 0.45 * anchorLogit;
    }
    const lastRate =
      lastSnap !== null ? lastSnap.rates[i] : null;
    const pinnedHigh = lastRate !== null && lastRate !== undefined && lastRate >= 99.9;
    if (staleFlat && !pinnedHigh) yMed += DILUTION_SHIFT;
    let medPct = pctOf(yMed);
    const ceiling = TIER_CEILING[tier] ?? 95;
    if (medPct > ceiling && !pinnedHigh) medPct = ceiling;
    if (medPct < 0.02) medPct = 0.02;
    yMed = logitOf(medPct);

    const residUse =
      f.resid !== null ? 0.5 * Math.min(f.resid, 1.2) + 0.5 * pooledResid : pooledResid;
    const rw = RW_PER_SQRT_DAY * Math.sqrt(horizonDays);
    const floorTerm = staleFlat ? SIGMA_FLOOR_STALE : SIGMA_FLOOR_LIVE;
    // When the curve and the trend disagree about the median, that
    // disagreement is itself uncertainty and widens the spread.
    const modelDis =
      yCurveLogit !== null ? Math.abs(yCurveLogit - yLinear) : 0;
    let sigma = Math.sqrt(
      rw * rw + (0.6 * residUse) * (0.6 * residUse) +
        (0.3 * disagree * dx) * (0.3 * disagree * dx) +
        (0.25 * modelDis) * (0.25 * modelDis) +
        floorTerm * floorTerm + 0.12 * 0.12,
    );
    if (f.anchor === null) sigma = Math.max(sigma, 1.3);
    if (pinnedHigh) sigma = Math.min(sigma, 0.5);
    sigma = Math.min(SIGMA_MAX, Math.max(SIGMA_MIN, sigma));

    const q: number[] = [];
    let prevQ = 0;
    for (let j = 0; j < LEVELS.length; j++) {
      let v = round4(pctOf(yMed + Z[j] * sigma));
      if (v < prevQ) v = prevQ;
      if (v > 100) v = 100;
      q.push(v);
      prevQ = v;
    }
    rows.push({ id: trophies[i].id, q });
  }
  return rows;
}

// --- main -------------------------------------------------------------------
mkdirSync(OUTPUT_DIR, { recursive: true });
const inputs = readdirSync(INPUT_DIR)
  .filter((f) => f.endsWith('.in'))
  .sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as CaseFile;
  if (
    c.levels.length !== LEVELS.length ||
    c.levels.some((t, j) => t !== LEVELS[j])
  ) {
    throw new Error(`${file}: unexpected levels ${JSON.stringify(c.levels)}`);
  }
  const trophies = forecastCase(c);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ trophies })}\n`);
}
