# Final product delivery verification — 2026-10-04

**PRODUCT NOT READY FOR PRESENTATION.** The three-vehicle technical flow is now proven on a separate candidate, but the unchanged visual acceptance contract is not met. No candidate was installed, committed or pushed.

## Bounded continuation

Resumed the existing `local-proven-topology/37` input, not topology discovery. Tested 32 local variants, modifying only customer inputs previously belonging to its economically failing vehicle (14, 17, 18, 20). Re-ran real initial LNS for every variant; ownership and ordering were not prescribed. Protected other input coordinates. The tool resumes by replaying its seeded RNG and skips already measured solves.

- Detector mid-delivery: 22/32.
- Mid-delivery plus three sufficiently later corridor users: 5/32.
- All three pass exact economics and estimated telemetry duration: 1/32.
- Full-Simulation candidates: 1; executed three times, checking all three pairwise detour combinations with the existing strict validator.
- Complete visual acceptance: 0.

Reports: `data/three_affected_local_continuation.json`, `data/three_affected_local_validation_16.json`. Earlier 125-entry and 29-entry reports remain preserved. Their `stage >= N` counts are ranking counters, not a sequential acceptance funnel.

## Deepest candidate

`local-37/16`, real LNS seed 42, incident `osm:721954310:4:f`.
Natural roles: detector **Vehicle 2**, affected **Vehicles 4, 5, 6**. These are actual solver-assigned roles; no renumbering. It does not satisfy the preferred V5 detector identity.

The two changed customer inputs versus parent 37 are customer 20: OSM `6772321012` → `2026784563`; customer 18: `11959569597` → `2044487229`. Coordinates are the corresponding real network nodes, changed as scenario inputs, not display offsets. Official fixture coordinates remain unchanged.

| Vehicle / actual initial service leg | Original path at ×3 (s) | Shortest path at ×3 (s) | Best avoiding (s) |
|---|---:|---:|---:|
| 4 / 3→depot | 437.567480 | 409.222603 | 409.222603 |
| 5 / 23→depot | 440.972673 | 412.627796 | 412.627796 |
| 6 / 18→13 | 243.414678 | 219.485136 | 219.485136 |

All unrestricted ×3 shortest paths avoid the directed incident edge. These are service-leg comparisons, not invented whole-fleet savings.

Real telemetry detection: **31,069 ms**, detector served 2 customers, has 2 remaining. Vehicles 4/5/6 are respectively 2,947.44 / 1,610.18 / 5,019.78 m from incident at detection, with deliveries remaining.

Real backend returned updates for all three; their new suffixes contain no incident. Customer orders stayed `[21,3]`, `[23]`, `[18,13]` respectively, while road geometry changed. Position, served customers, ownership and committed edges were preserved. All 24 customers were served once; all six vehicles returned to depot by 150 s. Three runs reproduced identical routes, detection, incident membership and completion times.

| Vehicle | New geometry absent from old suffix (m) | Changed ratio | Result |
|---|---:|---:|---|
| 4 | 1,911.42 | 34.762% | Individual visual thresholds pass |
| 5 | 1,911.42 | 46.681% | Individual visual thresholds pass |
| 6 | 611.53 | 8.699% | Fails required 15% |

Vehicles 4 and 5 have identical novel detour corridors: each has **0 m** spatially separated novel geometry against the other; required ≥250 m at ≥75 m separation. Pairs 4/6 and 5/6 pass distinctness. Exact failures: `detours_not_distinct`, `vehicle_6_weak_visible_change`.

## Blocker and smallest valid next change

The blocker is **scenario topology / visual geometry**, not missing cost propagation, fake LNS, frontend application, telemetry or Simulation. Economics and three genuine avoidances now pass. This is not proof no valid layout exists elsewhere.

Keep this candidate as the measured baseline. A finishing input change must move one of the two shared-return service-leg endpoints (customer 3 or 23) into a *different economically viable directed detour basin*, while preserving the detector inputs. It must also reduce the unchanged remaining suffix for Vehicle 6 sufficiently that its real detour reaches 15%. Merely changing the congestion factor, coloring the shared corridor differently, or relabeling vehicle IDs cannot satisfy the existing contract. Such topology-constrained input work is required before installation; no runtime correction is supported by the evidence.

## Regression / deployment

- Python: 92 tests, 90 passed, 2 skipped, no failures.
- Node: 37 tests, 36 passed, 1 failed: the pre-existing strict presentation test of the **official seed-54 fixture**. Vehicle 1 changed ratio 13.48% <15%; Vehicle 4 does not avoid. This failing test was not weakened.
- Build: PASS; actual OSM SHA matches fixture, Python parses, assets present, `dist/` generated.
- `git diff --check`: PASS (Git printed line-ending notices only).
- Real server: `0.0.0.0:8016`; `/health`, `/`, `/style.css`, `/app.js`, `/config.js`: HTTP 200.
- Render commands unchanged: `pip install -r requirements.txt && python tools/build.py`; `python server.py`. Frontend uses configured API base or same-origin; no production localhost API hardcode.
- Separate candidate preview uses existing `tools/preview_candidate.py` on loopback port 8017; it substitutes only the candidate fixture response, not APIs/solver/simulation.
- Browser candidate run completed: UI confirmed all customers served, all six at depot, three routes changed, estimated remaining-work savings 80.6 seconds. Captured browser error/warning logs were empty. This is a candidate preview, not acceptance or installation. The short ghost window was not re-captured this run; no claim of full visual acceptance is made.
- Existing dashboard limitation observed: the top remaining-time KPI retains the reoptimization snapshot value (67.9 minutes) after fleet completion; it is not a live countdown. No metric/runtime behavior was changed in this task.

## Files added in this continuation

- `tools/search_three_affected_local.py`
- `tools/validate_three_affected.cjs`
- `data/three_affected_local_continuation.json`
- `data/three_affected_local_candidate_16.json`
- `data/three_affected_local_validation_16.json`
- `data/final_delivery_python_tests.log`, `data/final_delivery_node_tests.log` (local test output)
- This report.

Existing frontend presentation work was preserved. No runtime source changed in this continuation. Protected SHA256: `lns/core.py` = `6fcf578392f8fe8fad195c07abf97c2d8034c1218051ae20dd659d799418ef21`; Simulation = `070017c93a7c8b5d74796afd24be09aff3f6828ecbeaab551e373ac42bde1270`; official fixture = `6bda3937dd4b75203870991f34946c4dd178f76c3ff1fe5649fc753153e4a420`. Congestion ×3 and capacity/demand remain unchanged. No route was hardcoded; ghost/new-route visuals continue to use real route data.
