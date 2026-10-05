# Two distinct proactive detours: acceptance audit

This audit extends the earlier mid-delivery scenario work. The retained seed 54
passes the earlier contract, but it does **not** satisfy the newer requirement
that Vehicle 1 and Vehicle 4 both avoid congestion on visibly different detours.
Do not interpret earlier timing verification as approval of this newer contract.

## Method

The offline generator searches input locations, never returned assignments or
geometry. Six geographic regions each contribute four real OSM nodes; shuffled
input IDs are passed to the existing LNS with seed 42 and 80 iterations. Capacity
40 and demand 10 force four customers per active vehicle. The western depot,
six vehicles, real OSM source and congestion multiplier of 3 are unchanged.

Two input families are evaluated: widely separated regional centers and regions
around real road corridors with economically useful directed alternatives. The
second family discovers 189 corridor anchors by excluding an actual directed
edge in an offline counterfactual graph and comparing its alternative path cost.
No exclusion is applied to the live network or optimization output.

Prefilters reject unsuitable ownership, tiny/near-depot edges, Vehicle 5 outbound
or return legs, insufficient remaining deliveries and unsuitable arrival timing.
Final acceptance uses the existing backend jobs, frontend Simulation, physical
congestion, telemetry, dynamic real LNS, applyReoptimization and completion.

The validator records full old/new edge arrays and customer orders. Thresholds:

- At least 300 m remaining road distance to the incident for Vehicles 1 and 4.
- At least 300 m unique new geometry and 15% changed geometry for each.
- Meaningful exclusive novel geometry for both vehicles.
- At least 150 m of each novel geometry sampled at least 75 m from the other's
  novel geometry. Opposite directed edges on the same road cannot alone pass.

These are automated screening thresholds, not a substitute for browser inspection.
Only a technically accepted candidate may proceed to that inspection. Scores
reward delivery phase, approach separation, avoidance, visible change, distinct
detours, balanced service and completion; they penalize failed criteria and
additional incident users. The generator additionally scores measured detour
economics. A high score never overrides a failed acceptance condition.

## Retained baseline: seed 54

Search outcome: 240 distinct input configurations were evaluated (seeds 0–119
for each of the two families). The regions family had no surviving prefilter
candidate. The corridor family sent five candidates (two from seed 2 and three
from seed 79) through the full real Simulation/API pipeline; all five failed acceptance. No best
accepted seed exists in this bounded search. This is not proof that no suitable
scenario exists in the OSM network. Both existing scenario fixtures were retained.

The highest-scoring rejected candidate was corridor seed 2 with edge
`osm:215938715:4:r` (recorded score 26.862). Both vehicles avoided congestion, but
both failed the visible-change thresholds and their detours were not meaningfully
distinct. Its Vehicle 1 leg is 210.003 s through congestion versus 197.747 s avoiding;
Vehicle 4 is 277.409 s versus 265.154 s. This demonstrates that favorable economics
alone do not guarantee the required presentation geometry.

For seed 79 edge `osm:220972652:2:f`, Vehicle 1's congested service leg costs
529.297 s versus 532.027 s avoiding the edge; Vehicle 4 costs 450.647 s versus
453.502 s avoiding it. The other two tested edges produce still smaller penalties.
Neither vehicle avoids these three candidate hotspots after real reoptimization.

No new browser visual acceptance was attempted because no candidate passed the
automated requirements. The next search needs better input/topology selection
that makes *both* complete service-leg detours economical and distinct, not a
forced route, increased multiplier or weakened test.

Incident: `osm:221308781:1:f`. Detection occurs at 64,189 ms. Vehicle 5 has served
two customers, has two remaining, and is on customer leg 5 → 21.

| Measurement | Vehicle 1 | Vehicle 4 |
|---|---:|---:|
| Road distance to incident at detection | 4,397.695 m | 5,175.844 m |
| Incident in old suffix | Yes | Yes |
| Incident in returned suffix | No | Yes |
| Unique new geometry | 967.576 m | 0 m |
| Changed geometry ratio | 13.478% | 0% |

The returned suffixes share 3,210.001 m, but their different destinations do not
prove distinct detours: Vehicle 4 has no novel geometry at all. Full edge arrays,
orders, snapshots and score components are in `data/presentation_visual_audit.json`.

All 24 baseline deliveries complete exactly once. Completion times in simulation
seconds are: V1 129.489, V2 150.000, V3 103.489, V4 138.739, V5 101.989, V6 126.789.
These are baseline results, not evidence that a redesigned scenario passed.

The separate Vehicle 4 forensic run confirms it is sent, optimized and applied
without teleportation. Its relevant leg costs 634.627 s through congestion versus
641.500 s on the best alternative under the unchanged ×3 policy. Keeping that
geometry is economically consistent; no frontend application failure was found.

## Reproduction

Start the existing server on port 8016, then run:

```text
python tools/design_root_scenario.py --base-url http://127.0.0.1:8016 --design regions --start-seed 0 --end-seed 120 --report data/presentation_search_report.json
python tools/design_root_scenario.py --base-url http://127.0.0.1:8016 --design corridor --start-seed 0 --end-seed 120 --report data/presentation_corridor_search_report.json
```

Use `--node /path/to/node` if Node is not on PATH. No accepted candidate means a
nonzero exit and preserved scenario fixtures. Rejection totals count edges, not
distinct input configurations. The JSON reports distinguish both counts.

## Scope and verification

Only the offline generator, validator, presentation tests and audit artifacts are
changed by this request. Deployment and previous scenario edits already present
in the working tree are preserved. No commit or push was performed.

`lns/core.py` SHA-256 remains
`6fcf578392f8fe8fad195c07abf97c2d8034c1218051ae20dd659d799418ef21`.
Frontend, routing, simulation and telemetry behavior are unchanged.

Python: 68 tests, 66 passed and 2 optional reference-data skips.
Node: 28 tests, 27 passed and one failed: the new current-scenario acceptance
test. The four earlier presentation tests pass. The new test deliberately
exposes the unsatisfied product requirement; it is not weakened or skipped.

SCENARIO NOT READY FOR PRESENTATION
