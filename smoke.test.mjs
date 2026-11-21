// Smoke test for the trophy rarity forecast entry.
// Runs main.ts on synthetic cases (a frozen pre-launch page like the practice cases, and a
// multi-refresh trajectory case) and, when the kit is present beside this repo, on the kit's real
// practice inputs p00/p01. Validates the output contract from RULES.txt: one <id>.out per <id>.in,
// exactly {"trophies": [...]}, one row per trophy with exactly {id, q}, five finite quantiles in
// 0..100, non-decreasing, file <= 65,536 bytes, each run under the 8-second cap, and two runs
// byte-identical (the grader requires determinism).
// Run: node smoke.test.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN = join(HERE, 'main.ts');
const WORK = join(HERE, '.smoke-work');
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures++; };

function trophyMeta() {
  // Prefer the kit's real trophy list; fall back to a minimal synthetic one.
  const kitP00 = join(HERE, '..', 'kits', 'gta6-trophy-rarity-forecast-01', 'gta6-trophy-rarity-forecast-01-kit', 'input', 'p00.in');
  if (existsSync(kitP00)) return JSON.parse(readFileSync(kitP00, 'utf8')).trophies;
  return [
    { id: 1, name: 'Plat', description: '', tier: 'platinum', points: 300, secret: false },
    { id: 2, name: 'First', description: '', tier: 'bronze', points: 15, secret: false },
    { id: 3, name: 'Grind', description: '', tier: 'silver', points: 30, secret: false },
  ];
}
const META = trophyMeta();
const GAME = { name: 'Grand Theft Auto VI', platform: 'PS5', release_date: '2026-11-19', source: 'https://www.exophase.com/game/grand-theft-auto-vi-psn/trophies/' };
const iso = (t) => new Date(Date.parse('2026-11-19T00:00:00Z') + t * 3.6e6).toISOString();

function frozenCase() {
  const rates = META.map((_, i) => (i === 1 ? 100 : 0.63 + (i % 5) * 0.15));
  const history = [];
  for (let t = -0.17; t <= 3; t += 0.5) history.push({ slot: iso(t), at: iso(t), players_tracked: 638, trophies_earned: 943, rates });
  return { schema: 'makefun/gta6-trophies-case/v1', id: 'syn-frozen', at: iso(3), horizon_minutes: 90, target: iso(4.5), levels: [0.05, 0.25, 0.5, 0.75, 0.95], game: GAME, trophies: META, history, notes: 'synthetic' };
}
function trajectoryCase() {
  const history = [];
  let players = 638;
  for (let t = -0.17; t <= 59.5; t += 0.5) {
    if (t > 0 && Math.round(t * 2) % 8 === 0) players = Math.round(players * 1.35 + 900);
    const rates = META.map((_, i) => {
      const base = i === 1 ? 99.5 : Math.min(60, 0.4 * Math.pow(1.045, Math.max(0, t)) / (1 + (i % 7) * 0.3));
      return Math.round(base * 100) / 100;
    });
    history.push({ slot: iso(t), at: iso(t), players_tracked: players, trophies_earned: 5000, rates });
  }
  return { schema: 'makefun/gta6-trophies-case/v1', id: 'syn-traj', at: '2026-11-21T11:30:00Z', horizon_minutes: 6510, target: '2026-11-26T00:00:00Z', levels: [0.05, 0.25, 0.5, 0.75, 0.95], game: GAME, trophies: META, history, notes: 'synthetic' };
}

function runOnce(inputDir, outputDir) {
  const t0 = Date.now();
  execFileSync('node', [MAIN], { env: { ...process.env, MAKEFUN_INPUT_DIR: inputDir, MAKEFUN_OUTPUT_DIR: outputDir }, timeout: 60000 });
  return Date.now() - t0;
}

function validate(caseObj, outputDir, label) {
  const file = join(outputDir, `${caseObj.id}.out`);
  check(existsSync(file), `${label}: ${caseObj.id}.out written`);
  if (!existsSync(file)) return;
  const bytes = statSync(file).size;
  check(bytes <= 65536, `${label}: output ${bytes} bytes <= 65536`);
  const out = JSON.parse(readFileSync(file, 'utf8'));
  check(Object.keys(out).length === 1 && Array.isArray(out.trophies), `${label}: exactly one key "trophies"`);
  check(out.trophies.length === caseObj.trophies.length, `${label}: one row per trophy (${out.trophies.length}/${caseObj.trophies.length})`);
  const ids = new Set(out.trophies.map((r) => r.id));
  check(caseObj.trophies.every((t) => ids.has(t.id)), `${label}: every trophy id present once`);
  let rowsOk = true;
  for (const r of out.trophies) {
    if (Object.keys(r).sort().join(',') !== 'id,q' || !Array.isArray(r.q) || r.q.length !== 5) { rowsOk = false; break; }
    for (let j = 0; j < 5; j++) {
      if (!Number.isFinite(r.q[j]) || r.q[j] < 0 || r.q[j] > 100 || (j > 0 && r.q[j] < r.q[j - 1])) { rowsOk = false; break; }
    }
  }
  check(rowsOk, `${label}: every row exactly {id, q[5]}, finite, 0..100, non-decreasing`);
}

rmSync(WORK, { recursive: true, force: true });
const inDir = join(WORK, 'input'), outDir = join(WORK, 'output'), outDir2 = join(WORK, 'output2');
mkdirSync(inDir, { recursive: true });
const cases = [frozenCase(), trajectoryCase()];
for (const c of cases) writeFileSync(join(inDir, `${c.id}.in`), JSON.stringify(c));
// Add the kit's real practice inputs when available.
const kitInput = join(HERE, '..', 'kits', 'gta6-trophy-rarity-forecast-01', 'gta6-trophy-rarity-forecast-01-kit', 'input');
if (existsSync(kitInput)) {
  for (const f of readdirSync(kitInput)) if (f.endsWith('.in')) {
    writeFileSync(join(inDir, f), readFileSync(join(kitInput, f)));
    cases.push(JSON.parse(readFileSync(join(kitInput, f), 'utf8')));
  }
}
const ms = runOnce(inDir, outDir);
check(ms < 8000 * cases.length, `runtime ${ms} ms for ${cases.length} cases (cap 8 s per case)`);
for (const c of cases) validate(c, outDir, 'run1');
runOnce(inDir, outDir2);
let deterministic = true;
for (const c of cases) {
  if (readFileSync(join(outDir, `${c.id}.out`), 'utf8') !== readFileSync(join(outDir2, `${c.id}.out`), 'utf8')) deterministic = false;
}
check(deterministic, 'two runs byte-identical');
rmSync(WORK, { recursive: true, force: true });
console.log(failures === 0 ? '\nAll smoke tests passed.' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
