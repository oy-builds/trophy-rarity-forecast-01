// gta6-trophy-rarity-forecast-01: forecast each GTA VI PS5 trophy's Exophase earn rate at a case's target.
//
// Model (per trophy), built only from the case's own history:
//   - The page is a step function: Exophase refreshes it every few hours and the house's reads repeat the
//     same page between refreshes. Consecutive identical (players_tracked, rates) reads are collapsed to
//     one page state, so flat stretches are not counted many times.
//   - A rate is a count over a denominator: earners E = round(rate * players / 100). Each state is read
//     with a Jeffreys-style continuity correction, rate' = 100 * (E + 0.5) / (players + 1), which keeps a
//     printed 0.00 or 100.00 finite on the logit scale in proportion to how many players back it.
//   - logit(rate') is fit against x = ln(1 + hours since release) by weighted least squares over the
//     page states of the last day before the checkpoint (dynamics earlier than that belong to a
//     different regime of the launch): weights decay with a recency half-life, grow with how long the
//     page showed the state, and grow with the count backing the rate. Slopes are shrunk toward the
//     cross-trophy pooled slope (noisy short series borrow strength).
//   - The median anchors on the fit at the last state, then extrapolates with a saturating slope:
//     slope * tauD * (1 - exp(-dx / tauD)), so a trend is followed but never run away linearly in
//     log-time. The platinum's median is capped at the lowest other trophy's median (its earners are a
//     subset of every other trophy's).
//   - The spread combines the fit's residual scale (pooled across trophies), slope uncertainty over the
//     extrapolation distance, a random-walk term in sqrt(days of horizon), and a floor. A history that is
//     a single frozen page spanning the release gets a launch-rebase adjustment instead: the tracked base
//     of a just-launched game multiplies at the first refresh while earners lag, so medians shift down in
//     logit and the spread widens.
//
// Node 22, standard library only, no network, deterministic: the same case always writes the same bytes.
// Outside the grader's container, MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and /output:
//   mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
const Z = [-1.6448536269514722, -0.6744897501960817, 0, 0.6744897501960817, 1.6448536269514722];

// Tunable model parameters (chosen on simulated week-1 dynamics and the practice refresh scenario).
const P = {
  halfLifeH: 48, // recency half-life of a page state, hours
  tauD: 3, // saturating-extrapolation timescale, in ln(1 + hours)
  slopePoolTau: 1, // prior sd of a trophy's slope around the pooled slope, logit per x-unit
  kappaRW: 0.5, // random-walk spread, logit per sqrt(day of horizon)
  sigmaFloor: 0.14, // minimum total spread, logit
  residPoolN: 8, // pseudo-count for pooling residual variance across trophies
  anchorRecentH: 14, // window of recent states blended into the level anchor, hours
  anchorFitW: 1, // anchor = anchorFitW * fit-at-last + (1 - anchorFitW) * recent-states mean
  launchSigma: 0.58, // spread for a frozen pre-launch page (practice-style case)
  launchLogGrowth: 1.6, // expected logit drop of a typical rate at the first post-launch refresh
  relScale: 25, // reliability weight = rel / (rel + relScale); near 0 makes state weights uniform
  windowH: 20, // only page states from the last windowH hours before the checkpoint enter the fit
  minStates: 0, // if > 0, the window extends back to include at least this many states (0 = off)
  durCapH: 6, // a state's weight grows with how long the page showed it, capped at durCapH hours
};

interface TrophyMeta { id: number; tier: string }
interface Read { at: string; players_tracked: number; rates: Array<number | null> }
interface Case {
  id: string;
  at: string;
  target: string;
  horizon_minutes: number;
  levels: number[];
  game: { release_date: string };
  trophies: TrophyMeta[];
  history: Read[];
}

const clampPct = (x: number): number => Math.min(99.99, Math.max(0.01, x));
const logit = (pct: number): number => { const p = clampPct(pct) / 100; return Math.log(p / (1 - p)); };
const invLogit = (y: number): number => 100 / (1 + Math.exp(-y));
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;

/** Distinct consecutive page states: a state is (players_tracked, the full rates vector).
 *  Each state also gets `durH`: how long the page showed it, up to the next state or the checkpoint. */
function pageStates(c: Case): Array<{ t: number; players: number; rates: Array<number | null>; durH: number }> {
  const out: Array<{ t: number; players: number; rates: Array<number | null>; durH: number }> = [];
  let prevKey = '';
  for (const r of c.history) {
    const key = `${r.players_tracked}|${r.rates.map((v) => (v === null ? 'x' : v)).join(',')}`;
    if (key !== prevKey) {
      out.push({ t: Date.parse(r.at), players: r.players_tracked, rates: r.rates, durH: 0 });
      prevKey = key;
    }
  }
  const tCp = Date.parse(c.at);
  for (let k = 0; k < out.length; k++) {
    const end = k + 1 < out.length ? out[k + 1].t : tCp;
    out[k].durH = Math.max(0.05, (end - out[k].t) / 3_600_000);
  }
  return out;
}

interface Fit {
  anchor: number; // fitted level at the last state's x, blended with the recent mean
  slope: number; // shrunk slope, logit per x-unit
  slopeSe: number;
  residSd: number;
  n: number;
  lastY: number;
}

function forecastCase(c: Case): Array<{ id: number; q: number[] }> {
  const t0 = Date.parse(`${c.game.release_date}T00:00:00Z`);
  const xOf = (t: number): number => Math.log(1 + Math.max(0, (t - t0) / 3_600_000));
  const states = pageStates(c);
  const lastState = states[states.length - 1];
  const tLast = lastState.t;
  const xLast = xOf(tLast);
  const xTarget = xOf(Date.parse(c.target));
  const dx = Math.max(0, xTarget - xLast);
  const dDays = c.horizon_minutes / 1440;
  const dxEff = P.tauD * (1 - Math.exp(-dx / P.tauD)); // distance the slope is actually applied over

  // Per-trophy weighted fits (unshrunk), then pooled slope / residual scale, then final medians.
  const tCp = Date.parse(c.at);
  // Fit window: the last windowH hours, extended back until it holds at least minStates states.
  let windowStart = tCp - P.windowH * 3_600_000;
  const inWindow = states.filter((s) => s.t >= windowStart);
  if (inWindow.length < P.minStates && states.length > inWindow.length) {
    windowStart = states[Math.max(0, states.length - P.minStates)].t;
  }
  const raw: Array<Fit | null> = c.trophies.map((_t, i) => {
    const pts: Array<{ x: number; y: number; w: number; t: number }> = [];
    for (const s of states) {
      const r = s.rates[i];
      if (r === null || !(s.players > 0)) continue;
      if (s.t < windowStart) continue; // fit on the recent window only
      const earners = Math.min(s.players, Math.max(0, Math.round((r * s.players) / 100)));
      const rc = (100 * (earners + 0.5)) / (s.players + 1); // continuity-corrected rate
      const reliability = ((earners + 0.5) * (s.players - earners + 0.5)) / (s.players + 1); // ~count backing the logit
      const w = Math.pow(2, -(tLast - s.t) / (P.halfLifeH * 3_600_000))
        * (reliability / (reliability + P.relScale)) * Math.min(s.durH, P.durCapH);
      pts.push({ x: xOf(s.t), y: logit(rc), w, t: s.t });
    }
    if (pts.length === 0) return null;
    const lastPt = pts[pts.length - 1];
    if (pts.length < 3 || pts[pts.length - 1].x - pts[0].x < 0.05) {
      return { anchor: lastPt.y, slope: 0, slopeSe: Infinity, residSd: 0.35, n: pts.length, lastY: lastPt.y };
    }
    let sw = 0, sx = 0, sy = 0;
    for (const p of pts) { sw += p.w; sx += p.w * p.x; sy += p.w * p.y; }
    const mx = sx / sw, my = sy / sw;
    let sxx = 0, sxy = 0;
    for (const p of pts) { sxx += p.w * (p.x - mx) ** 2; sxy += p.w * (p.x - mx) * (p.y - my); }
    const slope = sxx > 1e-9 ? sxy / sxx : 0;
    let rss = 0;
    for (const p of pts) rss += p.w * (p.y - (my + slope * (p.x - mx))) ** 2;
    const dof = Math.max(1, pts.length - 2);
    const residSd = Math.sqrt(rss / Math.max(1e-9, (sw * dof) / pts.length));
    const slopeSe = sxx > 1e-9 ? residSd / Math.sqrt(sxx) : Infinity;
    const fitAtLast = my + slope * (xLast - mx);
    // Recent-states mean for the anchor blend.
    let rw = 0, ry = 0;
    for (const p of pts) {
      if (tLast - p.t <= P.anchorRecentH * 3_600_000) { rw += p.w; ry += p.w * p.y; }
    }
    const recentMean = rw > 0 ? ry / rw : lastPt.y;
    const anchor = P.anchorFitW * fitAtLast + (1 - P.anchorFitW) * recentMean;
    return { anchor, slope, slopeSe, residSd, n: pts.length, lastY: lastPt.y };
  });

  // Pooled slope (precision-weighted mean of finite-SE slopes) and pooled residual variance.
  let poolNum = 0, poolDen = 0, resNum = 0, resDen = 0;
  for (const f of raw) {
    if (f === null) continue;
    if (Number.isFinite(f.slopeSe) && f.slopeSe > 0) { const w = 1 / (f.slopeSe ** 2); poolNum += w * f.slope; poolDen += w; }
    resNum += f.residSd ** 2 * Math.max(0, f.n - 2); resDen += Math.max(0, f.n - 2);
  }
  const pooledSlope = poolDen > 0 ? poolNum / poolDen : 0;
  const pooledResid = resDen > 0 ? Math.sqrt(resNum / resDen) : 0.3;

  // A history that never changed while the game launched underneath it: the page is pre-launch data.
  const launchFrozen = states.length === 1 && t0 > states[0].t && t0 <= Date.parse(c.at);

  const medians: number[] = raw.map((f, i) => {
    if (f === null) return logit(0.5);
    if (launchFrozen) {
      // Earners lag a multiplying tracked base at the first refresh; the platinum and grind trophies
      // lag most, the near-universal first trophy least. Tier is a rough proxy for how fast earners grow.
      const tierLag: Record<string, number> = { platinum: 1.0, gold: 0.97, silver: 0.95, bronze: 0.93 };
      const lag = tierLag[c.trophies[i].tier] ?? 0.85;
      const lastRate = lastState.rates[i];
      if (lastRate !== null && lastRate >= 99.9) return logit(99.0); // was universal among pre-launch trackers
      return f.lastY - P.launchLogGrowth * lag;
    }
    const shrink = Number.isFinite(f.slopeSe)
      ? (f.slope / f.slopeSe ** 2 + pooledSlope / P.slopePoolTau ** 2) / (1 / f.slopeSe ** 2 + 1 / P.slopePoolTau ** 2)
      : pooledSlope;
    return f.anchor + shrink * dxEff;
  });

  // The platinum's earners are a subset of every other trophy's: cap its median at the lowest other median.
  const platIdx = c.trophies.findIndex((t) => t.tier === 'platinum');
  if (platIdx >= 0) {
    let minOther = Infinity;
    medians.forEach((m, i) => { if (i !== platIdx) minOther = Math.min(minOther, m); });
    if (Number.isFinite(minOther)) medians[platIdx] = Math.min(medians[platIdx], minOther);
  }

  return c.trophies.map((t, i) => {
    const f = raw[i];
    let sigma: number;
    if (launchFrozen) {
      sigma = P.launchSigma;
    } else if (f === null) {
      sigma = 0.9;
    } else {
      const residPooled = Math.sqrt((f.residSd ** 2 * Math.max(0, f.n - 2) + pooledResid ** 2 * P.residPoolN) / (Math.max(0, f.n - 2) + P.residPoolN));
      const slopeVar = Number.isFinite(f.slopeSe) ? (f.slopeSe * dxEff) ** 2 : 0.09;
      sigma = Math.sqrt(Math.max(P.sigmaFloor ** 2, residPooled ** 2 + slopeVar + (P.kappaRW * Math.sqrt(dDays)) ** 2));
    }
    const med = medians[i];
    const q = Z.map((z) => round4(Math.min(100, Math.max(0, invLogit(med + z * sigma)))));
    for (let j = 1; j < q.length; j++) if (q[j] < q[j - 1]) q[j] = q[j - 1];
    return { id: t.id, q };
  });
}

mkdirSync(OUTPUT_DIR, { recursive: true });
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) throw new Error(`${file} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  if (c.history.length === 0) throw new Error(`${file} has no history`);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ trophies: forecastCase(c) })}\n`);
}
