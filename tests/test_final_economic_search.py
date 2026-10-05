"""Search-only invariants; full acceptance still uses the production Simulation."""
import copy
import unittest
from tools.search_final_economic import local_variant, rank, topology_layout


class FinalSearchTests(unittest.TestCase):
    def test_local_inputs_preserve_detector_and_all_non_coordinate_fields(self):
        nodes = {str(i): {'lat': 10.75+i/100000, 'lon': 106.7} for i in range(80)}
        scenario = {'vehicle_count': 6, 'vehicle_capacity': 40,
                    'stops': [dict(id=i, osm_node_id=str(i), **nodes[str(i)], demand=10 if i else 0,
                                   ready_time=0, due_date=100000, service_time=1 if i else 0) for i in range(25)]}
        parent = {'id': 'measured-parent', 'scenario': scenario, 'v5_good': True,
                  'orders': [[0]+list(range(1+i*4, 5+i*4))+[0] for i in range(6)]}
        before = copy.deepcopy(parent)
        a, changes = local_variant(parent, {'nodes': nodes}, sorted(nodes), 3)
        self.assertEqual((a, changes), local_variant(parent, {'nodes': nodes}, sorted(nodes), 3))
        self.assertEqual(parent, before)
        self.assertTrue(changes)
        protected = set(parent['orders'][4])
        self.assertEqual(len({s['osm_node_id'] for s in a['stops']}), 25)
        for old, new in zip(scenario['stops'], a['stops']):
            if old['id'] in protected:
                self.assertEqual(old, new)
            for key in ('id', 'demand', 'ready_time', 'due_date', 'service_time'):
                self.assertEqual(old[key], new[key])

    def test_ranking_prefers_economics_and_full_simulation_depth(self):
        shallow = {'v5_good': True, 'role_members': 3}
        timing = dict(shallow, timing_passed=True)
        economic = dict(timing, economics={'passed': True})
        simulated = dict(economic, full_simulation=True)
        self.assertEqual(sorted([simulated, timing, shallow, economic], key=rank),
                         [shallow, timing, economic, simulated])

    def test_two_od_layout_has_unique_nodes_and_unchanged_load_contract(self):
        nodes = {str(i): {'lat':10.75+i/100000, 'lon':106.7} for i in range(80)}
        args = ({'nodes':nodes}, sorted(nodes), '0', {'edge_id':'real-edge-label'}, ['1','12','25','38','50','65'], 1000)
        scenario, regions = topology_layout(*args)
        self.assertEqual((scenario, regions), topology_layout(*args))
        self.assertEqual([r['count'] for r in regions], [2,6,2,6,4,4])
        self.assertEqual(len({s['osm_node_id'] for s in scenario['stops']}), 25)
        self.assertEqual(sum(s['demand'] for s in scenario['stops']), 240)
        self.assertEqual(scenario['vehicle_count'], 6)
        self.assertEqual(scenario['vehicle_capacity'], 40)
        self.assertNotIn('routes', scenario)


if __name__ == '__main__':
    unittest.main()
