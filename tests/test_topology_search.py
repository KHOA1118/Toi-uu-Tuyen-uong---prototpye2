"""Offline screening tests; do not replace real Simulation acceptance."""
import unittest

from tools.search_topology_scenario import path, spatial_evidence, rank_rejections
from road_network.routing import RoadRouter


class TopologyScreeningTests(unittest.TestCase):
    def test_ranking_preserves_deeper_timing_failures_for_followup(self):
        shallow={'stage':'initial_lns_prefilter','edge_id':'a','seed':0,'score':-980,
                 'initial_incident_vehicle_ids':[1,2,3],'failures':['missing_roles']}
        deeper=dict(shallow,seed=1,score=-1010,initial_incident_vehicle_ids=[1,4,5],
                    failures=['not_mid_delivery','not_first','too_close'])
        full=dict(shallow,seed=2,score=-2000,stage='full_simulation')
        self.assertEqual([r['seed'] for r in rank_rejections([shallow,deeper,full])],[2,1,0])
        self.assertEqual(deeper['failures'],['not_mid_delivery','not_first','too_close'])

    def test_opposite_edge_ids_on_same_road_are_not_distinct_corridors(self):
        network = {'nodes': {'a': {'lat': 10.75, 'lon': 106.7},
                             'b': {'lat': 10.75, 'lon': 106.705}},
                   'edges': {'ab': {'from_node': 'a', 'to_node': 'b', 'distance': 500},
                             'ba': {'from_node': 'b', 'to_node': 'a', 'distance': 500}}}
        for m in spatial_evidence(network, ['ab'], ['ba']):
            self.assertAlmostEqual(m['maximum_separation_m'], 0)
            self.assertEqual(m['length_at_75m'], 0)

    def test_parallel_visible_corridors_and_empty_comparison(self):
        network = {'nodes': {'a': {'lat': 10.75, 'lon': 106.7},
                             'b': {'lat': 10.75, 'lon': 106.705},
                             'c': {'lat': 10.75+120/111320, 'lon': 106.7},
                             'd': {'lat': 10.75+120/111320, 'lon': 106.705}},
                   'edges': {'ab': {'from_node': 'a', 'to_node': 'b', 'distance': 500},
                             'cd': {'from_node': 'c', 'to_node': 'd', 'distance': 500}}}
        for m in spatial_evidence(network, ['ab'], ['cd']):
            self.assertAlmostEqual(m['median_separation_m'], 120)
            self.assertAlmostEqual(m['length_at_75m'], 500)
            self.assertAlmostEqual(m['length_at_100m'], 500)
        self.assertTrue(all(m['median_separation_m'] is None for m in spatial_evidence(network, ['ab'], [])))

    def test_real_directed_router_economics_and_path_reconstruction(self):
        edges = {eid: {'from_node': a, 'to_node': b, 'distance': t*10,
                      'travel_time': t, 'status': 'open', 'way_id': 'w'}
                 for eid, a, b, t in [('hot', 'a', 'b', 10), ('ac', 'a', 'c', 9), ('cb', 'c', 'b', 9)]}
        network = {'edges': edges, 'ways': {'w': {'tags': {'highway': 'residential'}}}}
        router = RoadRouter(network)
        self.assertEqual(path(router, router.tree('a'), 'a', 'b'), ['hot'])
        changed = RoadRouter(dict(network, edges=dict(edges, hot=dict(edges['hot'], travel_time=30))))
        self.assertEqual(path(changed, changed.tree('a'), 'a', 'b'), ['ac', 'cb'])
        self.assertIsNone(path(changed, changed.tree('b'), 'b', 'a'))
        self.assertEqual(edges['hot']['travel_time'], 10)


if __name__ == '__main__':
    unittest.main()
