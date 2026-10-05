# Local delivery-leg search

This continues the measured 3/5-region search using only the three retained
shared-role layouts. It does not discover new topology or modify the runtime.

## Corrected premise and exact retained inputs

The three layouts have V1/V4/V5 using the incident, but **none has V5 arriving
before both V1 and V4**. The previous report recorded this additional failure.
All three have V5's incident on its final depot return, after four deliveries.

| Edge | Original seed | V1 arrival (s) | V4 arrival (s) | V5 arrival (s) | V5 incident leg |
|---|---:|---:|---:|---:|---|
| osm:722241447:2:f | 43 | 129.803 | 68.713 | 72.144 | 14 → 0 |
| osm:722241447:0:f | 37 | 58.125 | 61.487 | 122.599 | 13 → 0 |
| osm:722241447:0:f | 45 | 60.718 | 47.759 | 137.599 | 21 → 0 |

These are initial unimpeded arrival estimates using the existing simulation's
distance speed and service dwell, not fabricated DETECTED timestamps.

`data/local_retained_candidates.json` stores each exact 24-customer input, all
initial LNS orders, full road geometry/service legs, incident-bearing leg and
arrival estimates. Reproduction reruns the real LNS and asserts every stored
arrival against the recovered search report within 0.000001 ms, including
matching leg endpoint IDs. The source report SHA-256 is recorded.

V5 orders, including depot 0:

- Seed 43: 0 → 22 → 16 → 11 → 14 → 0.
- Seed 37: 0 → 14 → 20 → 10 → 13 → 0.
- Seed 45: 0 → 14 → 11 → 23 → 21 → 0.

V1/V4 orders are preserved in the same JSON; they are not manually reused as
assignments when testing modified inputs.

## Input-only local perturbations

For each retained layout, vary 2, 4, 6 or 8 nearby customer locations. Selection
uses geographic distance across all customer IDs, never ownership by V5. Keep
the other locations, depot, IDs, demands, capacity, solver seed/options and time
windows unchanged. Sample before/central/after pools with asymmetric densities
and varying radii around the existing topology witnesses. LNS still determines
all vehicle assignments and customer orders.

Before/after sampling combines real directed shortest-path connectivity with
the geographic direction of the incident segment; it is not literal west/east.
The initial connectivity-only partition was found to give identical before/after
pools on an unbranched OSM segment. Its 22 diagnostic layouts are preserved in
`data/local_delivery_axis_pilot_report.json`, separately from the corrected run.
The corrected pools are disjoint; no routing edge or cost is changed by this fix.

Screen in this order:

1. Initial feasibility, six routes and all 24 distinct customers.
2. First occurrence of the incident in V5's actual service legs.
3. Positive `from_stop` and `to_stop`; at least one customer served before entry
   and at least two customers remaining, including the destination of that leg.
4. V1/V4 incident membership, arrival order, and at least 300 m estimated approach
   separation after the detector's injection/telemetry delay.
5. Existing overlap contract and full real Simulation/API validator.

Every rejection records a primary requested reason, original returned orders,
input-node changes and supporting service/timing details. Full validation, when
reached, retains all failure codes. A prefilter pass is never final acceptance.
The real validator alone may authorize writing official fixtures. Geometry
thresholds, x3 congestion and all runtime code remain unchanged.

## Reproduction

```text
python tools/search_local_delivery.py --base-url http://127.0.0.1:8016 --layouts-per-candidate 60
```

Use `--node /path/to/node` if needed. The report is
`data/local_delivery_search_report.json`. Future local seeds can start with
`--start-seed 60 --report data/local_delivery_search_next.json`; do not overwrite
the earlier evidence. `completed` indicates budget completion, while `accepted`
separately states whether the presentation criteria passed. A technical pass
still requires browser visual inspection.

## Measured result

The corrected local search completed 180 layouts: 60 local seeds (0–59) for
each retained original configuration. The only primary rejection counts were:

| Reason | Count |
|---|---:|
| V5_NOT_ASSIGNED_INCIDENT | 88 |
| V5_RETURN_LEG | 92 |

All other requested categories have zero counted rejections because screening
stopped earlier; this is **not** proof those later requirements passed. No layout
passed the V5 service-leg screen. Full Simulation candidates: 0; accepted: none.
The 22 layouts from the discarded connectivity-only region partition are separate
diagnostics, not part of these 180. Three additional spot checks of other vehicles
on local seeds 1/3/9 of parent seed 37 likewise showed return-leg incident use;
these are limited diagnostics, not an exhaustive statement about all vehicles.

Both official fixtures retain their pre-search SHA-256 values, and seed 54 remains
installed. No browser inspection was attempted because there was no automated
pass. Neither the two retained topologies nor the three original inputs were
discarded. This bounded search does not prove that all possible local layouts are
exhausted or that the desired scenario is impossible.

Tests: Python 75 passed, 2 optional reference-data skips (77 total). Node 30 passed,
1 failed (31 total): the existing strict presentation test still rejects seed 54.
Five new local-search unit tests cover service-leg counting, return/outbound/late
rejection, timing screening, first-occurrence handling and visual-failure labels.
`git diff --check` passes. No changes to core LNS, routing, telemetry, Simulation,
frontend, congestion multiplier or visual acceptance thresholds. No commit/push.

SCENARIO NOT READY FOR PRESENTATION
