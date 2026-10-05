# Economic prefilter for conditional local search

Only search/test/report tooling changes. The original LNS, runtime router,
telemetry, Simulation, multiplier 3 and visual acceptance thresholds are untouched.

## Exact definitions

- `original_path_cost_x3`: sum the costs on the actual initial LNS service leg's
  unchanged edge sequence, with only the incident edge's travel time multiplied
  by 3. This is a fixed-path reprice, not a shortest-path query.
- `shortest_path_x3`: shortest-path cost returned by the existing RoadRouter on a
  copied graph carrying that x3 penalty.
- `best_avoiding_cost`: shortest-path cost on the same copied graph after deleting
  only the directed incident edge. No reverse edge or neighboring road is removed.

For both vehicles 1 and 4, **every actual incident-containing service leg** must
have `best_avoiding_cost < original_path_cost_x3`; the real x3 shortest path must
exclude the incident; and `shortest_path_x3` must match `best_avoiding_cost` using
relative tolerance 1e-9 and absolute tolerance 1e-7 seconds. A missing directed
alternative fails without a fallback. Equality with the original cost does not
pass the strict savings condition. No impossible comparison of avoiding cost
against unrestricted shortest-path cost is used.

The report retains original, x3-shortest and avoiding edge arrays, stop/OSM
endpoints, all three costs, flags and detailed failure reasons. Delta seconds is
`best_avoiding_cost - original_path_cost_x3`; delta percent divides this by
`original_path_cost_x3`. Negative delta means savings.

Failures are labeled `V1_AVOIDANCE_NOT_ECONOMIC` and/or
`V4_AVOIDANCE_NOT_ECONOMIC`, with individual service-leg failure details.

## Pipeline and scope

Existing local perturbation → real initial LNS → unchanged V5/membership/timing
prefilters → economic prefilter → existing full real Simulation/API validator.
The economic screen uses the actual initial route's customer/depot service-leg
endpoints. It does not pretend to have observed future DETECTED anchors; full
Simulation remains responsible for live progress, feasibility, avoidance and
visual acceptance. It cannot authorize fixture replacement on its own.

The same eight retained inputs and frozen V5 customer coordinates are used.
This continuation tries local seeds 24–47, 24 per input, without rediscovering
topology or generating unrelated customer layouts. Earlier reports are preserved.

```text
python tools/search_conditional_local.py --start-seed 24 --variants-per-input 24 --base-url http://127.0.0.1:8016 --report data/conditional_economic_search_report.json
```

Pass `--node /path/to/node` when needed. The default report filename is now the
economic report, so running the tool does not overwrite the previous conditional
search evidence by default. For later runs use a fresh `--report` path.

## Verification

Six focused tests cover profitable avoidance where shortest and avoiding costs
are equal, expensive/tied avoidance, no directed alternative, exact original-path
repricing, both-vehicle gating, and rejection when the unrestricted router still
prefers an incident-bearing path despite savings relative to a nonoptimal input
path. Synthetic graphs are test fixtures only; search uses the unchanged real OSM.

The four previously audited full-Simulation inputs were reproduced with real
initial LNS and screened using this implementation. All four correctly fail both
vehicles' economic checks. Their three costs and exact path evidence are retained
in `data/economic_prefilter_regression_report.json`. Those four regression runs are
separate from the new search counts.

## Completed continuation

Local seeds 24–47 completed for each of the eight retained parents: 192 inputs.
37 preserve V5's delivery condition. 22 have both V1 and V4 using the incident
(regardless of V5); only two simultaneously preserve V5 and pass membership and
timing. Both fail economics for both vehicles, so zero go to full Simulation.

| Gate | Count |
|---|---:|
| Tested new local inputs | 192 |
| V5 condition passed | 37 |
| V1 and V4 incident membership | 22 |
| V5 + both peers + timing passed | 2 |
| Economics V1 passed (among those two) | 0 |
| Economics V4 passed (among those two) | 0 |
| Economics both passed | 0 |
| Sent to full Simulation | 0 |

The two economically screened inputs are parent 3-5 seed 3 / local seed 26 and
parent 5-3 seed 9 / local seed 36, both on `osm:722241447:0:f`.

| Parent / local | Vehicle | Leg | Original path x3 (s) | Shortest x3 (s) | Best avoiding (s) | Delta (s) | Delta % |
|---|---:|---|---:|---:|---:|---:|---:|
| 3-5 seed 3 / 26 | 1 | 16 → 14 | 410.047000 | 410.047000 | 640.694347 | +230.647346 | +56.2490% |
| 3-5 seed 3 / 26 | 4 | 23 → 11 | 671.550032 | 671.550032 | 975.724407 | +304.174376 | +45.2944% |
| 5-3 seed 9 / 36 | 1 | 13 → 0 | 630.589789 | 630.589789 | 930.318034 | +299.728245 | +47.5314% |
| 5-3 seed 9 / 36 | 4 | 14 → 0 | 336.179751 | 336.179751 | 666.294133 | +330.114382 | +98.1958% |

No candidate is accepted. Local seed 36 ranks first under the retained ranking
(deeper screening stage, passed vehicle-economic checks, existing role checks,
failure count, validation score, then smaller perturbation distance). This does
not claim it has the smallest economic deficit; both candidates fail both checks.
The top ten and every exact failure detail are preserved in
`data/conditional_economic_search_report.json`.

Fixture hashes match before/after. Core SHA-256 remains
`6fcf578392f8fe8fad195c07abf97c2d8034c1218051ae20dd659d799418ef21`.
No browser visual acceptance was attempted because nothing reached full acceptance.

Tests: Python 87 passed, 2 optional skips (89 total); Node 30 passed, 1 failed
(31 total). The existing strict presentation test still rejects installed seed 54.
The local server was restarted before Node tests after an initial connection-refused
attempt; health then returned 200. `git diff --check` passes. No commit/push.
