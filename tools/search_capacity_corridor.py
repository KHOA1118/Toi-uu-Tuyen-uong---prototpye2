"""Capacity-imbalanced regional inputs; real LNS retains all ownership decisions."""
import argparse
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

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from road_network.store import NetworkStore
from road_network.costs import context, initial_road_solution
from road_network.routing import separation
from tools.search_local_delivery import prefilter, service_state
from tools.search_topology_scenario import path

REASONS=('V5_NOT_ASSIGNED_INCIDENT','V5_OUTBOUND_LEG','V5_RETURN_LEG',
         'V5_CUSTOMER_TO_CUSTOMER_BUT_ZERO_BEFORE','V5_TOO_FEW_AFTER',
         'V1_NOT_AFFECTED','V4_NOT_AFFECTED','V1_REACHES_FIRST','V4_REACHES_FIRST',
         'DETECTION_TOO_LATE','FULL_SIMULATION_FAIL','V1_AVOIDANCE_FAIL',
         'V4_AVOIDANCE_FAIL','DISTINCT_DETOUR_FAIL','OTHER')


def corridor_centers(network,hotspot,rng):
    """Pick two centers on opposite sides along a measured directed shortest path."""
    witness=hotspot['best_pair']['witnesses'][rng.randrange(2)]
    ids=witness['old_edges'];cut=ids.index(hotspot['edge_id'])
    prefix=ids[:cut];suffix=ids[cut+1:]
    def offsets(edge_ids,reverse):
        distance=0;result=[]
        for eid in reversed(edge_ids) if reverse else edge_ids:
            edge=network['edges'][eid];distance+=edge['distance']
            if 150<=distance<=1300:
                result.append(edge['from_node'] if reverse else edge['to_node'])
        return result
    a=offsets(prefix,True) or [witness['source']]
    b=offsets(suffix,False) or [witness['target']]
    return rng.choice(a),rng.choice(b)


def generate_layout(network,component,depot,hotspot,base_regions,small,orientation,seed):
    rng=random.Random(f"capacity:{hotspot['edge_id']}:{small}:{orientation}:{seed}")
    nodes=network['nodes'];a,b=corridor_centers(network,hotspot,rng)
    # Background centers come from the retained successful shared-role geography.
    centers=[nodes[a],nodes[b]]
    backgrounds=sorted(base_regions,key=lambda r:-min(separation(r['center'],nodes[a]),separation(r['center'],nodes[b])))[:4]
    centers.extend(r['center'] for r in backgrounds)
    counts=[small,8-small,4,4,4,4] if orientation==0 else [8-small,small,4,4,4,4]
    chosen=[];regions=[]
    available=sorted(n for n in component if n!=depot)
    for i,(center,count) in enumerate(zip(centers,counts)):
        # The critical pair is close to a measured corridor, not an old layout jitter.
        radius=rng.uniform(80,260) if i<2 else rng.uniform(150,450)
        target=dict(center)
        if i>=2:
            target={'lat':center['lat']+rng.uniform(-200,200)/111320,
                    'lon':center['lon']+rng.uniform(-200,200)/109400}
        pool=[n for n in available if n not in chosen and separation(nodes[n],target)<radius]
        if len(pool)<count:
            pool=sorted((n for n in available if n not in chosen),key=lambda n:(separation(nodes[n],target),n))[:max(count,20)]
        sampled=rng.sample(pool,count);chosen.extend(sampled)
        regions.append({'region':('A','B','background_1','background_2','background_3','background_4')[i],
                        'center':target,'requested_radius_m':radius,'count':count,'osm_nodes':sampled,
                        'actual_max_radius_m':max(separation(nodes[n],target) for n in sampled)})
    rng.shuffle(chosen)
    stops=[dict(id=i,osm_node_id=n,lat=nodes[n]['lat'],lon=nodes[n]['lon'],demand=10 if i else 0,
                ready_time=0,due_date=100000,service_time=1 if i else 0) for i,n in enumerate([depot]+chosen)]
    scenario={'vehicle_count':6,'vehicle_capacity':40,'options':{'seed':42,'iterations':80,'removal_count':5},'stops':stops}
    return scenario,regions


def funnel(initial,eid):
    routes=initial['road_geometry']['routes']
    state=service_state(routes[4],eid) if len(routes)>4 else None
    customer_leg=bool(state and state['from_stop']>0 and state['to_stop']>0)
    delivery=customer_leg and state['served_before']>=1 and len(state['remaining_customers'])>=2
    peers=delivery and all(eid in routes[v-1]['edge_ids'] for v in (1,4))
    return {'layouts_generated':1,'v5_uses_incident':int(state is not None),
            'v5_customer_to_customer':int(customer_leg),'v5_delivery_counts_valid':int(delivery),
            'also_v1_v4':int(peers),'sent_to_simulation':0,'fully_accepted':0}


def full_failure(evidence):
    failures=evidence.get('acceptance_failures',[])
    for v in (1,4):
        if f'vehicle_{v}_did_not_avoid' in failures:return f'V{v}_AVOIDANCE_FAIL'
    if 'detours_not_distinct' in failures or any('weak_visible_change' in f for f in failures):
        return 'DISTINCT_DETOUR_FAIL'
    return 'FULL_SIMULATION_FAIL'


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--node',default=shutil.which('node'))
    parser.add_argument('--base-url',default='http://127.0.0.1:8016')
    parser.add_argument('--primary-seeds',type=int,default=30)
    parser.add_argument('--variant-seeds',type=int,default=10)
    parser.add_argument('--report',type=Path,default=Path('data/capacity_corridor_search_report.json'))
    args=parser.parse_args()
    if not args.node:parser.error('Node is required for final real Simulation validation')
    root=Path(__file__).resolve().parents[1]
    prior_path=root/'data/topology_continuation_report.json'
    prior=json.loads(prior_path.read_text(encoding='utf-8'))
    retained=json.loads((root/'data/local_retained_candidates.json').read_text(encoding='utf-8'))['candidates']
    official=[root/'data/presentation_scenario.json',root/'data/scenario_validation.json']
    old=json.loads(official[0].read_text(encoding='utf-8'))
    raw=NetworkStore(root/'data/raw/hcm_map4.osm').get();network,router=context(raw)
    if raw['metadata']['source']['sha256']!=prior['source_sha256']:raise ValueError('Source graph changed')
    component=sorted(router.demo_profile()['demo_node_ids']);depot=old['scenario']['stops'][0]['osm_node_id']
    hotspot_ids=list(dict.fromkeys(c['edge_id'] for c in retained))
    report={'source_sha256':prior['source_sha256'],'topology_source_sha256':hashlib.sha256(prior_path.read_bytes()).hexdigest(),
            'hotspots':hotspot_ids,'topology_rescan':False,'primary_seeds':args.primary_seeds,'variant_seeds':args.variant_seeds,
            'fixture_hashes_before':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in official},
            'families':{},'candidates':[],'best_accepted':None}
    def save():
        counts=Counter(c['rejection'] for c in report['candidates'] if c['rejection'])
        report['rejection_counts']={r:counts[r] for r in REASONS}
        args.report.parent.mkdir(parents=True,exist_ok=True)
        args.report.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    best=None
    # Finish the primary 2/6 family on BOTH topologies before nearby variants.
    for small in (2,3,1):
        budget=args.primary_seeds if small==2 else args.variant_seeds
        for eid in hotspot_ids:
            hotspot=next(h for h in prior['topology']['promising'] if h['edge_id']==eid)
            bases=[c for c in retained if c['edge_id']==eid]
            for orientation in (0,1):
                sizes=[small,8-small] if orientation==0 else [8-small,small]
                key=f"{eid}/{sizes[0]}-{sizes[1]}-4-4-4-4"
                report['families'][key]={}
                for seed in range(budget):
                    base=bases[seed%len(bases)]
                    scenario,regions=generate_layout(network,component,depot,hotspot,base['regions'],small,orientation,seed)
                    initial=initial_road_solution(scenario,raw)
                    stage=funnel(initial,eid)
                    reason,details=prefilter(initial,eid,network['edges'])
                    reason={'V5_ZERO_SERVED_BEFORE':'V5_CUSTOMER_TO_CUSTOMER_BUT_ZERO_BEFORE',
                            'V5_TOO_FEW_REMAINING':'V5_TOO_FEW_AFTER'}.get(reason,reason)
                    region_of={n:r['region'] for r in regions for n in r['osm_nodes']}
                    stop_region={s['id']:region_of[s['osm_node_id']] for s in scenario['stops'] if s['id']}
                    entry={'family':key,'seed':seed,'parent_seed':base['seed'],'regions':regions,
                           'scenario':scenario,'initial_orders':initial['routes'],
                           'initial_route_regions':[[stop_region[s] for s in r if s] for r in initial['routes']],
                           'funnel':stage,'rejection':reason,'prefilter_details':details}
                    # Record actual cross-corridor service for every vehicle, without relabeling one as V5.
                    entry['fleet_incident_service']={v+1:service_state(r,eid) for v,r in enumerate(initial['road_geometry']['routes'])}
                    if reason is None:
                        e=network['edges'][eid]
                        candidate={'version':8,'configuration_seed':seed,'capacity_family':key,'source_sha256':prior['source_sha256'],
                            'scenario':scenario,'customer_regions':regions,'duration_ms':150000,'design_validation':initial['overlap_analysis'],
                            'event':{'type':'congestion','edge_id':eid,'incident_edge_id':eid,'from_node':e['from_node'],'to_node':e['to_node'],
                            'baseline_travel_time':e['travel_time'],'baseline_speed':e['distance']/e['travel_time'],
                            'vehicles_using_edge':details['users'],'travel_time_multiplier':3,'inject_at_ms':round(details['visits'][5]['arrival_ms']+250),
                            'sample_interval_ms':500,'threshold':.5,'consecutive_samples':2}}
                        with tempfile.TemporaryDirectory() as d:
                            p=Path(d)/'candidate.json';p.write_text(json.dumps(candidate),encoding='utf-8')
                            run=subprocess.run([args.node,str(root/'tools/validate_presentation.cjs'),str(p)],
                                env=dict(os.environ,LNS_TEST_URL=args.base_url),capture_output=True,text=True,timeout=120)
                        stage['sent_to_simulation']=1
                        evidence=json.loads(run.stdout) if run.returncode==0 else {'accepted':False,'error':run.stderr}
                        entry['validation']=evidence
                        if evidence['accepted']:
                            stage['fully_accepted']=1
                            if best is None or evidence['presentation_score']>best[1]['presentation_score']:best=(candidate,evidence)
                        else:entry['rejection']=full_failure(evidence)
                    for name,value in stage.items():report['families'][key][name]=report['families'][key].get(name,0)+value
                    report['candidates'].append(entry);save()
                    print('CAPACITY',key,seed,entry['rejection'] or 'ACCEPTED',flush=True)
    if best:
        report['best_accepted']={'family':best[0]['capacity_family'],'seed':best[0]['configuration_seed']}
        for p,value in zip(official,best):p.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    report['fixture_hashes_after']={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in official}
    report['completed']=True;save()
    print('RESULT',json.dumps({'families':report['families'],'rejections':report['rejection_counts'],'accepted':report['best_accepted']}),flush=True)


if __name__=='__main__':main()
