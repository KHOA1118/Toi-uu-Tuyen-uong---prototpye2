# ROLE-BASED FALLBACK READY

The primary numeric roles (V5 detector, V1/V4 rerouting) did not pass within the
declared budget. A separate, naturally generated fallback passes the same
behavioral, economic, geometry, feasibility and continuity thresholds:
**V6 detects; V2 and V3 reroute.** No vehicle was renamed and no returned route,
customer assignment or customer order was edited. The official fixtures remain
unchanged from the start of this task.

## Search budget and results

- 160 directed edges screened; `osm:722241447:*` excluded as incident candidates
  (those roads remain in the real routing graph).
- 51 edges had x3-economic avoidance; 29 had two measured spatial alternatives;
  the best 12 received customer-layout search.
- 384 initial layouts (32 per hotspot), then 240 local variants (24 per beam
  parent, 10 parents). **624 evaluations, 622 unique input datasets**.
- 238 capacity-pair layouts, 146 two-topology-OD-pair layouts, 240 conditional
  local variants. The report records generation revisions/checkpoints; already
  evaluated inputs were preserved when the remaining seed slots were improved.
- 98 evaluations preserved the V5 mid-delivery condition. Zero had all the exact
  V1/V4/V5 memberships, so zero primary candidates reached timing/economics/full
  Simulation. This is a bounded search result, not proof of global impossibility.
- Primary rejection counts: V5 absent 426; V5 outbound 56; V5 too few remaining
  17; V5 return leg 27; V1 missing 94; V4 missing 4. These are first-gate reasons.
- Existing initial LNS was executed for every evaluated input. Local perturbation
  protects detector coordinates and a passing affected peer when applicable;
  it never fixes ownership. The original LNS decides assignments again.

After primary budget exhaustion, 56 existing inputs with at least three incident
users were replayed with real initial LNS, preserving all vehicle IDs. No new
layouts were generated. Natural-role screening rejected 42 because the first
vehicle was not mid-delivery, 3 for insufficient distant peers, and 5 for actual
service-leg economics. Six passed and ran real frontend Simulation/backend APIs.
Two passed complete numerical/behavioral acceptance. Four failed visible-change
or distinct-detour thresholds. All details are retained in the reports.

## Selected separate fallback

- File: `data/final_role_candidates/candidate-1.json`.
- Input: `osm:721954310:4:f/family-3-1/seed-1002`.
- Regional counts: 5/3/4/4/4/4. LNS options: seed 42, 80 iterations, removal count 5.
- Six vehicles, 24 customers, demand 10, capacity 40, multiplier x3.
- Incident: `osm:721954310:4:f`.
- Natural detector: V6; proactive affected vehicles: V2 and V3.
- Injection: 30.136 s; detection: 31.636 s in the deterministic validator.
- At detection V6 has served [19,20], remaining [8,12], on customer-to-customer
  movement. Two real telemetry samples 500 ms apart measure approximately 1/3
  normal speed. Progress is 58.75%.
- V2 is 713.406 m before the incident; V3 is 2295.604 m before it.
- The real backend completes two LNS solves, with no reoptimization failures.

## Economics (seconds)

| Vehicle / actual service leg | Original fixed path x3 | Real shortest x3 | Incident forbidden | Saving |
|---|---:|---:|---:|---:|
| V2, 17 -> 13 | 109.137565 | 87.335537 | 87.335537 | 21.802028 |
| V3, 23 -> depot | 440.972673 | 412.627796 | 412.627796 | 28.344877 |

Both real shortest paths exclude the incident and match the incident-forbidden
cost at the existing tolerance (relative 1e-9, absolute 1e-7 seconds). Total saving
is 50.146905 seconds. Backend remaining-route costs are respectively
356.412032 -> 334.610004 and 540.427859 -> 512.082982 seconds under the same incident.

V2 remaining customer order stays [17,13]; V3 stays [3,23]. Real LNS runs, but the
improvement is road geometry, not a claimed customer-order change. Both old
suffixes contain the incident; neither new suffix does.

## Visual geometry and completion

| Metric | V2 | V3 |
|---|---:|---:|
| New geometry | 727.796 m | 1911.417 m |
| Geometry change | 26.10% | 39.77% |
| Exclusive novel geometry | 727.796 m | 1911.417 m |
| Novel geometry >=75 m from other detour | 727.796 m | 1911.417 m |
| Median separation | 507.799 m | 634.705 m |
| Maximum separation | 641.709 m | 798.614 m |

Shared novel geometry is zero. Opposite directions on the same road are not
counted as distinct corridors. No visual threshold was reduced.

All 24 customers are served exactly once; each vehicle serves four. Ownership,
served customers, committed segments and physical positions are preserved.
Completion times (seconds): V1 150.000, V2 60.886, V3 79.186, V4 118.636,
V5 71.886, V6 54.436. Lifecycle is exactly:
INACTIVE -> ACTIVE_UNDETECTED -> DETECTED -> REOPTIMIZING -> ROUTES_UPDATED.

The automated replay on the candidate preview server reproduces acceptance,
detection time, initial orders, completion times and separation metrics exactly.

## Browser verification

The unchanged page and APIs were tested at `http://127.0.0.1:8017/` using an
isolated preview handler that substitutes only the fixture GET response. The
official server/fixture and all optimization/physics implementations are intact.

Observed in the browser: real OSM map loaded, six vehicle markers, V6 explicitly
displayed "Di cham do su co" (the UI uses Vietnamese accents) after two deliveries,
incident marking, route update, distinct turquoise V2 and green V3 corridors,
50.1 seconds saved, and completion of all six vehicles at 150.0 seconds with four
deliveries each. No warning/error console entries were observed. Ordinary map
pan/zoom makes the affected northern area easy to inspect; the default fleet view
also includes the two longer background routes. No UI source was changed.

Screenshots in `data/final_role_candidates/` include the confirmed slowdown,
updated routes, distinct detours and completed fleet. Automated position equality
at application is the exact no-teleport check; browser viewing is corroboration,
not a replacement for that assertion.

## Regression and restrictions

- Python: 92 tests, 90 passed, 2 optional skips.
- Node: 32 tests, 31 passed, 1 failed. The failure is the unchanged official
  seed-54 strict presentation acceptance, not the separate fallback.
- Fallback validator default-role equivalence test passes against the complete
  primary validator. Actual-role complete validation and deterministic replay pass.
- `/health` returns 200. `git diff --check` passes (existing line-ending warnings).
- No changes to `lns/core.py`, operators, acceptance, routing runtime, telemetry,
  Simulation, multiplier, frontend UI, or official scenario/validation fixtures.
- No commit, push or deployment.

The exact V5/V1/V4 primary requirement is still unmet. Do not describe this as a
primary scenario success. The smallest usable presentation change is to tell the
story using the natural IDs V6 -> V2/V3, as explicitly permitted by the fallback
policy; it requires no algorithm or route modification. This fallback is **not
automatically installed** over the official fixture.

## Run the separate fallback

```powershell
python tools/preview_candidate.py --fixture data/final_role_candidates/candidate-1.json --port 8017
```

Open `http://127.0.0.1:8017/`, activate **Toi Uu** (the UI button uses Vietnamese
accents), and keep the tab visible. Completion takes approximately 2.5 minutes.
The main fixture remains available on the normal server.

## Files changed in this task

- Updated `tools/search_topology_scenario.py`: optional incident-prefix exclusion,
  with unchanged default behavior.
- Added `tools/search_final_economic.py`, `tools/audit_final_roles.py`,
  `tools/validate_final_fallbacks.py`, `tools/validate_role_fallback.cjs`,
  `tools/preview_candidate.py`.
- Added `tests/test_final_economic_search.py`, `tests/test_role_validator.cjs`.
- Added this report, `data/final_economic_search_report.json`,
  `data/final_natural_roles_audit.json`, `data/final_fallback_validation.json`,
  `data/final_fixture_regression.json`, and separate candidate/validation/screenshots
  under `data/final_role_candidates/`.
- A first fallback validation attempt found the local server stopped; it was
  restarted and every candidate rerun. The infrastructure error record is retained
  separately as `data/final_fallback_connection_errors.json` and is not counted as
  a scenario rejection.

Previous reports and pre-existing working-tree changes are preserved.
