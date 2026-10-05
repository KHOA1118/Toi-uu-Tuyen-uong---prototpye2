"""Run real Simulation for natural-role inputs that passed all cheap gates.

Never installs any candidate. Browser review is still required after a pass.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from road_network.store import NetworkStore
from road_network.costs import context


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--node',required=True)
    parser.add_argument('--base-url',default='http://127.0.0.1:8016')
    args=parser.parse_args()
    root=Path(__file__).resolve().parents[1]
    source=json.loads((root/'data/final_economic_search_report.json').read_text(encoding='utf-8'))
    audit=json.loads((root/'data/final_natural_roles_audit.json').read_text(encoding='utf-8'))
    assert source['completed'] and audit['completed']
    network,_=context(NetworkStore(root/'data/raw/hcm_map4.osm').get())
    directory=root/'data/final_role_candidates'
    directory.mkdir(exist_ok=True)
    report={'candidates':[], 'official_fixture_modified':False, 'completed':False}
    for index,eligible in enumerate(audit['natural_role_eligible']):
        entry=next(e for e in source['candidates'] if e['id']==eligible['id'])
        eid=entry['edge_id']; edge=network['edges'][eid]
        fixture={'version':9,'configuration_seed':entry['id'],'source_sha256':source['source_sha256'],
                 'roles':{'detector':eligible['detector'],'affected':eligible['affected']},
                 'scenario':entry['scenario'],'duration_ms':150000,
                 'event':{'type':'congestion','edge_id':eid,'incident_edge_id':eid,'from_node':edge['from_node'],'to_node':edge['to_node'],
                          'baseline_travel_time':edge['travel_time'],'baseline_speed':edge['distance']/edge['travel_time'],
                          'travel_time_multiplier':3,'inject_at_ms':eligible['inject_at_ms'],
                          'sample_interval_ms':500,'threshold':.5,'consecutive_samples':2,
                          'vehicles_using_edge':[int(v) for v,s in entry['states'].items() if s]}}
        file=directory/f'candidate-{index}.json'
        file.write_text(json.dumps(fixture,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
        run=subprocess.run([args.node,str(root/'tools/validate_role_fallback.cjs'),str(file)],
                           env=dict(os.environ,LNS_TEST_URL=args.base_url),capture_output=True,text=True,timeout=180)
        evidence=json.loads(run.stdout) if run.returncode==0 else {'accepted':False,'error':run.stderr}
        (directory/f'validation-{index}.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
        report['candidates'].append({'id':entry['id'],'index':index,'roles':fixture['roles'],
                                     'accepted':evidence.get('accepted',False),'failures':evidence.get('acceptance_failures',[]),
                                     'error':evidence.get('error'),'presentation_score':evidence.get('presentation_score')})
        print('FALLBACK',index,entry['id'],report['candidates'][-1],flush=True)
        (root/'data/final_fallback_validation.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
    report['completed']=True
    (root/'data/final_fallback_validation.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')


if __name__=='__main__':
    main()
