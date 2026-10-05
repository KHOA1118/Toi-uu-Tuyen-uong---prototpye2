# Conditional local search around eight V5-valid inputs

Scope: search/test/report tooling only. No topology rediscovery, broad customer
generation, runtime changes, policy changes or relaxed acceptance thresholds.

## Retention and perturbation

The eight inputs come directly from `data/capacity_corridor_search_report.json`:
`v5_delivery_counts_valid` and `V1_NOT_AFFECTED`. Each exact input is reproduced
through the real initial LNS, with an assertion that all six returned orders
match the recorded orders. The OSM and source-report SHA-256 are recorded.

All four customer records originally assigned to Vehicle 5 are frozen, including
IDs, OSM nodes, coordinates, demand, time windows and service time. This does not
freeze ownership or ordering in subsequent LNS solves. When Vehicle 4 already
uses the incident, its four original customer records are frozen as well.
Five retained inputs have V4 incident usage; three do not. Reports distinguish
losing that usage from still not obtaining it.

Deterministic variants move one to three customers from the original V1 set, or
two of those customers plus up to two background customers. Actual new road nodes
are sampled within 150, 300, 500 or 750 m of each original customer. Nodes whose
directed return path naturally uses the incident are preferred in two out of
three variants. A reversed in-memory graph computes this sampling hint only;
the existing router and LNS receive the unchanged original directed network.
Original nodes are reserved to prevent a later unchanged customer colliding with
an earlier perturbation. No assignments, initial routes or customer-order
constraints are injected into LNS.

Every variant runs the real initial LNS. Reports separately record whether V5's
delivery condition survives, V1 and V4 use the incident, and the existing timing,
approach-distance and overlap checks pass. Only a complete prefilter pass is sent
to the existing real Simulation/API validator. The official fixtures may only be
written after that validator accepts the entire existing contract.

## Evidence and counts

`data/conditional_local_search_report.json` contains the exact eight base inputs,
each variant input and changed nodes, frozen IDs, all six real initial orders,
incident-bearing service legs, checks, precise rejection reasons and the top ten
closest rejected variants. Ranking prefers full Simulation candidates, then
preserved V5, more incident-using peers, fewer failed checks, validation score,
and smaller coordinate perturbations. Ranking never grants acceptance.

Counters explicitly distinguish unconditional V1/V4 incidence from V1 restoration
while V5 remains valid and all three roles occurring together. Failure categories
overlap: one input may lose V5 and also miss V1/V4. A zero count for later-stage
failures does not mean later stages passed if no candidate reached them.

A development pilot is preserved separately in
`data/conditional_local_pilot_report.json`; it was stopped to strengthen unique
node reservation before the completed search. It is not pooled with the final
variant counts or claimed as a completed run.

## Reproduction

Start the existing server on port 8016, then:

```text
python tools/search_conditional_local.py --base-url http://127.0.0.1:8016 --variants-per-input 24
```

Use `--node /path/to/node` if needed. Future local seeds can begin at 24 with
`--start-seed 24 --report data/conditional_local_next.json`; preserve earlier
reports. No further search is scheduled automatically.

Tests cover frozen customer records, deterministic local input generation,
unchanged non-coordinate VRP fields, no manual assignments, delivery-state
validation, failure categories and rejection ranking.

## Completed search result

192 distinct changed inputs were tested, 24 local seeds (0–23) around each parent.
The separate development pilot contains 21 attempts and is not included below.

| Parent edge suffix / regional family / seed | Tested | V5 valid | V1 present | V5 + V1 | V4 present | Full Simulation |
|---|---:|---:|---:|---:|---:|---:|
| :2:f / 2-6 / 29 | 24 | 4 | 5 | 1 | 4 | 0 |
| :0:f / 2-6 / 5 | 24 | 9 | 5 | 0 | 20 | 0 |
| :0:f / 2-6 / 14 | 24 | 6 | 7 | 3 | 9 | 0 |
| :0:f / 2-6 / 20 | 24 | 2 | 9 | 0 | 6 | 0 |
| :0:f / 3-5 / 0 | 24 | 7 | 7 | 1 | 13 | 0 |
| :0:f / 3-5 / 3 | 24 | 10 | 9 | 2 | 17 | 1 |
| :0:f / 5-3 / 9 | 24 | 5 | 13 | 3 | 18 | 3 |
| :0:f / 1-7 / 4 | 24 | 0 | 6 | 0 | 6 | 0 |
| Total | 192 | 43 | 61 | 10 | 93 | 4 |

Both suffixes belong to OSM way 722241447. V1/V4 columns are unconditional
incident usage; V5 + V1 is the conditional restoration count. Among the 120
variants whose parents already had V4, 74 retain that usage and 46 lose it.
Among the other 72 variants, 19 restore V4 and 53 still lack it.

Failure counters overlap: V5 condition lost 149; V1 still missing 131; V4 lost
46; V4 still missing from an already-missing parent 53. All four variants with
all three roles also pass the timing prefilter. Wrong-arrival/too-close rejection
count is zero at that stage; timing is not claimed to pass for earlier rejections.

Four full real Simulation/API runs complete, with no runtime/reoptimization
errors, no teleportation and all customers served. All four fail acceptance:
both V1 and V4 receive updates that still contain the incident, with zero novel
geometry. Avoidance failures: 4; distinct-detour failures: 4 (the same runs).
There is no accepted candidate and no browser acceptance was attempted.

The highest-ranked rejected input is parent `:0:f / 3-5 / seed 3`, local seed 12.
Only customer 4 moves, 662.159 m, to OSM node 8359451297. Detection is at
22,775 ms on V5 leg 18 → 7, with one customer served and three remaining.
V1/V4 are 9,753.371 m / 9,766.057 m before the incident. Both receive dynamic
updates, but both returned suffixes retain it and both have 0% geometry change.
The raw validator label `mid_delivery_contract` is an aggregate predicate that
also requires avoidance; it must not be misread as V5 failing its measured
delivery-state conditions here. The complete six failure codes are retained.

Official fixture hashes are unchanged; seed 54 remains installed. Core LNS,
routing, telemetry, Simulation, x3 and acceptance thresholds are unchanged.
The remaining failure for the four advanced candidates is avoidance/geometry,
not absent vehicle membership or frontend failure. Detour economics have not
been separately diagnosed in this search, so no underlying cost-model bug or
specific economic cause is asserted.

Verification: Python 81 passed and 2 optional skips (83 total); Node 30 passed
and 1 failed (31 total), the existing seed-54 strict presentation acceptance
test. The initial Node attempt encountered an absent local server; after starting
the unchanged server at port 8016, health returned 200 and the above Node result
was obtained. Frozen customer records and uniqueness were independently checked
for all 192 final inputs. No commit/push was performed.

SCENARIO NOT READY FOR PRESENTATION
