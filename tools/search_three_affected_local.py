"""Bounded continuation of candidate 37; input changes only, no installation."""
import copy
import json
from pathlib import Path
import random
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from road_network.store import NetworkStore
from road_network.costs import context, initial_road_solution
from road_network.routing import separation
from tools.economic_prefilter import EconomicPrefilter
from tools.design_root_scenario import edge_visit
from tools.search_local_delivery import service_state
from tools.search_conditional_local import good_v5


def main():
    root = Path(__file__).resolve().parents[1]
    parent = next(c for c in json.loads((root/'data/three_affected_delivery_search.json').read_text())['candidates'] if c['id']=='local-proven-topology/37')
    raw = NetworkStore(root/'data/raw/hcm_map4.osm').get()
    net, router = context(raw)
    screen = EconomicPrefilter(raw)
    eid = parent['edge_id']
    component = sorted(router.demo_profile()['demo_node_ids'])
    report = {'parent':parent['id'], 'limit':32, 'candidates':[], 'eligible':[], 'fixture_installed':False}
    output = root/'data/three_affected_local_continuation.json'
    if output.exists():
        report = json.loads(output.read_text(encoding='utf-8'))
    completed_indices = {e['index'] for e in report['candidates']}
    def save(): output.write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
    rng = random.Random(20261004)
    # Preserve detector and both economically passing peers. Target only the
    # four customer inputs previously assigned to the economically failing peer.
    mutable = [14,17,18,20]
    pools = {i:[n for n in component if separation(parent['scenario']['stops'][i],net['nodes'][n])<=500] for i in mutable}
    for index in range(32):
        scenario = copy.deepcopy(parent['scenario'])
        ids = [20] if index<16 else rng.sample(mutable,1+(index%3))
        changes = []
        for i in ids:
            used = {s['osm_node_id'] for s in scenario['stops']}
            n = rng.choice([n for n in pools[i] if n not in used])
            changes.append({'customer':i,'old':scenario['stops'][i]['osm_node_id'],'new':n})
            scenario['stops'][i].update(osm_node_id=n,lat=net['nodes'][n]['lat'],lon=net['nodes'][n]['lon'])
        # Replay the deterministic RNG without repeating any measured LNS solve.
        if index in completed_indices:
            continue
        initial = initial_road_solution(scenario,raw)
        routes = initial['road_geometry']['routes']
        speed = max(r['distance_m'] for r in routes)/146000
        users = [i+1 for i,r in enumerate(routes) if eid in r['edge_ids']]
        visits = {v:edge_visit(routes[v-1],eid,net['edges'],speed) for v in users}
        detector = min(users,key=lambda v:(visits[v]['arrival_ms'],v)) if users else None
        peers = [v for v in users if v!=detector and (visits[v]['arrival_ms']-visits[detector]['arrival_ms']-1750)*speed>=300]
        mid = bool(detector and good_v5(service_state(routes[detector-1],eid)))
        economic = {str(v):[screen.leg(l,eid) for l in routes[v-1]['legs'] if eid in l['edge_ids']] for v in peers} if mid and len(peers)>=3 else {}
        passing = [int(v) for v,legs in economic.items() if all(l['passed'] for l in legs)]
        duration = net['edges'][eid]['distance']/speed*3
        eligible = mid and len(passing)>=3 and duration>2250
        entry = dict(index=index,changes=changes,scenario=scenario,orders=initial['routes'],users=users,detector=detector,mid_delivery=mid,peers=peers,visits=visits,economic=economic,economically_avoiding=passing,slow_edge_ms=duration,eligible=eligible)
        report['candidates'].append(entry)
        if eligible:
            e = net['edges'][eid]
            fixture = dict(version=10,configuration_seed=f'local-37/{index}',source_sha256=raw['metadata']['source']['sha256'],roles={'detector':detector,'affected':passing[:3]},scenario=scenario,duration_ms=150000,event=dict(type='congestion',edge_id=eid,incident_edge_id=eid,from_node=e['from_node'],to_node=e['to_node'],baseline_travel_time=e['travel_time'],travel_time_multiplier=3,inject_at_ms=round(visits[detector]['arrival_ms']+250),sample_interval_ms=500,threshold=.5,consecutive_samples=2))
            target = root/f'data/three_affected_local_candidate_{index}.json'
            target.write_text(json.dumps(fixture,indent=2)+'\n',encoding='utf-8')
            report['eligible'].append(str(target))
        save()
        print(index, 'mid',mid,'peers',peers,'economic',passing,flush=True)
    report['completed']=True
    save()


if __name__=='__main__': main()
