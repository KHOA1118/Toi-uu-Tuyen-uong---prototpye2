"""Offline topology-first input search. Never modifies solver or returned routes.

Topology witnesses are measured with the existing RoadRouter and an in-memory
x3 edge cost. They are screening evidence, never installed presentation routes.
"""
import argparse
import hashlib
import itertools
import json
import math
import os
from pathlib import Path
import random
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from road_network.store import NetworkStore
from road_network.costs import context, initial_road_solution
from road_network.routing import RoadRouter, separation
from tools.design_root_scenario import edge_visit

PRIOR_EDGE = 'osm:215938715:4:r'


def rank_rejections(entries):
    """Show deeper-stage failures first, rather than hiding them behind one cheap failure."""
    return sorted(entries, key=lambda r: (
        r['stage'] != 'full_simulation',
        not {1,4,5}.issubset(r.get('initial_incident_vehicle_ids', [])),
        -r.get('score', -1000), r['edge_id'], r['seed']))[:10]


def path(router, tree, source, target):
    distances, previous = tree
    if target not in distances:
        return None
    edges = []
    while target != source:
        eid = previous[target]
        edges.append(eid)
        target = router.edges[eid]['from_node']
    return list(reversed(edges))


def spatial_evidence(network, first, second):
    """Length-weighted samples to actual segments, not node proximity/edge IDs."""
    def xy(node):
        p = network['nodes'][node]
        return p['lon']*111320*math.cos(math.radians(10.75)), p['lat']*111320
    def segment(eid):
        e = network['edges'][eid]
        return xy(e['from_node']), xy(e['to_node'])
    def distance(p, a, b):
        dx, dy = b[0]-a[0], b[1]-a[1]
        t = max(0, min(1, ((p[0]-a[0])*dx+(p[1]-a[1])*dy)/(dx*dx+dy*dy or 1)))
        return math.hypot(p[0]-a[0]-t*dx, p[1]-a[1]-t*dy)
    result = []
    for ids, other in [(first, second), (second, first)]:
        targets = [segment(e) for e in other]
        samples = []
        if targets:
            for eid in ids:
                a, b = segment(eid)
                for t in (.25, .5, .75):
                    p = (a[0]+t*(b[0]-a[0]), a[1]+t*(b[1]-a[1]))
                    samples.append((min(distance(p, x, y) for x, y in targets), network['edges'][eid]['distance']/3))
        samples.sort()
        total = sum(w for _, w in samples)
        cumulative, median = 0, None
        for d, w in samples:
            cumulative += w
            if cumulative >= total/2:
                median = d
                break
        result.append({'median_separation_m': median, 'maximum_separation_m': max((d for d, _ in samples), default=None),
                       'length_at_75m': sum(w for d, w in samples if d >= 75),
                       'length_at_100m': sum(w for d, w in samples if d >= 100)})
    return result


def discover(network, router, depot, component, limit, persist, excluded_prefixes=()):
    nodes = network['nodes']
    eligible = [(eid, e) for eid, e in router.edges.items()
                if not eid.startswith(tuple(excluded_prefixes)) and e['distance'] >= 60 and 600 < separation(nodes[depot], nodes[e['from_node']]) < 4000
                and e['from_node'] in component and e['to_node'] in component]
    eligible.sort(key=lambda item: (item[0] != PRIOR_EDGE, -item[1]['travel_time'], item[0]))
    # Cover different locations, rather than spending the budget on adjacent fragments.
    selected = []
    for eid, e in eligible:
        if any(separation(nodes[e['from_node']], nodes[other['from_node']]) < 120 for _, other in selected):
            continue
        selected.append((eid, e))
        if len(selected) == limit:
            break
    audit = {'examined': 0, 'with_x3_economic_avoidance': 0, 'with_two_spatial_alternatives': 0,
             'prior_edge': PRIOR_EDGE, 'candidates': [], 'promising': []}
    for eid, edge in selected:
        center = nodes[edge['from_node']]
        nearby = [n for n in component if separation(center, nodes[n]) < 2600]
        anchors = []
        # 24 surrounding boundary anchors; no customer or vehicle assignment exists yet.
        for radius in (450, 1000, 1900):
            for sector in range(8):
                angle = sector*math.pi/4
                target = {'lat': center['lat']+radius*math.sin(angle)/111320,
                          'lon': center['lon']+radius*math.cos(angle)/109400}
                n = min(nearby, key=lambda n: (separation(nodes[n], target), n))
                if n not in anchors:
                    anchors.append(n)
        penalized = RoadRouter(dict(network, edges=dict(network['edges'], **{eid: dict(edge, travel_time=edge['travel_time']*3)})))
        witnesses = []
        economic_pairs = 0
        for source in anchors:
            normal_tree, changed_tree = router.tree(source), penalized.tree(source)
            for target in anchors:
                if source == target:
                    continue
                old = path(router, normal_tree, source, target)
                if not old or eid not in old:
                    continue
                new = path(penalized, changed_tree, source, target)
                if not new or eid in new:
                    continue
                normal = normal_tree[0][target]
                congested = normal+2*edge['travel_time']*old.count(eid)
                alternate = changed_tree[0][target]
                if not normal < alternate < congested:
                    continue
                economic_pairs += 1
                novel = [e for e in new if e not in old]
                length = sum(network['edges'][e]['distance'] for e in novel)
                if length < 300:
                    continue
                witnesses.append({'source': source, 'target': target, 'normal_seconds': normal,
                                  'congested_seconds': congested, 'avoiding_seconds': alternate,
                                  'old_edges': old, 'new_edges': new, 'novel_edges': novel, 'novel_length_m': length})
        # Identical novel corridors from multiple OD pairs are one spatial alternative.
        unique = {}
        for w in witnesses:
            signature = tuple(w['novel_edges'])
            if signature not in unique:
                unique[signature] = w
        pair_best = None
        for a, b in itertools.combinations(unique.values(), 2):
            metrics = spatial_evidence(network, a['novel_edges'], b['novel_edges'])
            score = min(m['length_at_75m'] for m in metrics)
            if pair_best is None or score > pair_best['score']:
                pair_best = {'score': score, 'witnesses': [a, b], 'spatial': metrics}
        record = {'edge_id': eid, 'center': center, 'economic_od_pairs': economic_pairs,
                  'unique_novel_corridors_at_least_300m': len(unique), 'best_pair': pair_best,
                  'accepted': pair_best is not None and pair_best['score'] >= 250}
        record['failures'] = ([] if record['accepted'] else
            ['no_x3_economic_avoidance'] if not economic_pairs else
            ['fewer_than_two_300m_novel_corridors'] if len(unique) < 2 else ['two_detours_not_separated_250m_at_75m'])
        audit['examined'] += 1
        audit['with_x3_economic_avoidance'] += bool(economic_pairs)
        audit['with_two_spatial_alternatives'] += record['accepted']
        audit['candidates'].append(record)
        if record['accepted']:
            audit['promising'].append(record)
        persist(audit)
        print('TOPOLOGY', eid, 'economical', economic_pairs, 'distinct', len(unique),
              'separated_m', pair_best['score'] if pair_best else None, flush=True)
    audit['promising'].sort(key=lambda r: -r['best_pair']['score'])
    return audit


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--node', default=shutil.which('node'))
    parser.add_argument('--base-url', default='http://127.0.0.1:8016')
    parser.add_argument('--topology-limit', type=int, default=80)
    parser.add_argument('--layouts-per-topology', type=int, default=60)
    parser.add_argument('--start-seed', type=int, default=0,
                        help='Continue a completed seed range without repeating earlier layouts')
    parser.add_argument('--edge', action='append', default=[],
                        help='Restrict continuation to measured, accepted topology IDs; repeatable')
    parser.add_argument('--max-topologies', type=int, default=6)
    parser.add_argument('--topology-cache', type=Path)
    parser.add_argument('--region-design', choices=('balanced','offset'), default='offset')
    parser.add_argument('--report', type=Path, default=Path('data/topology_search_report.json'))
    args = parser.parse_args()
    if not args.node:
        parser.error('Node.js required for real Simulation acceptance')
    root = Path(__file__).resolve().parents[1]
    fixture_paths = [root/'data/presentation_scenario.json', root/'data/scenario_validation.json']
    before_hash = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in fixture_paths}
    previous = json.loads(fixture_paths[0].read_text(encoding='utf-8'))
    raw = NetworkStore(root/'data/raw/hcm_map4.osm').get()
    network, router = context(raw)
    component = sorted(router.demo_profile()['demo_node_ids'])
    component_set = set(component)
    nodes = network['nodes']
    depot = previous['scenario']['stops'][0]['osm_node_id']
    report = {'source_sha256': raw['metadata']['source']['sha256'], 'policy_multiplier': 3,
              'search_parameters': vars(args) | {'report': str(args.report), 'topology_cache': str(args.topology_cache) if args.topology_cache else None}, 'topology': {},
              'configurations_per_topology': {}, 'full_simulations': 0, 'rejections': [],
              'top_10_rejected': [], 'best_accepted': None, 'fixture_hashes_before': before_hash}
    def save(topology=None):
        if topology is not None:
            report['topology'] = topology
        report['top_10_rejected'] = rank_rejections(report['rejections'])
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    if args.topology_cache:
        cached=json.loads(args.topology_cache.read_text(encoding='utf-8'))
        if cached['source_sha256']!=raw['metadata']['source']['sha256'] or cached['policy_multiplier']!=3 or cached['topology']['examined']!=args.topology_limit:
            raise ValueError('Topology cache provenance/policy/budget mismatch')
        topology=cached['topology']
        topology['promising'].sort(key=lambda r:-r['best_pair']['score'])
    else:
        topology = discover(network, router, depot, component_set, args.topology_limit, save)
    report['topology'] = topology
    best = None
    selected_topologies=[h for h in topology['promising'] if not args.edge or h['edge_id'] in args.edge]
    if set(args.edge)-{h['edge_id'] for h in selected_topologies}:
        raise ValueError('Requested edge is not a measured qualifying topology')
    for hotspot in selected_topologies[:args.max_topologies]:
        eid = hotspot['edge_id']
        edge = network['edges'][eid]
        center = hotspot['center']
        witnesses = hotspot['best_pair']['witnesses']
        base_centers = [w[k] for w in witnesses for k in ('source', 'target')]
        # OD endpoints define four service regions; two background regions are
        # discovered geographically, not assigned to vehicle IDs.
        pool = [n for n in component if 600 < separation(nodes[depot], nodes[n]) < 5500]
        while len(base_centers) < 6:
            base_centers.append(max(pool, key=lambda n: (min(separation(nodes[n], nodes[c]) for c in base_centers), n)))
        report['configurations_per_topology'][eid] = 0
        for seed in range(args.start_seed,args.start_seed+args.layouts_per_topology):
            rng = random.Random(f'{eid}:{seed}')
            chosen, regions = [], []
            sizes = ([3,5,3,5,4,4] if seed%2==0 else [5,3,5,3,4,4]) if args.region_design=='offset' else [4]*6
            for c,count in zip(base_centers,sizes):
                radius = rng.uniform(200, 750)
                target = {'lat': nodes[c]['lat']+rng.uniform(-350,350)/111320,
                          'lon': nodes[c]['lon']+rng.uniform(-350,350)/109400}
                local = sorted(n for n in pool if n not in chosen and separation(nodes[n], target) < radius)
                if len(local) < count:
                    local = sorted((n for n in pool if n not in chosen), key=lambda n: (separation(nodes[n], target), n))[:20]
                group = rng.sample(local, count)
                chosen.extend(group)
                regions.append({'center': target, 'radius_m': radius, 'osm_nodes': group})
            rng.shuffle(chosen)
            stops = [dict(id=i, osm_node_id=n, lat=nodes[n]['lat'], lon=nodes[n]['lon'], demand=10 if i else 0,
                          ready_time=0, due_date=100000, service_time=1 if i else 0) for i,n in enumerate([depot]+chosen)]
            scenario = {'vehicle_count': 6, 'vehicle_capacity': 40, 'options': {'seed':42,'iterations':80,'removal_count':5}, 'stops':stops}
            initial = initial_road_solution(scenario, raw)
            report['configurations_per_topology'][eid] += 1
            geometry = initial['road_geometry']
            users = [i+1 for i,r in enumerate(geometry['routes']) if eid in r['edge_ids']]
            failures = []
            if not initial['feasible'] or len(initial['routes']) != 6 or any(len(r)!=6 for r in initial['routes']):
                failures.append('initial_feasibility_or_balance')
            if not initial['overlap_analysis']['accepted']:
                failures.append('existing_overlap_contract')
            if not {1,4,5}.issubset(users):
                failures.append('initial_incident_not_shared_by_1_4_5')
            visits = {}
            if not failures:
                speed = max(r['distance_m'] for r in geometry['routes'])/146000
                visits = {v:edge_visit(geometry['routes'][v-1], eid, network['edges'], speed) for v in users}
                v5 = visits[5]
                if v5['from_stop']<=0 or v5['to_stop']<=0 or geometry['routes'][4]['stop_sequence'].index(v5['to_stop']) not in (2,3):
                    failures.append('vehicle_5_not_mid_delivery')
                if min(visits,key=lambda v:visits[v]['arrival_ms'])!=5:
                    failures.append('vehicle_5_not_first')
                for v in (1,4):
                    if (visits[v]['arrival_ms']-v5['arrival_ms']-1750)*speed < 300:
                        failures.append(f'vehicle_{v}_approach_too_close')
            entry = {'edge_id':eid,'seed':seed,'stage':'initial_lns_prefilter','failures':failures,'score':-1000+10*(3-len(failures)),
                     'region_sizes':sizes,'initial_incident_vehicle_ids':users,'visits':visits}
            if not failures:
                candidate = {'version':6,'source_sha256':raw['metadata']['source']['sha256'],'configuration_seed':seed,
                    'scenario':scenario,'duration_ms':150000,'customer_regions':regions,'topology_evidence':hotspot,
                    'event':{'type':'congestion','edge_id':eid,'incident_edge_id':eid,'from_node':edge['from_node'],'to_node':edge['to_node'],
                             'baseline_travel_time':edge['travel_time'],'baseline_speed':edge['distance']/edge['travel_time'],
                             'vehicles_using_edge':users,'travel_time_multiplier':3,'inject_at_ms':round(visits[5]['arrival_ms']+250),
                             'sample_interval_ms':500,'threshold':.5,'consecutive_samples':2},'design_validation':initial['overlap_analysis']}
                with tempfile.TemporaryDirectory() as d:
                    p=Path(d)/'candidate.json';p.write_text(json.dumps(candidate),encoding='utf-8')
                    run=subprocess.run([args.node,str(root/'tools/validate_presentation.cjs'),str(p)],
                        env=dict(os.environ,LNS_TEST_URL=args.base_url),capture_output=True,text=True,timeout=120)
                report['full_simulations']+=1
                evidence=json.loads(run.stdout) if run.returncode==0 else {'accepted':False,'acceptance_failures':['validator_runtime_failure'],'error':run.stderr}
                entry.update(stage='full_simulation',failures=evidence.get('acceptance_failures',[evidence.get('reason','unknown')]),
                             score=evidence.get('presentation_score',-1000),evidence=evidence)
                if evidence['accepted']:
                    if best is None or entry['score']>best[1]['presentation_score']:
                        best=(candidate,evidence)
                else:
                    report['rejections'].append(entry)
            else:
                report['rejections'].append(entry)
            print('LAYOUT',eid,seed,entry['stage'],entry['failures'],flush=True)
            save()
    if best:
        candidate,evidence=best
        report['best_accepted']={'edge_id':candidate['event']['edge_id'],'seed':candidate['configuration_seed'],'score':evidence['presentation_score']}
        for p,data in zip(fixture_paths,best):
            p.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    report['fixture_hashes_after']={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in fixture_paths}
    report['completed']=True
    save()
    print('RESULT',json.dumps({k:report[k] for k in ('configurations_per_topology','full_simulations','best_accepted')}),flush=True)


if __name__=='__main__':
    main()
