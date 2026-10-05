"""Bounded input-only beam search. Never installs fixtures or changes runtime.

An automated success is saved separately for subsequent browser verification.
"""
import argparse
from collections import Counter
from concurrent.futures import ProcessPoolExecutor
import copy
import hashlib
import json
import os
from pathlib import Path
import random
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from road_network.store import NetworkStore
from road_network.costs import context, initial_road_solution
from road_network.routing import separation
from tools.search_topology_scenario import discover
from tools.search_capacity_corridor import generate_layout
from tools.search_local_delivery import prefilter, service_state
from tools.search_conditional_local import good_v5
from tools.economic_prefilter import EconomicPrefilter


def _init_worker(root):
    global _worker_raw
    _worker_raw = NetworkStore(Path(root)/'data/raw/hcm_map4.osm').get()


def _solve(scenario):
    return initial_road_solution(scenario, _worker_raw)


def topology_layout(network, component, depot, hotspot, centers, seed):
    """Two measured OD pairs create four critical regions; LNS assigns all loads."""
    rng = random.Random(f"two-od:{hotspot['edge_id']}:{seed}")
    sizes = ((2,6,2,6,4,4),(3,5,3,5,4,4),(5,3,5,3,4,4),(1,7,1,7,4,4))[seed % 4]
    chosen, regions = [], []
    for center, count in zip(centers, sizes):
        point = network['nodes'][center]
        radius = rng.uniform(100, 400)
        pool = [n for n in component if n != depot and n not in chosen and separation(point, network['nodes'][n]) < radius]
        if len(pool) < count:
            pool = sorted((n for n in component if n != depot and n not in chosen), key=lambda n: (separation(point, network['nodes'][n]), n))[:max(20,count)]
        group = rng.sample(pool, count)
        chosen.extend(group)
        regions.append({'center': point, 'count': count, 'osm_nodes': group, 'radius_m': radius})
    rng.shuffle(chosen)
    stops = [dict(id=i, osm_node_id=n, **{k:network['nodes'][n][k] for k in ('lat','lon')},
                  demand=10 if i else 0, ready_time=0, due_date=100000, service_time=1 if i else 0)
             for i,n in enumerate([depot]+chosen)]
    return {'vehicle_count':6, 'vehicle_capacity':40, 'options':{'seed':42,'iterations':80,'removal_count':5}, 'stops':stops}, regions


def rank(entry):
    return (entry.get('full_simulation', False), entry.get('economics', {}).get('passed', False),
            entry.get('timing_passed', False), entry['v5_good'], entry['role_members'],
            entry.get('validation', {}).get('presentation_score', -1000))


def local_variant(parent, network, component, seed):
    """Protect the good detector inputs; ownership is always decided anew by LNS."""
    rng = random.Random(f"final-local:{parent['id']}:{seed}")
    scenario = copy.deepcopy(parent['scenario'])
    protected = set(parent['orders'][4]) if parent['v5_good'] else {0}
    states = parent.get('states', {})
    if parent['v5_good'] and states.get('4') and not states.get('1'):
        protected.update(parent['orders'][3])
    if parent['v5_good'] and states.get('1') and not states.get('4'):
        protected.update(parent['orders'][0])
    targets = [s for s in scenario['stops'] if s['id'] not in protected]
    used = {s['osm_node_id'] for s in scenario['stops']}
    count = (1, 2, 3, 4)[seed % 4]
    changes = []
    missing_ids = set(i for v in (1,4) if not states.get(str(v)) for i in parent['orders'][v-1])
    priority = [s for s in targets if s['id'] in missing_ids]
    selected = rng.sample(priority, min(count, len(priority)))
    if len(selected) < count:
        others = [s for s in targets if s not in selected]
        selected.extend(rng.sample(others, min(count-len(selected), len(others))))
    for stop in selected:
        radius = (150, 300, 500, 750)[seed % 4]
        choices = [n for n in component if n not in used and separation(stop, network['nodes'][n]) <= radius]
        if not choices:
            continue
        n = rng.choice(choices)
        changes.append({'customer': stop['id'], 'old_node': stop['osm_node_id'], 'new_node': n})
        used.add(n)
        stop.update(osm_node_id=n, lat=network['nodes'][n]['lat'], lon=network['nodes'][n]['lon'])
    return scenario, changes


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--node', required=True)
    p.add_argument('--base-url', default='http://127.0.0.1:8016')
    p.add_argument('--report', type=Path, default=Path('data/final_economic_search_report.json'))
    p.add_argument('--topology-limit', type=int, default=160)
    p.add_argument('--hotspots', type=int, default=12)
    p.add_argument('--layouts', type=int, default=32)
    p.add_argument('--beam', type=int, default=10)
    p.add_argument('--local-variants', type=int, default=24)
    p.add_argument('--resume', action='store_true')
    p.add_argument('--workers', type=int, default=3)
    args = p.parse_args()
    root = Path(__file__).resolve().parents[1]
    official = [root/'data/presentation_scenario.json', root/'data/scenario_validation.json']
    hashes = lambda: {str(f.relative_to(root)): hashlib.sha256(f.read_bytes()).hexdigest() for f in official}
    raw = NetworkStore(root/'data/raw/hcm_map4.osm').get()
    network, router = context(raw)
    component = sorted(router.demo_profile()['demo_node_ids'])
    depot = json.loads(official[0].read_text(encoding='utf-8'))['scenario']['stops'][0]['osm_node_id']
    economics = EconomicPrefilter(raw)
    report = {'budget': {'topology_edges': args.topology_limit, 'hotspots': args.hotspots,
                         'layouts_per_hotspot': args.layouts, 'beam': args.beam, 'local_per_parent': args.local_variants},
              'source_sha256': raw['metadata']['source']['sha256'], 'fixture_hashes_before': hashes(),
              'excluded_prefixes': ['osm:722241447:'], 'topology': {}, 'candidates': [], 'completed': False}
    if args.resume:
        saved = json.loads(args.report.read_text(encoding='utf-8'))
        assert saved['source_sha256'] == report['source_sha256'] and saved['budget'] == report['budget']
        assert saved['fixture_hashes_before'] == hashes()
        report = saved
    def save(topology=None):
        if topology is not None:
            report['topology'] = topology
        report['counts'] = {key: sum(bool(e.get(key)) for e in report['candidates']) for key in
                            ('v5_good', 'all_roles', 'timing_passed', 'economic_v1', 'economic_v4', 'economic_both', 'full_simulation', 'accepted')}
        report['counts']['tested'] = len(report['candidates'])
        report['rejections'] = dict(Counter(e['rejection'] for e in report['candidates'] if e.get('rejection')))
        report['top_10_ids'] = [e['id'] for e in sorted(report['candidates'], key=rank, reverse=True)[:10]]
        report['fixture_hashes_after'] = hashes()
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    if not report.get('topology_complete'):
        # A sorted component makes anchor tie handling reproducible across processes.
        discover(network, router, depot, component, args.topology_limit, save, excluded_prefixes=('osm:722241447:',))
        report['topology_complete'] = True
        save()
    if 'shortlist' not in report:
        shortlist = []
        for h in report['topology']['promising']:
            ev = []
            for w in h['best_pair']['witnesses']:
                ids = w['old_edges']
                leg = {'from_stop': w['source'], 'to_stop': w['target'], 'edge_ids': ids,
                       'node_ids': [w['source'], w['target']]}
                ev.append(economics.leg(leg, h['edge_id']))
            if all(e['passed'] for e in ev):
                h['verified_economics'] = ev
                shortlist.append(h)
        shortlist.sort(key=lambda h: (-min(-e['delta_seconds'] for e in h['verified_economics']), -h['best_pair']['score']))
        report['shortlist'] = shortlist[:args.hotspots]
        save()
    done = {e['id'] for e in report['candidates']}
    def evaluate(scenario, h, identity, solved=None, **extra):
        if identity in done:
            return
        start = time.perf_counter()
        initial = solved if solved is not None else initial_road_solution(scenario, raw)
        eid = h['edge_id']
        states = {str(i+1): service_state(r, eid) for i, r in enumerate(initial['road_geometry']['routes'])}
        reason, details = prefilter(initial, eid, network['edges'])
        entry = dict(id=identity, edge_id=eid, scenario=scenario, orders=initial['routes'],
                     states=states, v5_good=good_v5(states.get('5')), role_members=sum(bool(states.get(str(v))) for v in (1,4,5)),
                     all_roles=all(bool(states.get(str(v))) for v in (1,4,5)), timing_passed=reason is None,
                     rejection=reason, prefilter=details, **extra)
        if reason is None:
            ec = economics.evaluate(initial, eid)
            entry.update(economics=ec, economic_v1=ec['vehicles']['1']['passed'], economic_v4=ec['vehicles']['4']['passed'], economic_both=ec['passed'])
            if not ec['passed']:
                entry['rejection'] = '+'.join(ec['failures'])
            else:
                edge = network['edges'][eid]
                fixture = {'version': 9, 'configuration_seed': identity, 'source_sha256': report['source_sha256'],
                           'scenario': scenario, 'duration_ms': 150000, 'design_validation': initial['overlap_analysis'],
                           'event': {'type': 'congestion', 'edge_id': eid, 'incident_edge_id': eid,
                                     'from_node': edge['from_node'], 'to_node': edge['to_node'],
                                     'baseline_travel_time': edge['travel_time'], 'baseline_speed': edge['distance']/edge['travel_time'],
                                     'vehicles_using_edge': details['users'], 'travel_time_multiplier': 3,
                                     'inject_at_ms': round(details['visits'][5]['arrival_ms']+250),
                                     'sample_interval_ms': 500, 'threshold': .5, 'consecutive_samples': 2}}
                with tempfile.TemporaryDirectory() as directory:
                    file = Path(directory)/'candidate.json'
                    file.write_text(json.dumps(fixture), encoding='utf-8')
                    run = subprocess.run([args.node, str(root/'tools/validate_presentation.cjs'), str(file)],
                                         env=dict(os.environ, LNS_TEST_URL=args.base_url), capture_output=True, text=True, timeout=180)
                evidence = json.loads(run.stdout) if run.returncode == 0 else {'accepted': False, 'error': run.stderr}
                entry.update(full_simulation=True, validation=evidence, accepted=evidence.get('accepted', False))
                entry['rejection'] = None if entry['accepted'] else '|'.join(evidence.get('acceptance_failures', ['FULL_SIMULATION_ERROR']))
                if entry['accepted']:
                    entry['candidate_fixture'] = fixture
                    (root/'data/final_automated_candidate.json').write_text(json.dumps(fixture, indent=2)+'\n', encoding='utf-8')
        entry['elapsed_seconds'] = time.perf_counter()-start
        report['candidates'].append(entry)
        done.add(identity)
        save()
        print('INPUT', identity, entry['rejection'] or 'AUTOMATED_PASS', flush=True)
    executor = ProcessPoolExecutor(max_workers=args.workers, initializer=_init_worker, initargs=(str(root),))
    report.setdefault('generation_revisions', []).append({'after_completed_inputs':len(done),
        'remaining_seed_slots_16_to_31':'two actual topology OD pairs; prior completed inputs preserved',
        'initial_lns_workers':args.workers})
    for h in report['shortlist']:
        # Actual witness endpoints supply the regional geometry, not compass directions.
        centers = [w[k] for w in h['best_pair']['witnesses'] for k in ('source', 'target')]
        while len(centers) < 6:
            centers.append(max(component, key=lambda n: (min(separation(network['nodes'][n], network['nodes'][c]) for c in centers), n)))
        base_regions = [{'center': network['nodes'][n]} for n in centers]
        pending = []
        for seed in range(args.layouts):
            small, orientation = ((2,0),(3,0),(3,1),(1,0))[seed % 4]
            identity = f"{h['edge_id']}/family-{small}-{orientation}/seed-{1000+seed}"
            if identity in done:
                continue
            generator = 'capacity_pair' if seed < 16 else 'two_topology_OD_pairs'
            if seed < 16:
                scenario, regions = generate_layout(network, component, depot, h, base_regions, small, orientation, 1000+seed)
            else:
                scenario, regions = topology_layout(network, component, depot, h, centers, 1000+seed)
            pending.append((scenario, regions, identity, generator))
        for (scenario, regions, identity, generator), solved in zip(pending, executor.map(_solve, (x[0] for x in pending))):
            evaluate(scenario, h, identity, solved=solved, regions=regions, generator=generator, phase='initial')
    if 'beam_ids' not in report:
        # Round-robin hotspot diversity, then fill by depth. Avoid one failed hotspot consuming the beam.
        ranked = sorted(report['candidates'], key=rank, reverse=True)
        beam = []
        for e in ranked:
            if e['edge_id'] not in {b['edge_id'] for b in beam}:
                beam.append(e)
            if len(beam) == args.beam:
                break
        for e in ranked:
            if len(beam) >= args.beam:
                break
            if e not in beam:
                beam.append(e)
        report['beam_ids'] = [e['id'] for e in beam]
        save()
    for identity in report['beam_ids']:
        parent = next(e for e in report['candidates'] if e['id'] == identity)
        hotspot = next(h for h in report['shortlist'] if h['edge_id'] == parent['edge_id'])
        pending = []
        for seed in range(args.local_variants):
            scenario, changes = local_variant(parent, network, component, seed)
            child = f'{identity}/local-{seed}'
            if child not in done:
                pending.append((scenario, changes, child))
        for (scenario, changes, child), solved in zip(pending, executor.map(_solve, (x[0] for x in pending))):
            evaluate(scenario, hotspot, child, solved=solved, phase='local', parent=identity, changes=changes)
    executor.shutdown()
    report['completed'] = True
    report['budget_exhausted'] = True
    report['official_fixture_unchanged'] = report['fixture_hashes_before'] == hashes()
    save()
    print('FINAL', json.dumps(report['counts']), flush=True)


if __name__ == '__main__':
    main()
