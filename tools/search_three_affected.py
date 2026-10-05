"""Bounded, input-only final delivery screening. Never installs a failing fixture."""
import copy
import json
import math
from pathlib import Path
import random
import sys
import time

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from road_network.store import NetworkStore
from road_network.costs import context, initial_road_solution
from road_network.routing import separation
from tools.economic_prefilter import EconomicPrefilter
from tools.design_root_scenario import edge_visit
from tools.search_local_delivery import service_state
from tools.search_conditional_local import good_v5
from tools.search_final_economic import topology_layout


def main():
    root=Path(__file__).resolve().parents[1]
    raw=NetworkStore(root/'data/raw/hcm_map4.osm').get()
    net,router=context(raw);screen=EconomicPrefilter(raw)
    old=json.loads((root/'data/final_economic_search_report.json').read_text())
    fixture=json.loads((root/'data/presentation_scenario.json').read_text())
    audit=json.loads((root/'data/final_fixture_regression.json').read_text())
    focused='--focused' in sys.argv
    output=root/('data/three_affected_focused_search.json' if focused else 'data/three_affected_delivery_search.json')
    report={'preferred':{},'candidates':[],'eligible':[],'runtime_modified':False,'fixture_installed':False}
    def save():output.write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
    current=router.route({'stops':fixture['scenario']['stops'],'routes':audit['initial_routes']})['routes']
    assert [r['edge_ids'] for r in current]==audit['initial_geometry_edge_ids']
    for eid in ['osm:1294874724:4:r','osm:1218673270:45:r','osm:1218673270:46:r','osm:1218673270:44:r','osm:1218673270:47:r']:
        report['preferred'][eid]={str(v):screen.leg(next(l for l in current[v-1]['legs'] if eid in l['edge_ids']),eid) for v in [3,1,4]}
    save()
    component=sorted(router.demo_profile()['demo_node_ids'])
    depot=fixture['scenario']['stops'][0]['osm_node_id']
    def evaluate(scenario,eid,identity,orders=None):
        started=time.perf_counter()
        initial=initial_road_solution(scenario,raw) if orders is None else {'routes':orders,'road_geometry':router.route({'stops':scenario['stops'],'routes':orders}),'feasible':True}
        routes=initial['road_geometry']['routes'];speed=max(r['distance_m'] for r in routes)/146000
        users=[v+1 for v,r in enumerate(routes) if eid in r['edge_ids']]
        visits={v:edge_visit(routes[v-1],eid,net['edges'],speed) for v in users}
        detector=min(users,key=lambda v:(visits[v]['arrival_ms'],v)) if users else None
        peers=[v for v in users if v!=detector and (visits[v]['arrival_ms']-visits[detector]['arrival_ms']-1750)*speed>=300]
        mid=bool(detector and good_v5(service_state(routes[detector-1],eid)))
        duration=net['edges'][eid]['distance']/speed*3
        entry={'id':identity,'edge_id':eid,'scenario':scenario,'orders':initial['routes'],'users':users,'detector':detector,'mid_delivery':mid,'peers':peers,'visits':visits,'slow_edge_ms':duration,'economic':{},'stage':0}
        if len(users)>=4:entry['stage']=1
        if mid:entry['stage']=2
        if mid and len(peers)>=3:
            entry['stage']=3
            # 250ms after edge entry; exactly 2 further 500ms abnormal intervals
            # need the detector to remain on the edge through entry+1750ms.
            for v in peers:entry['economic'][str(v)]=[screen.leg(l,eid) for l in routes[v-1]['legs'] if eid in l['edge_ids']]
            passing=[v for v in peers if all(e['passed'] for e in entry['economic'][str(v)])]
            entry['economically_avoiding']=passing
            if len(passing)>=3:entry['stage']=4
            if len(passing)>=3 and duration>2250:
                entry['stage']=5
                e=net['edges'][eid]
                candidate={'version':10,'configuration_seed':identity,'source_sha256':raw['metadata']['source']['sha256'],'roles':{'detector':detector,'affected':passing[:3]},'scenario':scenario,'duration_ms':150000,'event':{'type':'congestion','edge_id':eid,'incident_edge_id':eid,'from_node':e['from_node'],'to_node':e['to_node'],'baseline_travel_time':e['travel_time'],'travel_time_multiplier':3,'inject_at_ms':round(visits[detector]['arrival_ms']+250),'sample_interval_ms':500,'threshold':.5,'consecutive_samples':2}}
                file=root/f'data/three_affected_candidate_{len(report["eligible"])}.json'
                file.write_text(json.dumps(candidate,indent=2)+'\n');report['eligible'].append(str(file))
        entry['seconds']=time.perf_counter()-started;report['candidates'].append(entry);save()
        print(identity,'stage',entry['stage'],'detector',detector,'peers',peers,'economic',entry.get('economically_avoiding'),flush=True)
        return entry
    # Reuse measured topology and prior LNS solutions before new input work.
    for e in old['candidates']:
        if sum(bool(s) for s in e['states'].values())>=4:evaluate(e['scenario'],e['edge_id'],'retained/'+e['id'],e['orders'])
    parent=json.loads((root/'data/final_role_candidates/candidate-1.json').read_text())
    base=evaluate(parent['scenario'],parent['event']['edge_id'],'validated-two-peer-parent')
    protected=set(base['orders'][base['detector']-1])
    rng=random.Random(20260929)
    h=next(h for h in old['shortlist'] if h['edge_id']==base['edge_id'])
    centers=[w[k] for w in h['best_pair']['witnesses'] for k in ['source','target']]
    if focused:
        protected.update(c for v in base['peers'] for c in base['orders'][v-1])
        centers=[s['osm_node_id'] for s in parent['scenario']['stops'] if s['id'] in base['orders'][2] and s['id']>0]
    pools={c:[n for n in component if separation(net['nodes'][c],net['nodes'][n])<600] for c in centers}
    for seed in range(24 if focused else 48):
        s=copy.deepcopy(parent['scenario']);targets=[p for p in s['stops'] if p['id'] not in protected]
        for stop in rng.sample(targets,1+seed%4):
            used={p['osm_node_id'] for p in s['stops']};c=centers[seed%len(centers)]
            choices=[n for n in pools[c] if n not in used]
            if choices:
                n=rng.choice(choices);stop.update(osm_node_id=n,lat=net['nodes'][n]['lat'],lon=net['nodes'][n]['lon'])
        evaluate(s,base['edge_id'],f'local-proven-topology/{seed}')
        if report['eligible']:break
    if not report['eligible'] and not focused:
        # Small beam over three already verified economic hotspots, no topology restart.
        for h in old['shortlist'][:3]:
            centers=[w[k] for w in h['best_pair']['witnesses'] for k in ['source','target']]
            while len(centers)<6:centers.append(max(component,key=lambda n:min(separation(net['nodes'][n],net['nodes'][c]) for c in centers)))
            for seed in range(24):
                s,_=topology_layout(net,component,depot,h,centers,2000+seed)
                evaluate(s,h['edge_id'],f'three-peer-topology/{h["edge_id"]}/{seed}')
                if report['eligible']:break
            if report['eligible']:break
    report['completed']=True
    report['counts']={str(i):sum(e['stage']>=i for e in report['candidates']) for i in range(6)}
    report['best_ids']=[e['id'] for e in sorted(report['candidates'],key=lambda e:(e['stage'],len(e.get('economically_avoiding',[])),e['detector']==5,len(e['peers'])),reverse=True)[:10]]
    save();print('FINAL',report['counts'],report['eligible'],flush=True)

if __name__=='__main__':main()
