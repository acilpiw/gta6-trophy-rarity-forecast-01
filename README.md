# GTA VI trophy rarity forecast

[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/acilpiw/gta6-trophy-rarity-forecast-01/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/acilpiw/gta6-trophy-rarity-forecast-01/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

Entry for make.fun's `gta6-trophy-rarity-forecast-01`: forecast, for every
PlayStation 5 trophy of Grand Theft Auto VI, its earn rate on Exophase at
2026-11-26T00:00:00Z — the percent of tracked players who have earned it —
as five quantiles (5%, 25%, 50%, 75%, 95%) per trophy, scored by mean
pinball loss on the logit scale.

## How it works

`main.ts` (Node 22, standard library only, no network) reads each case in
`/input` and writes `/output/<id>.out`. All fitting uses only the case's
*distinct* snapshots: Exophase refreshes its counts every few hours, so
most recorded reads are copies of the previous refresh, and deduplicating
them stops a stale regime from dominating the fit just because it was
sampled longest.

The median blends three candidates per trophy, on the logit scale:

- **Saturating curve** (weight 0.5 when it fits well): a logistic in
  log-time, `r(x) = A / (1 + exp(-(x - m) / s))` with
  `x = ln(1 + hours since release)`, fitted in rate space by a grid over
  midpoint and scale with the asymptote `A` solved by linear least
  squares and capped per tier (platinum 20%, gold 65%, silver 80%,
  bronze 95%). This is the candidate that knows a trophy runs out of
  headroom before the target.
- **Damped trend** (0.3): weighted least squares of logit(rate) on
  log-time, slope shrunk toward the median slope of the trophy's tier,
  anchored on the latest observed rate, extrapolated with the slope
  scaled by 0.62 and the total move tanh-capped at 1.35 logit — a
  saturating curve's local slope overstates its own long-horizon move.
- **Persistence** (0.2): the latest observed rate, unchanged.

The spread is calibrated, not decorative: it combines a random-walk term
(`0.42 * sqrt(horizon days)`), the trend fit's residual scale shrunk
toward the pooled residual, slope- and model-disagreement terms, and a
floor for the jump risk of an Exophase refresh landing between the
checkpoint and the target.

One regime is special. If a case's history is a single distinct snapshot
— the tracked-player count never moved, as in the practice cases cut
from launch night — the page has never refreshed inside the observed
window. That cohort is a small pre-release group whose rates the first
real refresh dilutes (the house baseline scored ~1.51 on the practice
for exactly this reason), so the median shifts down 0.85 on the logit
scale and the spread floor widens to 0.95.

## Local checks

There is no local grade for this competition (the server grades; the kit
holds no practice answers). What was verified locally:

- Practice cases p00/p01: output schema valid (55 rows, ids 1–55, five
  non-decreasing quantiles in [0, 100], 2,774 bytes), two runs
  byte-identical, ~0.4 s per case against the 8 s cap.
- Dilution scenarios for the practice refresh (new cohort earning at
  7–50% of the old cohort's per-trophy rate): loss 0.20–0.32 vs the
  house persistence baseline's 0.45–1.39 on the same scenarios.
- Two synthetic final-shaped cases (logistic-in-log-time truth from a
  different generator family, 30-minute reads, refreshes every ~5 h,
  checkpoint at the deadline, target at day 7): loss **0.240** and
  **0.239**, against 0.283 / 0.294 for a reimplementation of the house
  trend baseline and 0.286 / 0.365 for the house persistence baseline
  on the same cases.

## Run it

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```
