[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/oy-builds/trophy-rarity-forecast-01/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/oy-builds/trophy-rarity-forecast-01/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

# Trophy Rarity Forecast — GTA VI (make.fun gta6-trophy-rarity-forecast-01)

`main.ts` (Node 22, standard library only) reads every `*.in` case in `$MAKEFUN_INPUT_DIR`
(else `/input`) and writes one `<id>.out` forecast per case to `$MAKEFUN_OUTPUT_DIR` (else
`/output`): for each of the case's 55 trophies, the 5/25/50/75/95% quantiles of its Exophase
earn rate at the case's target. Scoring is mean pinball loss on the logit scale; the entry is
deterministic and runs in ~50 ms per case (cap: 8 s).

## The model

Per trophy, from the case's own history only:

1. **Page states, not reads.** Exophase refreshes the page every few hours; the house's reads
repeat the frozen page in between. Consecutive reads with identical `(players_tracked,
rates)` collapse into one page state, annotated with how long the page showed it.
2. **Counts, not just percents.** A printed rate is a rounded count ratio, so each state is
read back as earners `E = round(rate × players / 100)` and smoothed with a Jeffreys-style
correction, `rate' = 100 × (E + 0.5) / (players + 1)`. A printed 0.00 or 100.00 then has a
finite logit in proportion to the players behind it, instead of the scorer's hard clamp.
3. **Local trajectory fit.** `logit(rate')` is fit against `x = ln(1 + hours since release)`
by weighted least squares over the page states of the **last 20 hours** before the
checkpoint — earlier launch dynamics belong to a different regime. Weights decay with a
48 h half-life, grow with the state's display duration (capped at 6 h), and grow with the
count backing the rate. Slopes are shrunk toward the cross-trophy pooled slope.
4. **Saturating extrapolation.** The median anchors on the fit at the last state and follows
the slope over a damped distance, `slope × 3 × (1 − exp(−Δx / 3))`: trends are followed,
never run away linearly in log-time. The platinum's median is capped at the lowest other
trophy's median (its earners are a subset of every other trophy's).
5. **Calibrated spread.** σ² combines the fit's residual scale (pooled across trophies),
slope uncertainty over the extrapolation distance, a random-walk term
`0.5 × sqrt(horizon days)`, and a floor.
6. **Frozen-page launch adjustment.** If the whole history is one unchanged page spanning
the release (the practice cases' shape), no trajectory exists to fit: the tracked base of
a just-launched game multiplies at the first refresh while earners lag, so medians shift
down in logit by ~1.6 × a tier factor and σ is set to 0.58. A trophy printed at 100%
is forecast at a 99% median instead of staying pinned.

## Validation

The kit contains no practice answers (the server grades; the answering reads are not in the
kit), so the model was tuned and checked two other ways:

- **Simulator.** A week-1 simulator (players join over time, accumulate playtime, earn
trophies at lognormal playtime thresholds with per-trophy caps; the page refreshes every
few hours; reads every 30 min) generated 36 final-shaped cases across three regimes —
standard, dilution-heavy (late base growth, slow play, slow refreshes), and fast
refresh/play. The pinball scorer used was first verified against the worked example in
RULES.txt (0.403404, exact). Mean losses over the 36 simulated finals:

| entry | mean pinball loss | 90% coverage |
|---|---|---|
| house baseline (kit starter) | 1.562 | — |
| house curve baseline (last-24 h fit) | 0.698 | — |
| **this entry** | **0.522** | **0.90** |

This entry beat the curve baseline in 36/36 simulated finals. These are simulated
dynamics, not the real recording; parameters were chosen for robustness across the three
regimes rather than for the best single-regime number.
- **Practice refresh scenario.** The rules state the practice answers' refresh showed 3,868
tracked players (from 638) with every rate but the 100% one lower. Under earner-growth
scenarios consistent with those facts, the house baseline scores 0.79–1.64 (the flat
+25%-growth scenario reproduces the reported ≈1.51, with coverage 0.00 as reported);
this entry scores **0.18–0.38** across the same scenarios.
- **Smoke test** (`node smoke.test.mjs`): runs the entry on synthetic cases plus the kit's
real practice inputs and checks the output contract — shape, one row per trophy, quantile
ordering, size cap, runtime, and byte-identical repeat runs.

## Layout

- `main.ts` — the entry (the model above; parameters in the `P` block at the top).
- `smoke.test.mjs` — format/determinism checks.
- `LICENSE` — MIT. `.makefun/owner.json` — the entrant's wallet claim file.
