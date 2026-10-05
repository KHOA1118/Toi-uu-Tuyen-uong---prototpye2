import copy
import json
from pathlib import Path
import unittest

from tools.search_conditional_local import perturb, good_v5, validation_failures, rank


class ConditionalLocalTests(unittest.TestCase):
    def test_coordinates_of_v5_and_present_v4_are_frozen_without_assignment_constraints(self):
        source=json.loads((Path(__file__).resolve().parents[1]/'data/capacity_corridor_search_report.json').read_text(encoding='utf-8'))
        base=next(b for b in source['candidates'] if b['rejection']=='V1_NOT_AFFECTED' and b['fleet_incident_service']['4'])
        original=copy.deepcopy(base)
        nodes={s['osm_node_id']:dict(lat=s['lat'],lon=s['lon']) for s in base['scenario']['stops']}
        pools={}
        for s in base['scenario']['stops'][1:]:
            n='test-'+str(s['id']);nodes[n]=dict(lat=s['lat']+.0001,lon=s['lon'])
            pools[s['id']]=[dict(node_id=n,distance_m=12,return_path_uses_incident=True)]
        for seed in range(8):
            result,changes,frozen=perturb(base,{'nodes':nodes},pools,seed)
            self.assertTrue(changes)
            self.assertTrue(set(base['initial_orders'][4]).issubset(frozen))
            self.assertTrue(set(base['initial_orders'][3]).issubset(frozen))
            for old,new in zip(base['scenario']['stops'],result['stops']):
                if old['id'] in frozen:self.assertEqual(old,new)
                for key in ['id','demand','ready_time','due_date','service_time']:self.assertEqual(old[key],new[key])
            self.assertNotIn('initial_routes',result)
            self.assertEqual(result,perturb(base,{'nodes':nodes},pools,seed)[0])
        self.assertEqual(base,original)

    def test_delivery_and_failure_categories_are_not_false_passes(self):
        self.assertTrue(good_v5(dict(from_stop=2,to_stop=3,served_before=2,remaining_customers=[3,4])))
        self.assertFalse(good_v5(dict(from_stop=2,to_stop=0,served_before=4,remaining_customers=[])))
        self.assertFalse(good_v5(dict(from_stop=2,to_stop=3,served_before=3,remaining_customers=[3])))
        self.assertEqual(validation_failures({'accepted':False,'error':'backend unavailable'}),['FULL_SIMULATION_FAILURE'])
        self.assertEqual(validation_failures({'accepted':False,'acceptance_failures':['vehicle_1_did_not_avoid','detours_not_distinct']}),['AVOIDANCE_FAILURE','DISTINCT_DETOUR_FAILURE'])

    def test_ranking_prefers_preserving_v5_over_restoring_v1_alone(self):
        lost={'checks':dict(v5_preserved=False,v1_uses_incident=True,v4_uses_incident=True),'failures':['V5_CONDITION_LOST'],'changes':[]}
        preserved={'checks':dict(v5_preserved=True,v1_uses_incident=False,v4_uses_incident=True),'failures':['V1_STILL_MISSING_INCIDENT'],'changes':[]}
        self.assertGreater(rank(preserved),rank(lost))


if __name__=='__main__':unittest.main()
