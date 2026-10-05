# Topology-first presentation scenario search

This supersedes customer-first candidate generation. It does not change the
runtime policy, solver, router, telemetry, simulation or UI. Earlier fixtures
remain installed unless a candidate passes the real end-to-end validator.

## Search contract

1. Select directed OSM edges at least 600 m from the retained depot. Examine the
   previously promising `osm:215938715:4:r` first. Spatially distribute the other
   candidates so adjacent fragments do not consume the search budget.
2. Before creating any customers, sample up to 24 road-node anchors around each
   hotspot (eight directions at approximately 450, 1,000 and 1,900 m).
3. Call the existing `RoadRouter.tree` with normal costs and with just that edge's
   cost multiplied by 3 in a separate in-memory network. Reconstruct directed
   paths from its predecessor edges. Require the normal shortest path to use
   the hotspot and the new shortest path to avoid it, with strict inequalities
   `normal < alternative < original path with congestion`.
4. Strip unchanged geometry from the alternative paths. Require two alternatives
   with at least 300 m novel geometry each. Sample each novel segment at 25%, 50%
   and 75%, weighted by segment length. Compare samples to the other alternative's
   complete segments, including opposite-direction road geometry. Require at least
   250 m on **each** alternative at least 75 m away from the other.
5. Rank qualifying topology by the smaller of those two separated lengths. Around
   each selected topology, generate repeated local customer layouts: four regions
   near the measured OD endpoints and two geographic background regions, with
   varied centers, radii, actual road nodes and shuffled input IDs. The pilot used
   four customers per region. The offset design alternates regional populations
   `[3,5,3,5,4,4]` and `[5,3,5,3,4,4]` to encourage real inter-region delivery.
   LNS alone chooses ownership and stop order; all six vehicles still carry
   exactly four customers under the unchanged capacity/demand constraints.
6. Run the existing initial real LNS. Screen ownership, mid-delivery detection,
   first arrival and approach distance before spending a full Simulation run.
7. The real Simulation/API validator is the only final technical acceptance
   authority. It retains all earlier criteria and tightens separated novel length
   from 150 to 250 m. It also records directional length-weighted median and maximum
   separation, individual samples, and lengths at both 75 m and 100 m thresholds.
8. Rank rejected layouts and record the top ten, their evaluation stage and exact
   failure codes. A prefilter rejection has not been tested for later dynamic
   criteria; it must not be interpreted as a full Simulation failure.

Topology evidence is a bounded sample of OD pairs, not an exhaustive proof that a
road area has or lacks alternatives. Likewise, passing topology screening does not
prove that the required vehicle roles will emerge from a 24-customer LNS problem.

## Reproduction

With the existing backend running on port 8016:

```text
python tools/search_topology_scenario.py --base-url http://127.0.0.1:8016 --topology-limit 80 --max-topologies 6 --layouts-per-topology 60
```

Pass `--node /path/to/node` if Node is not on PATH. The progress report is
`data/topology_search_report.json`. It includes topology witnesses with actual
edge arrays and costs, per-topology layout counts, full Simulation evidence when
run, top ten rejected layouts, and before/after fixture hashes. `completed: true`
means the bounded search finished, not that the scenario passed. Read
`best_accepted` separately.

The current offset run uses 30 layouts per topology and reuses measured discovery
from `data/topology_balanced_search_report.json` via `--topology-cache`. Source
hash, multiplier and discovery budget are checked before reuse. The balanced
pilot was deliberately stopped after 90 layouts when ownership screening kept
rejecting the inputs. Its report is retained separately; it is not a completed
360-layout run and those missing layouts are not counted.

The existing generator remains available to reproduce earlier searches. No
returned route is manually edited and no new road or customer assignment is
fabricated. The multiplier remains 3; capacity remains 40, demand 10, and the
fleet remains six vehicles with 24 customers.

Browser inspection is required only after a candidate passes all automated
acceptance criteria. An automated pass alone cannot mark the presentation ready.

## Working-tree recovery and continuation (2026-09-27)

The recovered offset run had **completed**, rather than stopped mid-search:
180 layouts, 30 each for six topologies; none reached full Simulation. Discovery
finished at 80 examined / 26 economical / 18 spatially qualifying topologies.
All 180 failed shared incident ownership for vehicles 1, 4 and 5. The 90-layout
balanced pilot is separate and remains preserved. The installed seed is still 54.

Continuation uses the same measured topology and 3/5 generator, not a new search:

```text
python tools/search_topology_scenario.py --topology-cache data/topology_search_report.json --start-seed 30 --layouts-per-topology 30 --edge osm:722241447:2:f --edge osm:722241447:0:f --report data/topology_continuation_report.json
```

Supply `--node` if necessary. This evaluated 60 additional layouts, seeds 30–59
on both edges. 57 failed shared ownership. Three passed ownership but failed
mid-delivery/arrival screening: edge `:2:f` seed 43, edge `:0:f` seeds 37 and 45.
Vehicle 5 encounters the incident on the final return to depot in all three.
They are rejected, not installed. Full Simulation candidates: **0**. Accepted:
**none**. The top-ten rejection ranking now places deeper-stage failures first,
so these useful timing failures are not hidden beneath shallower one-check failures.

Across recovered and continued topology searches: 90 balanced + 180 offset + 60
continued offset = 330 layouts. Previous customer-first experiments are separate.
Both fixture hashes match their before-search values. No browser acceptance was
attempted. The next input-design bottleneck is generating delivery stops beyond
the incident on Vehicle 5's remaining journey; simply extending random seeds has
not solved this. Future continuation on these two edges starts at seed 60.

Verification after recovery: Python **70 passed, 2 optional skips** (72 total);
Node **30 passed, 1 failed** (31 total). The sole failure is the strict current
presentation acceptance test. `git diff --check` passes. The server was restarted
at `0.0.0.0:8016`, `/health` returned 200. LNS core hash remains
`6fcf578392f8fe8fad195c07abf97c2d8034c1218051ae20dd659d799418ef21`.
No core, frontend, routing, simulation or telemetry file was changed. No commit,
push, revert or reset was performed.

Recovery began with 16 modified tracked files (not just the seven files from the
latest step): `.env.example`, `.gitignore`, `DEMO_REFINEMENT.md`,
`PRESENTATION_SCENARIO.md`, `README.md`, `SCENARIO_TIMING_VERIFICATION.md`,
`data/presentation_scenario.json`, `data/scenario_validation.json`,
`deployment_config.py`, `server.py`, `tests/test_deployment.py`,
`tests/test_pipeline.py`, `tests/test_presentation.cjs`, `tools/build.py`,
`tools/design_root_scenario.py`, `tools/validate_presentation.cjs`.

The 11 existing untracked files were `TOPOLOGY_FIRST_SEARCH.md`,
`VISUAL_SCENARIO_SEARCH.md`, `data/presentation_corridor_search_report.json`,
`data/presentation_search_report.json`, `data/presentation_visual_audit.json`,
`data/topology_balanced_search_report.json`, `data/topology_search_report.json`,
`tests/test_detour_geometry.cjs`, `tests/test_topology_search.py`,
`tools/detour_geometry.cjs`, `tools/search_topology_scenario.py`.

This continuation changes only the topology search CLI/ranking, its ranking test,
this report, and adds `data/topology_continuation_report.json`. Existing work is
preserved. Presentation status remains **NOT READY**.
