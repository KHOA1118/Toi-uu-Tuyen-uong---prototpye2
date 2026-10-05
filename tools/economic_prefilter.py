"""Offline service-leg economics; delegates shortest paths to the real router."""
import math
from road_network.costs import context
from road_network.routing import RoadRouter

REL_TOL = 1e-9
ABS_TOL = 1e-7  # seconds


class EconomicPrefilter:
    def __init__(self, network):
        self.network = context(network)[0]
        self.graphs = {}

    def _graphs(self, incident):
        if incident not in self.graphs:
            edges = self.network['edges']
            changed = dict(edges)
            changed[incident] = dict(edges[incident], travel_time=edges[incident]['travel_time']*3)
            congested = RoadRouter(dict(self.network, edges=changed))
            avoiding = RoadRouter(dict(self.network, edges={k:v for k,v in changed.items() if k!=incident}))
            # An isolated endpoint is unreachable, not a reason for a fallback.
            for node in congested.adj:
                avoiding.adj.setdefault(node, [])
            self.graphs[incident] = (congested, avoiding, {}, {})
        return self.graphs[incident]

    @staticmethod
    def _path(router, cache, source, target):
        if source not in cache:
            cache[source] = router.tree(source)
        costs, previous = cache[source]
        if target not in costs:
            return None, None
        cursor, ids = target, []
        while cursor != source:
            edge = previous[cursor]
            ids.append(edge)
            cursor = router.edges[edge]['from_node']
        return costs[target], list(reversed(ids))

    def leg(self, leg, incident):
        congested, avoiding, ccache, acache = self._graphs(incident)
        old = leg['edge_ids']
        if incident not in old:
            raise ValueError('Economic screen requires an actual incident-containing leg')
        source, target = leg['node_ids'][0], leg['node_ids'][-1]
        cursor = source
        for eid in old:
            if congested.edges[eid]['from_node'] != cursor:
                raise ValueError('Discontinuous original service leg')
            cursor = congested.edges[eid]['to_node']
        if cursor != target:
            raise ValueError('Original leg endpoint mismatch')
        original_x3 = sum(congested.edges[e]['travel_time'] for e in old)
        shortest, shortest_edges = self._path(congested, ccache, source, target)
        best_avoiding, avoiding_edges = self._path(avoiding, acache, source, target)
        cheaper = best_avoiding is not None and best_avoiding < original_x3
        avoids = shortest_edges is not None and incident not in shortest_edges
        equal = shortest is not None and best_avoiding is not None and math.isclose(shortest, best_avoiding, rel_tol=REL_TOL, abs_tol=ABS_TOL)
        reasons = []
        if not cheaper:
            reasons.append('no_directed_alternative' if best_avoiding is None else 'avoiding_not_strictly_cheaper_than_original_x3')
        if not avoids:
            reasons.append('router_shortest_path_x3_still_contains_incident')
        if not equal:
            reasons.append('shortest_x3_and_avoiding_cost_do_not_match')
        delta = None if best_avoiding is None else best_avoiding-original_x3
        return {'from_stop':leg['from_stop'], 'to_stop':leg['to_stop'], 'from_osm':source, 'to_osm':target,
                'original_edge_ids':list(old), 'original_path_cost_x3':original_x3,
                'shortest_path_x3':shortest, 'shortest_path_x3_edge_ids':shortest_edges,
                'best_avoiding_cost':best_avoiding, 'best_avoiding_edge_ids':avoiding_edges,
                'delta_seconds':delta, 'delta_percent':None if delta is None else 100*delta/original_x3,
                'avoidance_cheaper':cheaper, 'shortest_path_x3_avoids_incident':avoids,
                'shortest_matches_avoiding':equal, 'passed':cheaper and avoids and equal, 'failure_details':reasons}

    def evaluate(self, initial, incident):
        vehicles = {}
        failures = []
        for vehicle in (1,4):
            route = initial['road_geometry']['routes'][vehicle-1]
            legs = [self.leg(leg, incident) for leg in route['legs'] if incident in leg['edge_ids']]
            passed = bool(legs) and all(leg['passed'] for leg in legs)
            vehicles[str(vehicle)] = {'passed':passed, 'service_legs':legs}
            if not passed:
                failures.append(f'V{vehicle}_AVOIDANCE_NOT_ECONOMIC')
        return {'vehicles':vehicles, 'passed':not failures, 'failures':failures,
                'multiplier':3, 'cost_unit':'seconds', 'relative_tolerance':REL_TOL,'absolute_tolerance_seconds':ABS_TOL,
                'scope':'Actual incident-containing service legs in initial LNS geometry; full Simulation remains final authority',
                'delta_definition':'best_avoiding_cost - original_path_cost_x3'}
