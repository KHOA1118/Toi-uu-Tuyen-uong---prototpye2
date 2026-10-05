"""Local input search around exactly the eight measured V5 mid-delivery inputs.

Freezing input coordinates does not freeze ownership: every variant is solved
again by the real LNS, and loss of Vehicle 5's role is an explicit rejection.
"""
import argparse
from collections import Counter
import copy
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
from road_network.routing import RoadRouter, separation
from tools.search_local_delivery import service_state, prefilter
from tools.search_topology_scenario import path
from tools.economic_prefilter import EconomicPrefilter


def good_v5(state):
    return bool(state and state['from_stop']>0 and state['to_stop']>0
                and state['served_before']>=1 and len(state['remaining_customers'])>=2)


def perturb(base, network, pools, seed):
    """Move only unprotected customer coordinates; preserve IDs and all VRP fields."""
    scenario=copy.deepcopy(base['scenario'])
    rng=random.Random(f"conditional:{base['family']}:{base['seed']}:{seed}")
    protected=set(base['initial_orders'][4])
    # Preserve peer geometry when it already uses the incident as well.
    if base['fleet_incident_service'].get('4'):
        protected.update(base['initial_orders'][3])
    v1=[i for i in base['initial_orders'][0] if i>0 and i not in protected and pools.get(i)]
    background=[s['id'] for s in scenario['stops'] if s['id'] not in protected and s['id'] not in v1 and pools.get(s['id'])]
    mode=seed%4
    selected=rng.sample(v1,min(len(v1),[1,2,3,2][mode]))
    if mode==3:
        selected+=rng.sample(background,min(2,len(background)))
    # Reserve original nodes too: a later unchanged selected customer must not
    # collide with a node already chosen by an earlier perturbation.
    used={s['osm_node_id'] for s in scenario['stops']}
    changes=[]
    for sid in selected:
        stop=next(s for s in scenario['stops'] if s['id']==sid)
        radius=(150,300,500,750)[(seed//4)%4]
        choices=[p for p in pools[sid] if p['node_id'] not in used and p['distance_m']<=radius]
        preferred=[p for p in choices if p['return_path_uses_incident']]
        # Topology is a sampling preference only, never a requested vehicle route.
        options=preferred if preferred and seed%3!=2 else choices
        if not options:
            used.add(stop['osm_node_id'])
            continue
        selected_node=rng.choice(options)
        n=selected_node['node_id'];used.add(n)
        changes.append(dict(customer_id=sid,old_osm_node_id=stop['osm_node_id'],new_osm_node_id=n,
                            distance_m=selected_node['distance_m'],radius_m=radius,
                            return_path_uses_incident=selected_node['return_path_uses_incident']))
        stop.update(osm_node_id=n,lat=network['nodes'][n]['lat'],lon=network['nodes'][n]['lon'])
    original={s['id']:s for s in base['scenario']['stops']}
    assert all(s==original[s['id']] for s in scenario['stops'] if s['id'] in protected)
    assert len({s['osm_node_id'] for s in scenario['stops']})==25
    return scenario,changes,sorted(protected)


def diagnose(initial,eid,edges,base_had_v4):
    states={str(v+1):service_state(r,eid) for v,r in enumerate(initial['road_geometry']['routes'])}
    reason,details=prefilter(initial,eid,edges)
    checks={'v5_preserved':good_v5(states.get('5')),
            'v1_uses_incident':states.get('1') is not None,
            'v4_uses_incident':states.get('4') is not None}
    failures=[]
    if not checks['v5_preserved']:failures.append('V5_CONDITION_LOST')
    if not checks['v1_uses_incident']:failures.append('V1_STILL_MISSING_INCIDENT')
    if not checks['v4_uses_incident']:failures.append('V4_LOST_INCIDENT' if base_had_v4 else 'V4_STILL_MISSING_INCIDENT')
    if reason in ('V1_REACHES_FIRST','V4_REACHES_FIRST') or details.get('detail')=='another_fleet_vehicle_enters_first':
        failures.append('WRONG_ARRIVAL_ORDER')
    elif reason=='DETECTION_TOO_LATE':failures.append('APPROACH_TOO_CLOSE')
    elif reason=='OTHER':failures.append('INITIAL_CONTRACT_FAILURE')
    return checks,failures,reason,details,states


def validation_failures(evidence):
    exact=evidence.get('acceptance_failures',[])
    categories=[]
    if any(f'vehicle_{v}_did_not_avoid' in exact for v in (1,4)):
        categories.append('AVOIDANCE_FAILURE')
    if 'detours_not_distinct' in exact or any('weak_visible_change' in f for f in exact):
        categories.append('DISTINCT_DETOUR_FAILURE')
    if not evidence.get('accepted') and (not categories or evidence.get('error')):
        categories.append('FULL_SIMULATION_FAILURE')
    return categories


def rank(entry):
    c=entry['checks']
    economics=entry.get('economics')
    return (entry.get('full_simulation',False),economics is not None,
            sum(v['passed'] for v in economics['vehicles'].values()) if economics else 0,c['v5_preserved'],
            c['v1_uses_incident']+c['v4_uses_incident'],
            -len(entry['failures']),entry.get('validation',{}).get('presentation_score',-1000),
            -sum(x['distance_m'] for x in entry['changes']))


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--variants-per-input',type=int,default=24)
    parser.add_argument('--start-seed',type=int,default=0)
    parser.add_argument('--node',default=shutil.which('node'))
    parser.add_argument('--base-url',default='http://127.0.0.1:8016')
    parser.add_argument('--report',type=Path,default=Path('data/conditional_economic_search_report.json'))
    args=parser.parse_args()
    if not args.node:parser.error('Node is required for real Simulation validation')
    root=Path(__file__).resolve().parents[1]
    source_path=root/'data/capacity_corridor_search_report.json'
    source=json.loads(source_path.read_text(encoding='utf-8'))
    bases=[b for b in source['candidates'] if b['funnel']['v5_delivery_counts_valid'] and b['rejection']=='V1_NOT_AFFECTED']
    if len(bases)!=8:raise ValueError('Expected the exact eight retained inputs')
    raw=NetworkStore(root/'data/raw/hcm_map4.osm').get()
    if raw['metadata']['source']['sha256']!=source['source_sha256']:raise ValueError('OSM source changed')
    network,router=context(raw);component=sorted(router.demo_profile()['demo_node_ids'])
    economic_screen=EconomicPrefilter(raw)
    official=[root/'data/presentation_scenario.json',root/'data/scenario_validation.json']
    hashes=lambda:{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in official}
    report={'source_sha256':source['source_sha256'],'retained_source_sha256':hashlib.sha256(source_path.read_bytes()).hexdigest(),
            'variants_per_input':args.variants_per_input,'start_seed':args.start_seed,'topology_rescan':False,
            'economic_prefilter_enabled':True,
            'fixture_hashes_before':hashes(),'retained_inputs':[],'per_input':{},'candidates':[],
            'top_10_closest':[],'best_accepted':None}
    def save():
        rejected=[e for e in report['candidates'] if e['failures']]
        report['top_10_closest']=sorted(rejected,key=rank,reverse=True)[:10]
        report['failure_counts']=dict(Counter(f for e in rejected for f in e['failures']))
        args.report.parent.mkdir(parents=True,exist_ok=True)
        args.report.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    # Reverse traversal is solely an offline sampling heuristic. LNS still uses
    # the unchanged directed network for all actual solutions.
    reverse=RoadRouter(dict(network,edges={k:dict(e,from_node=e['to_node'],to_node=e['from_node']) for k,e in network['edges'].items()}))
    depot=bases[0]['scenario']['stops'][0]['osm_node_id']
    reverse_tree=reverse.tree(depot)
    affinity_cache={};pool_cache={};best=None
    for base in bases:
        eid=base['family'].split('/')[0];key=f"{base['family']}/seed-{base['seed']}"
        initial=initial_road_solution(base['scenario'],raw)
        if initial['routes']!=base['initial_orders'] or not good_v5(service_state(initial['road_geometry']['routes'][4],eid)):
            raise ValueError(f'Retained input did not reproduce: {key}')
        had_v4=bool(base['fleet_incident_service'].get('4'))
        report['retained_inputs'].append({'key':key,'scenario':base['scenario'],'initial_orders':initial['routes'],
            'frozen_v5_customer_ids':[i for i in initial['routes'][4] if i>0],
            'base_v4_uses_incident':had_v4,'v5_service':service_state(initial['road_geometry']['routes'][4],eid)})
        pools={}
        protected=set(initial['routes'][4])|(set(initial['routes'][3]) if had_v4 else set())
        for stop in base['scenario']['stops']:
            if stop['id'] in protected:continue
            cache_key=(eid,stop['osm_node_id'])
            if cache_key not in pool_cache:
                values=[]
                for n in component:
                    d=separation(stop,network['nodes'][n])
                    if n==stop['osm_node_id'] or d>750:continue
                    if (eid,n) not in affinity_cache:
                        reverse_path=path(reverse,reverse_tree,depot,n)
                        affinity_cache[eid,n]=bool(reverse_path and eid in reverse_path)
                    values.append({'node_id':n,'distance_m':d,'return_path_uses_incident':affinity_cache[eid,n]})
                pool_cache[cache_key]=values
            pools[stop['id']]=pool_cache[cache_key]
        counts=report['per_input'][key]={'variants_tested':0,'v5_preserved':0,'v1_present_unconditional':0,
            'v5_and_v1':0,'all_three':0,'v4_present_unconditional':0,'timing_passed':0,
            'economics_v1_passed':0,'economics_v4_passed':0,'economics_both_passed':0,
            'full_simulations':0,'accepted':0,'base_v4_uses_incident':had_v4}
        for seed in range(args.start_seed,args.start_seed+args.variants_per_input):
            scenario,changes,frozen=perturb(base,network,pools,seed)
            result=initial_road_solution(scenario,raw)
            checks,failures,reason,details,states=diagnose(result,eid,network['edges'],had_v4)
            entry={'base':key,'local_seed':seed,'changes':changes,'frozen_customer_ids':frozen,
                'scenario':scenario,'initial_orders':result['routes'],'checks':checks,'failures':failures,
                'prefilter_reason':reason,'prefilter_details':details,'fleet_incident_service':states,'full_simulation':False}
            counts['variants_tested']+=1
            counts['v5_preserved']+=checks['v5_preserved']
            counts['v1_present_unconditional']+=checks['v1_uses_incident']
            counts['v4_present_unconditional']+=checks['v4_uses_incident']
            counts['v5_and_v1']+=checks['v5_preserved'] and checks['v1_uses_incident']
            counts['all_three']+=all(checks.values())
            if reason is None:
                counts['timing_passed']+=1
                economics=economic_screen.evaluate(result,eid)
                entry['economics']=economics
                counts['economics_v1_passed']+=economics['vehicles']['1']['passed']
                counts['economics_v4_passed']+=economics['vehicles']['4']['passed']
                counts['economics_both_passed']+=economics['passed']
                if not economics['passed']:
                    entry['failures']=economics['failures']
            if reason is None and entry['economics']['passed']:
                e=network['edges'][eid]
                candidate={'version':9,'configuration_seed':seed,'conditional_parent':key,'source_sha256':source['source_sha256'],
                    'scenario':scenario,'duration_ms':150000,'design_validation':result['overlap_analysis'],
                    'event':{'type':'congestion','edge_id':eid,'incident_edge_id':eid,'from_node':e['from_node'],'to_node':e['to_node'],
                    'baseline_travel_time':e['travel_time'],'baseline_speed':e['distance']/e['travel_time'],
                    'vehicles_using_edge':details['users'],'travel_time_multiplier':3,'inject_at_ms':round(details['visits'][5]['arrival_ms']+250),
                    'sample_interval_ms':500,'threshold':.5,'consecutive_samples':2}}
                with tempfile.TemporaryDirectory() as d:
                    p=Path(d)/'candidate.json';p.write_text(json.dumps(candidate),encoding='utf-8')
                    try:
                        run=subprocess.run([args.node,str(root/'tools/validate_presentation.cjs'),str(p)],
                            env=dict(os.environ,LNS_TEST_URL=args.base_url),capture_output=True,text=True,timeout=120)
                        evidence=json.loads(run.stdout) if run.returncode==0 else {'accepted':False,'error':run.stderr}
                    except subprocess.TimeoutExpired:
                        evidence={'accepted':False,'error':'Full validator exceeded 120 seconds'}
                entry.update(full_simulation=True,validation=evidence,failures=validation_failures(evidence))
                counts['full_simulations']+=1
                if evidence.get('accepted'):
                    counts['accepted']+=1
                    if best is None or evidence['presentation_score']>best[1]['presentation_score']:best=(candidate,evidence)
            report['candidates'].append(entry);save()
            print('CONDITIONAL',key,seed,entry['failures'] or 'ACCEPTED',flush=True)
    if best:
        report['best_accepted']={'parent':best[0]['conditional_parent'],'seed':best[0]['configuration_seed'],'score':best[1]['presentation_score']}
        for p,value in zip(official,best):p.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    report['fixture_hashes_after']=hashes();report['completed']=True;save()
    print('RESULT',json.dumps(report['per_input']),flush=True)


if __name__=='__main__':main()
