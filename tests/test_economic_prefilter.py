import copy
import unittest
from tools.economic_prefilter import EconomicPrefilter


def example(detour=18):
    edges={eid:dict(from_node=a,to_node=b,distance=t*10,travel_time=t,status='open',way_id='w')
           for eid,a,b,t in [('hot','a','b',10),('ac','a','c',detour/2),('cb','c','b',detour/2)]}
    return {'metadata':{'source':{'sha256':str(detour)}},'edges':edges,
            'ways':{'w':{'tags':{'highway':'residential'}}},'nodes':{n:{} for n in 'abc'}}


LEG={'from_stop':7,'to_stop':8,'node_ids':['a','b'],'edge_ids':['hot']}


class EconomicPrefilterTests(unittest.TestCase):
    def test_profitable_detour_passes_even_though_shortest_equals_avoiding(self):
        network=example();before=copy.deepcopy(network)
        result=EconomicPrefilter(network).leg(LEG,'hot')
        self.assertEqual(result['original_path_cost_x3'],30)
        self.assertEqual(result['shortest_path_x3'],18)
        self.assertEqual(result['best_avoiding_cost'],18)
        self.assertTrue(result['passed'])
        self.assertEqual(result['delta_seconds'],-12)
        self.assertEqual(result['delta_percent'],-40)
        self.assertEqual(result['shortest_path_x3_edge_ids'],['ac','cb'])
        self.assertEqual(network,before)

    def test_expensive_and_equal_alternatives_fail(self):
        for cost in (30,40):
            with self.subTest(cost=cost):
                result=EconomicPrefilter(example(cost)).leg(LEG,'hot')
                self.assertFalse(result['passed'])
                self.assertFalse(result['avoidance_cheaper'])

    def test_no_directed_alternative_has_no_straight_line_fallback(self):
        network=example();del network['edges']['cb']
        result=EconomicPrefilter(network).leg(LEG,'hot')
        self.assertIsNone(result['best_avoiding_cost'])
        self.assertIsNone(result['best_avoiding_edge_ids'])
        self.assertFalse(result['passed'])

    def test_original_sequence_is_repriced_not_replaced_with_shortest(self):
        network=example()
        network['edges']['detour_in']=dict(network['edges']['ac'],from_node='x',to_node='a',travel_time=4)
        network['nodes']['x']={}
        leg=dict(LEG,node_ids=['x','a','b'],edge_ids=['detour_in','hot'])
        result=EconomicPrefilter(network).leg(leg,'hot')
        self.assertEqual(result['original_path_cost_x3'],34)
        self.assertEqual(result['best_avoiding_cost'],22)
        self.assertEqual(result['original_edge_ids'],['detour_in','hot'])

    def test_both_vehicle_results_and_missing_leg_are_explicit(self):
        initial={'road_geometry':{'routes':[{'legs':[LEG]} for _ in range(6)]}}
        screen=EconomicPrefilter(example())
        self.assertTrue(screen.evaluate(initial,'hot')['passed'])
        initial['road_geometry']['routes'][3]={'legs':[]}
        result=screen.evaluate(initial,'hot')
        self.assertEqual(result['failures'],['V4_AVOIDANCE_NOT_ECONOMIC'])
        self.assertTrue(result['vehicles']['1']['passed'])

    def test_cost_saving_alone_does_not_override_router_retaining_incident(self):
        network=example(40)
        network['nodes'].update(x={},d={})
        for eid,a,b,t in [('xa','x','a',20),('xd','x','d',1),('da','d','a',1)]:
            network['edges'][eid]=dict(network['edges']['hot'],from_node=a,to_node=b,travel_time=t)
        leg=dict(LEG,node_ids=['x','a','b'],edge_ids=['xa','hot'])
        result=EconomicPrefilter(network).leg(leg,'hot')
        self.assertEqual(result['original_path_cost_x3'],50)
        self.assertEqual(result['shortest_path_x3'],32)
        self.assertEqual(result['best_avoiding_cost'],42)
        self.assertTrue(result['avoidance_cheaper'])
        self.assertFalse(result['shortest_path_x3_avoids_incident'])
        self.assertFalse(result['passed'])


if __name__=='__main__':unittest.main()
