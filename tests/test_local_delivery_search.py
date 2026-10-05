import unittest
from tools.search_local_delivery import service_state, prefilter, classify_validation


def initial_case(incident_leg):
    routes=[];orders=[];edges={}
    for vehicle in range(6):
        order=[0]+list(range(vehicle*4+1,vehicle*4+5))+[0]
        legs=[]
        for i,(a,b) in enumerate(zip(order,order[1:])):
            eid=f'{vehicle}:{i}'
            if (vehicle==4 and i==incident_leg) or (vehicle in (0,3) and i==4):eid='hot'
            legs.append({'from_stop':a,'to_stop':b,'edge_ids':[eid]})
            edges[eid]={'distance':1000}
        routes.append({'legs':legs,'edge_ids':[e for leg in legs for e in leg['edge_ids']],
                       'distance_m':5000,'stop_sequence':order})
        orders.append(order)
    return {'routes':orders,'feasible':True,'road_geometry':{'routes':routes},'overlap_analysis':{'accepted':True}},edges


class LocalDeliveryTests(unittest.TestCase):
    def test_service_leg_counts_destination_as_remaining_at_incident(self):
        for leg,served,remaining in [(1,1,3),(2,2,2),(3,3,1)]:
            initial,_=initial_case(leg)
            s=service_state(initial['road_geometry']['routes'][4],'hot')
            self.assertEqual(s['served_before'],served)
            self.assertEqual(len(s['remaining_customers']),remaining)

    def test_return_outbound_and_too_late_rejected_before_simulation(self):
        for leg,reason in [(0,'V5_OUTBOUND_LEG'),(4,'V5_RETURN_LEG'),(3,'V5_TOO_FEW_REMAINING')]:
            initial,edges=initial_case(leg)
            self.assertEqual(prefilter(initial,'hot',edges)[0],reason)

    def test_two_remaining_service_leg_can_pass_timing_screen(self):
        initial,edges=initial_case(2)
        reason,details=prefilter(initial,'hot',edges)
        self.assertIsNone(reason)
        self.assertTrue(all(d>=300 for d in details['estimated_approach_distance_m'].values()))

    def test_first_occurrence_cannot_be_replaced_with_later_favorable_leg(self):
        initial,_=initial_case(2)
        route=initial['road_geometry']['routes'][4]
        route['legs'][0]['edge_ids']=['hot']
        self.assertEqual(service_state(route,'hot')['from_stop'],0)

    def test_visual_failure_classification_preserves_strictness(self):
        self.assertEqual(classify_validation({'acceptance_failures':['vehicle_4_weak_visible_change']}),'V4_DETOUR_VISUAL_FAIL')
        self.assertEqual(classify_validation({'acceptance_failures':['detours_not_distinct']}),'DETOURS_NOT_DISTINCT')


if __name__=='__main__':unittest.main()
