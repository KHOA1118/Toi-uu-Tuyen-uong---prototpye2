"""Search fixed input configurations only; never edit a returned LNS route.

Run against the local app: python tools/design_root_scenario.py --node /path/to/node
Every accepted input must pass the real frontend Simulation + backend telemetry
and LNS pipeline in validate_presentation.cjs before either fixture is written.
"""
import argparse
import json
import os
import random
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from road_network.store import NetworkStore
from road_network.costs import context, initial_road_solution
from road_network.routing import RoadRouter, separation


def edge_visit(route, edge_id, edges, speed):
    """First directed edge occurrence; physical timing includes completed service."""
    distance, served = 0, 0
    for leg in route['legs']:
        for eid in leg['edge_ids']:
            if eid == edge_id:
                return {'arrival_ms':distance/speed+1000*served,
                        'from_stop':leg['from_stop'],'to_stop':leg['to_stop']}
            distance += edges[eid]['distance']
        served += int(leg['to_stop'] > 0)
    raise ValueError('Edge is absent from route')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--node', default=shutil.which('node'))
    parser.add_argument('--base-url', default='http://127.0.0.1:8016')
    parser.add_argument('--start-seed', type=int, default=0)
    parser.add_argument('--end-seed', type=int, default=120)
    parser.add_argument('--design', choices=('regions','corridor'), default='regions')
    parser.add_argument('--report', type=Path, default=Path('data/presentation_search_report.json'))
    args = parser.parse_args()
    if not args.node: parser.error('Node.js is required')
    root = Path(__file__).resolve().parents[1]
    previous = json.loads((root/'data/presentation_scenario.json').read_text(encoding='utf-8'))
    network = NetworkStore(root/'data/raw/hcm_map4.osm').get()
    timed, router = context(network)
    points = network['nodes']
    component = router.demo_profile()['demo_node_ids']
    depot = previous['scenario']['stops'][0]['osm_node_id']
    candidates = sorted(n for n in component if points[n]['lon']>points[depot]['lon']+.004
                        and 800<separation(points[n],points[depot])<5000)
    env = dict(os.environ,LNS_TEST_URL=args.base_url)
    def validate(fixture):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'input.json';path.write_text(json.dumps(fixture),encoding='utf-8')
            run = subprocess.run([args.node,str(root/'tools/validate_presentation.cjs'),str(path)],
                                 env=env,capture_output=True,text=True,timeout=120)
            if run.returncode: return {'accepted':False,'validation_error':run.stderr,'presentation_score':-1000}
            evidence=json.loads(run.stdout)
            evidence.setdefault('presentation_score',-1000)
            if not evidence.get('accepted') and 'acceptance_failures' not in evidence:
                evidence['acceptance_failures']=[evidence.get('reason','validation_failed')]
            return evidence
    baseline=validate(previous)
    audit={'seed_range':[args.start_seed,args.end_seed], 'configurations_evaluated':0,
           'customer_design':'six geographic regions, four sampled OSM nodes per region; shuffled input IDs; no vehicle assignments',
           'baseline':baseline,'rejections':{},'validated_candidates':[], 'selected':None}
    best=(previous,baseline,[]) if baseline.get('accepted') and previous.get('version',0)>=5 else None
    alternatives={}
    def reject(reason):audit['rejections'][reason]=audit['rejections'].get(reason,0)+1
    def alternative(eid):
        if eid not in alternatives:
            reduced=RoadRouter(dict(timed,edges={k:v for k,v in timed['edges'].items() if k!=eid}))
            # Removing an edge can leave an isolated source/sink in this offline
            # counterfactual graph. Keep its empty adjacency explicit.
            for node_id in points:
                reduced.adj.setdefault(node_id, [])
            alternatives[eid]=reduced
        return alternatives[eid]
    corridors=[]
    if args.design=='corridor':
        for eid,e in sorted(router.edges.items(),key=lambda item:(-item[1]['distance'],item[0])):
            if e['distance']<80:break
            if not 600<separation(points[depot],points[e['from_node']])<3500:continue
            alt=alternative(eid).tree(e['from_node'])[0].get(e['to_node'])
            if alt is not None and alt<3*e['travel_time']:
                corridors.append({'edge_id':eid,'center':points[e['from_node']],'detour_seconds':alt})
            alternatives.clear()
        print('Economically useful corridor anchors',len(corridors),flush=True)
        if not corridors:raise RuntimeError('No locally economical corridors')
    audit['design_family']=args.design
    for seed in range(args.start_seed,args.end_seed):
        rng=random.Random(seed)
        # Spread six REGIONS, then choose four nearby actual road nodes per region.
        pool=rng.sample(candidates,min(400,len(candidates)))
        centers=[rng.choice(pool)]
        while len(centers)<6:
            centers.append(max((n for n in pool if n not in centers),key=lambda n:(min(separation(points[n],points[c]) for c in centers),n)))
        if corridors:
            center=rng.choice(corridors)['center']
            # Six irregular regions around a REAL economically bypassable corridor.
            # Their input IDs are still shuffled; LNS alone chooses vehicle ownership.
            targets=[(-800,-700),(-300,600),(500,-800),(900,450),(100,1000),(1200,-100)]
            centers=[]
            for dx,dy in targets:
                target={'lat':center['lat']+(dy+rng.uniform(-200,200))/111320,
                        'lon':center['lon']+(dx+rng.uniform(-200,200))/109400}
                centers.append(min((n for n in candidates if n not in centers),key=lambda n:(separation(points[n],target),n)))
        chosen=[];regions=[]
        for center in centers:
            radius=rng.uniform(180,550) if corridors else rng.uniform(250,850)
            local=[n for n in candidates if n not in chosen and separation(points[n],points[center])<radius]
            if len(local)<4: local=sorted((n for n in candidates if n not in chosen),key=lambda n:separation(points[n],points[center]))[:30]
            group=rng.sample(local,4);chosen.extend(group);regions.append({'center_osm_node_id':center,'radius_m':radius,'customer_osm_nodes':group})
        rng.shuffle(chosen)
        stops=[dict(id=i,osm_node_id=n,lat=points[n]['lat'],lon=points[n]['lon'],demand=10 if i else 0,
                    ready_time=0,due_date=100000,service_time=1 if i else 0) for i,n in enumerate([depot]+chosen)]
        scenario={'vehicle_count':6,'vehicle_capacity':40,'options':{'seed':42,'iterations':80,'removal_count':5},'stops':stops}
        result=initial_road_solution(scenario,network);audit['configurations_evaluated']+=1
        geo=result['road_geometry'];analysis=result['overlap_analysis']
        print('Configuration',seed,'routes',len(result['routes']),flush=True)
        customers=[v for r in result['routes'] for v in r if v>0]
        if not result['feasible'] or len(result['routes'])!=6 or sorted(customers)!=list(range(1,25)) or any(len(r)!=6 for r in result['routes']):reject('feasibility_or_balance');continue
        if not analysis['accepted']:reject('insufficient_shared_corridors');continue
        speed=max(r['distance_m'] for r in geo['routes'])/146000
        for edge in sorted(geo['overlap']['shared_edges'],key=lambda e:(-e['baseline_distance_m'],e['edge_id'])):
            eid=edge['edge_id']
            if not {1,4,5}<=set(edge['vehicles_affected']):reject('roles_not_shared');continue
            if edge['baseline_distance_m']<60 or separation(points[depot],points[edge['from_node']])<600:reject('tiny_or_near_depot');continue
            visits={v:edge_visit(geo['routes'][v-1],eid,timed['edges'],speed) for v in edge['vehicles_affected']}
            v5=visits[5]
            if v5['from_stop']<=0 or v5['to_stop']<=0 or geo['routes'][4]['stop_sequence'].index(v5['to_stop']) not in (2,3):reject('not_mid_delivery');continue
            if min(visits,key=lambda v:visits[v]['arrival_ms'])!=5:reject('detector_not_first');continue
            if any((visits[v]['arrival_ms']-v5['arrival_ms']-1750)*speed<300 for v in [1,4]):reject('approachers_too_close');continue
            alt=alternative(eid);economics=[];possible=True
            for v in [1,4]:
                leg=next(l for l in geo['routes'][v-1]['legs'] if eid in l['edge_ids'])
                old=sum(timed['edges'][e]['travel_time'] for e in leg['edge_ids'])
                detour=alt.tree(leg['node_ids'][0])[0].get(leg['node_ids'][-1])
                penalized=old+2*timed['edges'][eid]['travel_time']*leg['edge_ids'].count(eid)
                economics.append({'vehicle_id':v,'leg_from':leg['from_stop'],'leg_to':leg['to_stop'],'normal_seconds':old,'congested_seconds':penalized,'avoiding_seconds':detour})
                if detour is None:possible=False
            if not possible:reject('no_directed_alternative');continue
            # Prefer economically competitive corridors; the real validator decides avoidance.
            raw=timed['edges'][eid]
            fixture={'version':5,'source_sha256':network['metadata']['source']['sha256'],'configuration_seed':seed,
                'scenario':scenario,'duration_ms':150000,'customer_regions':regions,
                'event':{'type':'congestion','edge_id':eid,'incident_edge_id':eid,'from_node':edge['from_node'],'to_node':edge['to_node'],
                    'baseline_travel_time':raw['travel_time'],'baseline_speed':raw['distance']/raw['travel_time'],
                    'vehicles_using_edge':edge['vehicles_affected'],'travel_time_multiplier':3,
                    'inject_at_ms':round(v5['arrival_ms']+250),'sample_interval_ms':500,'threshold':.5,'consecutive_samples':2},'design_validation':analysis}
            evidence=validate(fixture)
            evidence['alternative_path_economics']=economics
            if 'score_components' in evidence:
                evidence['score_components']['economical_alternatives']=sum(
                    10 if e['normal_seconds']<e['avoiding_seconds']<e['congested_seconds'] else -10
                    for e in economics)
                evidence['presentation_score']=sum(evidence['score_components'].values())
            summary={'seed':seed,'edge_id':eid,'accepted':evidence['accepted'],'score':evidence['presentation_score'],
                     'failures':evidence.get('acceptance_failures',[]),'error':evidence.get('validation_error'),'economics':economics}
            audit['validated_candidates'].append(summary)
            print('VALIDATED',json.dumps(summary),flush=True)
            if evidence['accepted'] and (best is None or evidence['presentation_score']>best[1]['presentation_score']):best=(fixture,evidence,economics)
            # Free alternate graph caches between candidates; no effect on runtime.
            alternatives.clear()
    if best:
        fixture,evidence,economics=best
        evidence.update(incident_from_node=fixture['event']['from_node'],incident_to_node=fixture['event']['to_node'],alternative_path_economics=economics)
        audit['selected']={'seed':fixture['configuration_seed'],'edge_id':fixture['event']['edge_id'],'score':evidence['presentation_score']}
        evidence['search_summary']={k:v for k,v in audit.items() if k!='baseline'}
        (root/'data/presentation_scenario.json').write_text(json.dumps(fixture,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
        (root/'data/scenario_validation.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    args.report.parent.mkdir(parents=True,exist_ok=True)
    args.report.write_text(json.dumps(audit,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    if not best:raise RuntimeError('No candidate met the visual contract; existing fixtures preserved. See search report.')
    print('BEST',json.dumps(audit['selected']),flush=True)

if __name__=='__main__':main()
