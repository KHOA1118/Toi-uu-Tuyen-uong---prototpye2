"""Audit existing final-search inputs for natural roles, without renumbering vehicles.

This is a cheap fallback eligibility audit, not full or visual acceptance.
"""
import itertools
from concurrent.futures import ProcessPoolExecutor
import json
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from road_network.store import NetworkStore
from road_network.costs import context, initial_road_solution
from tools.design_root_scenario import edge_visit
from tools.search_conditional_local import good_v5
from tools.search_local_delivery import service_state
from tools.economic_prefilter import EconomicPrefilter
from tools.search_final_economic import _init_worker, _solve


def main():
    root = Path(__file__).resolve().parents[1]
    source = json.loads((root/'data/final_economic_search_report.json').read_text(encoding='utf-8'))
    raw = NetworkStore(root/'data/raw/hcm_map4.osm').get()
    network, _ = context(raw)
    screen = EconomicPrefilter(raw)
    report = {'source_search_completed': source['completed'], 'inputs_searched':0,
              'new_layouts_generated':0, 'natural_role_eligible':[], 'cases':[]}
    output = root/'data/final_natural_roles_audit.json'
    entries = [e for e in source['candidates'] if sum(bool(s) for s in e['states'].values())>=3]
    executor = ProcessPoolExecutor(max_workers=3, initializer=_init_worker, initargs=(str(root),))
    for entry, initial in zip(entries, executor.map(_solve, (e['scenario'] for e in entries))):
        users = [int(v) for v,s in entry['states'].items() if s]
        if len(users) < 3:
            continue
        assert initial['routes'] == entry['orders'], 'Non-reproducing real initial LNS'
        routes = initial['road_geometry']['routes']
        eid = entry['edge_id']
        speed = max(r['distance_m'] for r in routes)/146000
        visits = {v:edge_visit(routes[v-1], eid, network['edges'], speed) for v in users}
        detector = min(users, key=lambda v:(visits[v]['arrival_ms'],v))
        state = service_state(routes[detector-1], eid)
        case = {'id':entry['id'], 'incident':eid, 'natural_detector':detector,
                'service_state':state, 'visits':visits, 'pairs':[]}
        if not initial['feasible'] or len(routes)!=6 or any(len(r)!=6 for r in initial['routes']) or sorted(c for r in initial['routes'] for c in r if c>0)!=list(range(1,25)):
            case['rejection'] = 'INITIAL_FEASIBILITY_CONTRACT'
        elif not good_v5(state):
            case['rejection'] = 'NATURAL_FIRST_VEHICLE_NOT_MID_DELIVERY'
        elif not initial['overlap_analysis']['accepted']:
            case['rejection'] = 'EXISTING_OVERLAP_CONTRACT'
        else:
            peers = [v for v in users if v!=detector and
                     (visits[v]['arrival_ms']-visits[detector]['arrival_ms']-1750)*speed >= 300]
            if len(peers)<2:
                case['rejection'] = 'FEWER_THAN_TWO_DISTANT_PEERS'
            else:
                for pair in itertools.combinations(peers,2):
                    evidence = {str(v):[screen.leg(l,eid) for l in routes[v-1]['legs'] if eid in l['edge_ids']] for v in pair}
                    passed = all(legs and all(e['passed'] for e in legs) for legs in evidence.values())
                    case['pairs'].append({'vehicles':pair, 'economics':evidence, 'passed':passed})
                    if passed:
                        report['natural_role_eligible'].append({'id':entry['id'], 'detector':detector, 'affected':pair,
                            'inject_at_ms':round(visits[detector]['arrival_ms']+250), 'economics':evidence})
                case['rejection'] = None if any(p['passed'] for p in case['pairs']) else 'NATURAL_PEER_ECONOMICS_FAIL'
        report['inputs_searched'] += 1
        report['cases'].append(case)
        output.write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
        print('ROLE_AUDIT', entry['id'], case['rejection'] or 'ELIGIBLE', flush=True)
    executor.shutdown()
    report['completed'] = True
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')


if __name__ == '__main__':
    main()
