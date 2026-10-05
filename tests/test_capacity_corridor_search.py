import copy
import unittest
from tools.search_capacity_corridor import generate_layout, funnel, full_failure
from tests.test_local_delivery_search import initial_case


class CapacityCorridorTests(unittest.TestCase):
    def test_asymmetric_regions_keep_exact_capacity_and_no_manual_assignments(self):
        nodes={f'{x}:{y}':{'lat':10.7+y*.001,'lon':106.7+x*.001} for x in range(17) for y in range(17)}
        edges={f'e{x}':{'from_node':f'{x}:8','to_node':f'{x+1}:8','distance':110} for x in range(16)}
        network={'nodes':nodes,'edges':edges}
        old=copy.deepcopy(network)
        witness={'source':'0:8','target':'16:8','old_edges':list(edges)}
        hotspot={'edge_id':'e8','best_pair':{'witnesses':[witness,witness]}}
        regions=[{'center':nodes[n]} for n in ['1:1','1:15','15:1','15:15','8:1','8:15']]
        for small in (2,3,1):
            for orientation in (0,1):
                args=(network,list(nodes),'0:0',hotspot,regions,small,orientation,7)
                scenario,groups=generate_layout(*args)
                expected=[small,8-small] if orientation==0 else [8-small,small]
                self.assertEqual([g['count'] for g in groups],expected+[4]*4)
                self.assertEqual(sum(s['demand'] for s in scenario['stops']),240)
                self.assertEqual(scenario['vehicle_count']*scenario['vehicle_capacity'],240)
                self.assertEqual(len({s['osm_node_id'] for s in scenario['stops']}),25)
                self.assertNotIn('initial_routes',scenario)
                self.assertEqual((scenario,groups),generate_layout(*args))
        self.assertEqual(network,old)

    def test_funnel_distinguishes_customer_leg_from_remaining_customer_requirement(self):
        initial,_=initial_case(3)
        counts=funnel(initial,'hot')
        self.assertEqual(counts['v5_uses_incident'],1)
        self.assertEqual(counts['v5_customer_to_customer'],1)
        self.assertEqual(counts['v5_delivery_counts_valid'],0)
        self.assertEqual(counts['also_v1_v4'],0)
        initial,_=initial_case(2)
        self.assertEqual(funnel(initial,'hot')['also_v1_v4'],1)

    def test_full_validation_failure_is_not_reclassified_as_a_pass(self):
        self.assertEqual(full_failure({'acceptance_failures':['vehicle_1_did_not_avoid']}),'V1_AVOIDANCE_FAIL')
        self.assertEqual(full_failure({'acceptance_failures':['detours_not_distinct']}),'DISTINCT_DETOUR_FAIL')
        self.assertEqual(full_failure({'error':'backend unavailable'}),'FULL_SIMULATION_FAIL')


if __name__=='__main__':unittest.main()
