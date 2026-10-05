# Capacity-driven cross-corridor scenario inputs

This search starts from the current working tree and reuses the two measured
hotspots `osm:722241447:2:f` and `osm:722241447:0:f`. It performs no new topology
discovery and does not extend the old local-jitter structure.

## Design

- Priority family: 2/6/4/4/4/4, with both 2→6 and 6→2 regional populations.
- Nearby families: 3/5/4/4/4/4 and 1/7/4/4/4/4, also in both orientations.
- Region A/B centers are sampled on opposite sides of the incident along an
  already measured directed shortest path. Four background regions use the
  retained shared-role geography, with four customers each.
- Critical region radii vary from 80 to 260 m; background radii from 150 to 450 m.
  When the requested radius contains too few road nodes, the nearest-node pool
  is used and its actual radius is recorded, never concealed as a tight cluster.
- Customer OSM nodes are unique. Input IDs are shuffled deterministically as in
  the existing generator. No initial vehicle assignments/routes are supplied.
- Capacity stays 40, demand stays 10, six vehicles and 24 customers. Total demand
  equals fleet capacity, so a feasible six-vehicle solution serves four customers
  per vehicle. Regional imbalance encourages mixing; it does not mathematically
  guarantee which regions will be mixed or which vehicle will serve them.

All ownership, ordering, geometry and costs come from the existing LNS and OSM
router. Every generated layout runs initial real LNS. The service-leg screen is
reused from the previous local search, including first-incident-occurrence checks,
one served/two remaining, V1/V4 membership and arrival separation. Full validation
is the unchanged real Simulation/API validator with strict spatial thresholds.

## Recorded evidence

`data/capacity_corridor_search_report.json` records every scenario input, regional
membership, real initial orders, incident service legs for all six vehicles,
rejection reason and, when reached, full Simulation evidence. No vehicle is
renamed to make a promising route become Vehicle 5.

Each family/orientation/hotspot has a seven-stage count:

1. Layouts generated.
2. V5 uses incident.
3. V5 has customer→customer incident leg.
4. V5 has at least one served and two remaining at entry.
5. Those candidates also contain V1/V4 incident usage.
6. Candidates sent to full Simulation after timing/other existing checks.
7. Fully accepted candidates.

Primary rejection counters are exclusive; they identify the earliest failed
screen. Zero rejections at a later stage does not mean that later checks passed.
The official fixtures are written only after every technical criterion passes;
browser inspection is additionally required before reporting presentation-ready.

## Reproduction

```text
python tools/search_capacity_corridor.py --base-url http://127.0.0.1:8016 --primary-seeds 30 --variant-seeds 10
```

Use `--node /path/to/node` if necessary. This budgets 120 primary layouts and
40 per variant family, across the two existing hotspots and both orientations.
Do not overwrite previous reports when running another search: use `--report`.

The implementation adds only an offline search tool, focused unit tests and
audit artifacts. No LNS core, routing, Simulation, telemetry, frontend, multiplier
or acceptance threshold changes are part of this work.
