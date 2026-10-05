# Mid-delivery congestion: measured scenario verification

This report supersedes the previous Vehicle 2 / Vehicle 5 completion-order goal.
Configuration seed 54; LNS seed 42; 80 iterations.
The original LNS core, road routing, Simulation, telemetry, and UI are unchanged.

## Why the old scenario failed the new story
The prior configuration (44) detected at 88.5 s on customer 10 -> depot 0.
Vehicle 5 had served 4 customers, with 0 remaining. Its validator only required
Vehicle 2 to finish later; static road sharing did not prove proactive avoidance.

## Actual measured evidence
- Directed OSM incident edge: `osm:221308781:1:f`.
- Vehicle 5 delivery leg: 5 -> 21 (customer -> customer).
- Physical injection: 62.689 s, after Vehicle 5 enters the edge.
- Telemetry detection: 64.189 s; detector 5, served 2, remaining 2.
- Initial edge users: [1, 4, 5].
- Other active vehicles with unserved customers and an untraversed future incident edge: [1, 4].
- Proactive avoidance: [1]. Vehicle 1 contains edge before, not after; geometry changes.
- Vehicle 4 does not avoid the edge; do not claim two proactive reroutes.
- Fleet served/unserved at detection: 12/12.
- Completion times in milliseconds (50 ms steps, 500 ms solver advance): {'1': 129489, '2': 150000.0000000001, '3': 103489, '4': 138739, '5': 101989, '6': 126789}.
- Completed dynamic LNS solves: 2; failures: [].
- All 24 customers served exactly once; six loads of 40 (4 customers of demand 10).

Lifecycle: INACTIVE -> ACTIVE_UNDETECTED -> DETECTED -> REOPTIMIZING -> ROUTES_UPDATED.
Telemetry keeps its original 500 ms interval and two consecutive abnormal ratios.
The slowdown is 1/3 expected speed; no route or known cost changes before detection.
The existing 700 ms detection display and solver safety horizon remain unchanged.
Validator checks exact position and served-set preservation at apply, committed
prefixes, stable ownership, capacity, feasible LNS outputs, and final coverage.

`data/scenario_validation.json` is generated evidence, including actual initial
routes, edge sequences, injection/detection snapshots, and per-vehicle future paths.
`data/presentation_scenario.json` contains inputs/event configuration, not solutions.

## Reproduce
Run the backend on port 8016 and set `LNS_TEST_URL=http://127.0.0.1:8016`.

```text
python tools/design_root_scenario.py --start-seed 54 --end-seed 55 --min-proactive 1 --base-url http://127.0.0.1:8016 --node /path/to/node
node tools/validate_presentation.cjs data/presentation_scenario.json
node --test tests/test_presentation.cjs
node --test tests/*.cjs
python -m unittest discover -s tests -q
git diff --check
```

Generator defaults to requiring two proactive reroutes. Search of seeds 42–108
(with early physical injection) and 109–159 (with injection after edge entry)
did not find that preferred result. Seed 54 satisfies every mandatory condition;
`--min-proactive 1` explicitly selects that permitted minimum. No solver output was
edited and no speeds, arbitrary waits, assignments or telemetry were fabricated.

## Browser
A complete live browser run served all customers and returned every vehicle.
UI timeline: detection 65.7 s, reoptimization 66.4 s, apply 67.9 s; browser/network
latency differs from deterministic validator stepping. Vehicle 5 was observed
serving customers before the hotspot and continuing deliveries after the update.
Summary reports one rerouted vehicle and 1.4 seconds modeled travel savings.
No console errors. Transient physical slowdown is additionally verified by the
real telemetry evidence and unchanged simulation, rather than inferred from UI text.

## Final regression results (2026-09-27)
- Python: 68 discovered, 66 passed, 2 optional original-input provenance tests skipped.
- Node full suite: 27 passed, 0 failed.
- Presentation-specific suite: 4 passed, 0 failed.
- Independent validator output matches every saved evidence field exactly.
- `git diff --check`: PASS.
- `lns/core.py` SHA256: `6fcf578392f8fe8fad195c07abf97c2d8034c1218051ae20dd659d799418ef21` (unchanged).
- Existing uncommitted Render configuration changes are separate from this scenario task.
