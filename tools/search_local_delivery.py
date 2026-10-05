"""Local input-only search around the three recovered corridor-role candidates.

No topology discovery, manual ownership, returned-route edits or runtime changes.
"""
import argparse
import copy
from collections import Counter
import hashlib
import json
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
from tools.search_topology_scenario import path

REJECTION_REASONS = (
    'V5_NOT_ASSIGNED_INCIDENT','V5_OUTBOUND_LEG','V5_RETURN_LEG',
    'V5_ZERO_SERVED_BEFORE','V5_TOO_FEW_REMAINING','V1_NOT_AFFECTED',
    'V4_NOT_AFFECTED','V1_REACHES_FIRST','V4_REACHES_FIRST','DETECTION_TOO_LATE',
    'ECONOMICS_FAIL','V1_DETOUR_VISUAL_FAIL','V4_DETOUR_VISUAL_FAIL',
    'DETOURS_NOT_DISTINCT','OTHER',
)

def reconstruct_layout(network, component, depot, hotspot, seed):
    """Exact offset-generator sequence from the completed seed 30–59 search."""
    nodes = network['nodes']
    centers = [w[k] for w in hotspot['best_pair']['witnesses'] for k in ('source','target')]
    pool = [n for n in sorted(component) if 600 < separation(nodes[depot],nodes[n]) < 5500]
    while len(centers)<6:
        centers.append(max(pool,key=lambda n:(min(separation(nodes[n],nodes[c]) for c in centers),n)))
    rng = random.Random(f"{hotspot['edge_id']}:{seed}")
    sizes = [3,5,3,5,4,4] if seed%2==0 else [5,3,5,3,4,4]
    chosen, regions = [], []
    for c,count in zip(centers,sizes):
        radius=rng.uniform(200,750)
        target={'lat':nodes[c]['lat']+rng.uniform(-350,350)/111320,
                'lon':nodes[c]['lon']+rng.uniform(-350,350)/109400}
        local=sorted(n for n in pool if n not in chosen and separation(nodes[n],target)<radius)
        if len(local)<count:
            local=sorted((n for n in pool if n not in chosen),key=lambda n:(separation(nodes[n],target),n))[:20]
        group=rng.sample(local,count);chosen.extend(group)
        regions.append({'center':target,'radius_m':radius,'osm_nodes':group})
    rng.shuffle(chosen)
    stops=[dict(id=i,osm_node_id=n,lat=nodes[n]['lat'],lon=nodes[n]['lon'],demand=10 if i else 0,
                ready_time=0,due_date=100000,service_time=1 if i else 0) for i,n in enumerate([depot]+chosen)]
    return {'vehicle_count':6,'vehicle_capacity':40,'options':{'seed':42,'iterations':80,'removal_count':5},'stops':stops},regions


def service_state(route, eid):
    """First occurrence only: a late repeated occurrence cannot conceal prior entry."""
    served=0
    for i,leg in enumerate(route['legs']):
        if eid in leg['edge_ids']:
            remaining=[l['to_stop'] for l in route['legs'][i:] if l['to_stop']>0]
            return {'leg_index':i,'from_stop':leg['from_stop'],'to_stop':leg['to_stop'],
                    'served_before':served,'remaining_customers':remaining}
        served+=leg['to_stop']>0
    return None


def prefilter(initial,eid,edges):
    geo=initial['road_geometry'];routes=geo['routes']
    ids=sorted(c for r in initial['routes'] for c in r if c>0)
    if not initial['feasible'] or len(routes)!=6 or ids!=list(range(1,25)) or any(len(r)!=6 for r in initial['routes']):
        return 'OTHER',{'detail':'initial_feasibility_or_balance'}
    state=service_state(routes[4],eid)
    info={'vehicle_5_service':state}
    if state is None:return 'V5_NOT_ASSIGNED_INCIDENT',info
    if state['from_stop']==0:return 'V5_OUTBOUND_LEG',info
    if state['to_stop']==0:return 'V5_RETURN_LEG',info
    if state['served_before']<1:return 'V5_ZERO_SERVED_BEFORE',info
    # Customers after entry include the destination of the incident-bearing leg.
    if len(state['remaining_customers'])<2:return 'V5_TOO_FEW_REMAINING',info
    for v in (1,4):
        if eid not in routes[v-1]['edge_ids']:return f'V{v}_NOT_AFFECTED',info
    speed=max(r['distance_m'] for r in routes)/146000
    users=[v+1 for v,r in enumerate(routes) if eid in r['edge_ids']]
    visits={v:edge_visit(routes[v-1],eid,edges,speed) for v in users}
    info.update(visits=visits,users=users,meters_per_ms=speed)
    for v in (1,4):
        if visits[v]['arrival_ms']<=visits[5]['arrival_ms']:return f'V{v}_REACHES_FIRST',info
    distances={v:(visits[v]['arrival_ms']-visits[5]['arrival_ms']-1750)*speed for v in (1,4)}
    info['estimated_approach_distance_m']=distances
    if min(distances.values())<300:return 'DETECTION_TOO_LATE',info
    if min(visits,key=lambda v:visits[v]['arrival_ms'])!=5:
        return 'DETECTION_TOO_LATE',dict(info,detail='another_fleet_vehicle_enters_first')
    if not initial['overlap_analysis']['accepted']:return 'OTHER',dict(info,detail='existing_overlap_contract')
    return None,info


def classify_validation(evidence):
    failures=evidence.get('acceptance_failures',[])
    for v in (1,4):
        if f'vehicle_{v}_did_not_avoid' in failures:return 'ECONOMICS_FAIL'
        if f'vehicle_{v}_weak_visible_change' in failures:return f'V{v}_DETOUR_VISUAL_FAIL'
    if 'detours_not_distinct' in failures:return 'DETOURS_NOT_DISTINCT'
    if any('too_close' in f or 'not_approaching' in f for f in failures):return 'DETECTION_TOO_LATE'
    return 'OTHER'


def directed_regions(network,router,component,eid,depot):
    """Before/after refer to directed shortest paths, not compass labels."""
    edge=network['edges'][eid];nodes=network['nodes']
    a,b=nodes[edge['from_node']],nodes[edge['to_node']]
    center={'lat':(a['lat']+b['lat'])/2,'lon':(a['lon']+b['lon'])/2}
    dx,dy=(b['lon']-a['lon'])*109400,(b['lat']-a['lat'])*111320
    length=(dx*dx+dy*dy)**.5
    if length<=0:raise ValueError('Incident edge has no geographic direction')
    candidates=sorted(n for n in component if n!=depot and separation(nodes[n],center)<2600)
    forward=router.tree(edge['from_node'])
    # Reverse graph is used only to find nodes whose shortest path TO the edge
    # naturally traverses it. This graph is never used by LNS or the frontend.
    reverse=RoadRouter(dict(network,edges={k:dict(e,from_node=e['to_node'],to_node=e['from_node']) for k,e in network['edges'].items()}))
    backward=reverse.tree(edge['to_node'])
    before=[];after=[];central=[]
    for n in candidates:
        a=path(router,forward,edge['from_node'],n)
        b=path(reverse,backward,edge['to_node'],n)
        # A split OSM way can force this edge into almost every boundary-node
        # shortest path. Use its geographic direction as well, so BEFORE and
        # AFTER cannot silently become the same pool. Final acceptance is real routing.
        progress=((nodes[n]['lon']-center['lon'])*109400*dx+(nodes[n]['lat']-center['lat'])*111320*dy)/length
        if a and eid in a and progress>=100:after.append(n)
        if b and eid in b and progress<=-100:before.append(n)
        if separation(nodes[n],center)<450:central.append(n)
    # Two downstream subregions using measured real detour destinations as centers.
    assert not set(before)&set(after)
    return {'before':before,'after':after,'central':central,'center':center}


def perturb(base,network,regions,hotspot,seed):
    rng=random.Random(f"local:{hotspot['edge_id']}:{base['seed']}:{seed}")
    scenario=copy.deepcopy(base['scenario']);nodes=network['nodes'];center=regions['center']
    near=sorted(scenario['stops'][1:],key=lambda s:(separation(s,center),s['id']))
    # Changes are selected geographically across the fleet, never by V5 ownership.
    count=(2,4,6,8)[seed%4]
    selected=rng.sample(near[:min(16,len(near))],count)
    modes=[['after','after'],['before','after','after','after'],
           ['before','before','central','after','after','after'],
           ['before','before','central','after','after','after','after','after']]
    pattern=modes[seed%4]
    used={s['osm_node_id'] for s in scenario['stops'] if s not in selected}
    changes=[]
    witnesses=hotspot['best_pair']['witnesses']
    for index,(stop,kind) in enumerate(zip(selected,pattern)):
        choices=[n for n in regions[kind] if n not in used]
        if not choices:raise ValueError(f'Empty local {kind} region')
        anchor=nodes[witnesses[(seed+index)%2]['target' if kind=='after' else 'source']]
        radius=rng.uniform(250,1100)
        local=[n for n in choices if separation(nodes[n],anchor)<radius]
        if len(local)<3:
            local=sorted(choices,key=lambda n:(separation(nodes[n],anchor),n))[:60]
        node=rng.choice(local);used.add(node)
        changes.append({'customer_id':stop['id'],'old_osm_node_id':stop['osm_node_id'],'new_osm_node_id':node,'region':kind,'radius_m':radius})
        stop.update(osm_node_id=node,lat=nodes[node]['lat'],lon=nodes[node]['lon'])
    return scenario,changes


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--node',default=shutil.which('node'))
    parser.add_argument('--base-url',default='http://127.0.0.1:8016')
    parser.add_argument('--layouts-per-candidate',type=int,default=60)
    parser.add_argument('--start-seed',type=int,default=0)
    parser.add_argument('--report',type=Path,default=Path('data/local_delivery_search_report.json'))
    args=parser.parse_args()
    if not args.node:parser.error('Node is required for final real Simulation validation')
    root=Path(__file__).resolve().parents[1]
    provenance=root/'data/topology_continuation_report.json'
    prior=json.loads(provenance.read_text(encoding='utf-8'))
    official=[root/'data/presentation_scenario.json',root/'data/scenario_validation.json']
    fixture=json.loads(official[0].read_text(encoding='utf-8'))
    raw=NetworkStore(root/'data/raw/hcm_map4.osm').get();network,router=context(raw)
    if raw['metadata']['source']['sha256']!=prior['source_sha256']:raise ValueError('Source graph changed')
    component=sorted(router.demo_profile()['demo_node_ids']);depot=fixture['scenario']['stops'][0]['osm_node_id']
    retained=[]
    for entry in prior['rejections']:
        if not {1,4,5}.issubset(entry['initial_incident_vehicle_ids']):continue
        hotspot=next(h for h in prior['topology']['promising'] if h['edge_id']==entry['edge_id'])
        scenario,regions=reconstruct_layout(network,component,depot,hotspot,entry['seed'])
        initial=initial_road_solution(scenario,raw)
        speed=max(r['distance_m'] for r in initial['road_geometry']['routes'])/146000
        visits={v:edge_visit(initial['road_geometry']['routes'][v-1],entry['edge_id'],network['edges'],speed) for v in entry['initial_incident_vehicle_ids']}
        for v,old in entry['visits'].items():
            assert abs(old['arrival_ms']-visits[int(v)]['arrival_ms'])<1e-6,'Reconstructed input does not reproduce source timing'
            assert old['from_stop']==visits[int(v)]['from_stop'] and old['to_stop']==visits[int(v)]['to_stop']
        retained.append({'edge_id':entry['edge_id'],'seed':entry['seed'],'scenario':scenario,'regions':regions,
                         'initial_result':initial,'arrival_timing':visits,
                         'vehicle_5_service':service_state(initial['road_geometry']['routes'][4],entry['edge_id']),
                         'v5_before_v1_v4':all(visits[5]['arrival_ms']<visits[v]['arrival_ms'] for v in (1,4))})
    assert len(retained)==3,'Expected exactly the three recovered shared-role candidates'
    (root/'data/local_retained_candidates.json').write_text(json.dumps({'source_report_sha256':hashlib.sha256(provenance.read_bytes()).hexdigest(),'candidates':retained},ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    report={'source_sha256':prior['source_sha256'],'retained_candidates':[(r['edge_id'],r['seed']) for r in retained],
            'local_seed_range':[args.start_seed,args.start_seed+args.layouts_per_candidate],
            'premise_correction':'All three reproduce shared V1/V4/V5 usage, but V5 is NOT earlier than both peers.',
            'fixture_hashes_before':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in official},
            'configurations_per_candidate':{},'full_simulations':0,'rejections':[],'accepted':None}
    def save():
        counts=Counter(r['reason'] for r in report['rejections'])
        report['rejection_counts']={reason:counts[reason] for reason in REJECTION_REASONS}
        args.report.parent.mkdir(parents=True,exist_ok=True)
        args.report.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    region_cache={};best=None
    for base in retained:
        eid=base['edge_id'];key=f"{eid}/seed-{base['seed']}";report['configurations_per_candidate'][key]=0
        hotspot=next(h for h in prior['topology']['promising'] if h['edge_id']==eid)
        if eid not in region_cache:region_cache[eid]=directed_regions(network,router,component,eid,depot)
        regions=region_cache[eid]
        print('REGIONS',key,{k:len(regions[k]) for k in ('before','after','central')},flush=True)
        for seed in range(args.start_seed,args.start_seed+args.layouts_per_candidate):
            scenario,changes=perturb(base,network,regions,hotspot,seed)
            initial=initial_road_solution(scenario,raw)
            reason,details=prefilter(initial,eid,network['edges'])
            report['configurations_per_candidate'][key]+=1
            entry={'base':key,'local_seed':seed,'changes':changes,'reason':reason,'details':details,
                   'initial_orders':initial['routes'],'stage':'service_leg_prefilter'}
            if reason is None:
                e=network['edges'][eid]
                candidate={'version':7,'configuration_seed':seed,'local_parent':key,'source_sha256':prior['source_sha256'],
                    'scenario':scenario,'duration_ms':150000,'design_validation':initial['overlap_analysis'],
                    'event':{'type':'congestion','edge_id':eid,'incident_edge_id':eid,'from_node':e['from_node'],'to_node':e['to_node'],
                    'baseline_travel_time':e['travel_time'],'baseline_speed':e['distance']/e['travel_time'],
                    'vehicles_using_edge':details['users'],'travel_time_multiplier':3,'inject_at_ms':round(details['visits'][5]['arrival_ms']+250),
                    'sample_interval_ms':500,'threshold':.5,'consecutive_samples':2}}
                with tempfile.TemporaryDirectory() as d:
                    p=Path(d)/'candidate.json';p.write_text(json.dumps(candidate),encoding='utf-8')
                    run=subprocess.run([args.node,str(root/'tools/validate_presentation.cjs'),str(p)],
                        env=dict(os.environ,LNS_TEST_URL=args.base_url),capture_output=True,text=True,timeout=120)
                report['full_simulations']+=1
                evidence=json.loads(run.stdout) if run.returncode==0 else {'accepted':False,'error':run.stderr}
                entry.update(stage='full_simulation',evidence=evidence)
                if evidence['accepted']:
                    if best is None or evidence['presentation_score']>best[1]['presentation_score']:best=(candidate,evidence)
                else:reason=entry['reason']=classify_validation(evidence)
            if reason is not None:report['rejections'].append(entry)
            print('LOCAL',key,seed,reason or 'ACCEPTED',flush=True);save()
    if best:
        report['accepted']={'parent':best[0]['local_parent'],'local_seed':best[0]['configuration_seed']}
        for p,value in zip(official,best):p.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    report['fixture_hashes_after']={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in official}
    report['completed']=True;save()
    print('RESULT',json.dumps({k:report[k] for k in ('configurations_per_candidate','full_simulations','rejection_counts','accepted')}),flush=True)


if __name__=='__main__':main()
