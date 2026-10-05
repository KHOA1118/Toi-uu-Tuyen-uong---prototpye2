const fs=require('node:fs');
const assert=require('node:assert/strict');
const {Simulation}=require('../frontend/simulation.js');
const {Presentation}=require('../frontend/presentation.js');

// Directed occurrence indices distinguish past visits, current commitment, and future work.
function incidentPathState(edgeIds, vehicle, edgeId){
 const occurrences=edgeIds.flatMap((e,i)=>e===edgeId?[i]:[]);
 return {
  incident_edge_already_traversed:occurrences.some(i=>i<vehicle.segment||(i===vehicle.segment&&vehicle.edgeId===edgeId&&vehicle.edgeFraction>0)),
  incident_edge_ahead_at_detection:occurrences.some(i=>i>vehicle.segment||(i===vehicle.segment&&(vehicle.edgeId!==edgeId||vehicle.edgeFraction===0)))
 };
}

async function validateScenario(fixture,{base=process.env.LNS_TEST_URL||'http://127.0.0.1:8013',frame=50,solveAdvanceMs=500}={}){
 const api=async(path,body)=>{const r=await fetch(base+path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});const d=await r.json();assert.ok(r.ok,JSON.stringify(d));return d;};
 const finishJob=async job=>{for(let n=0;n<300;n++){const j=await api('/api/jobs/'+job.job_id);if(j.status==='completed')return j.result;if(j.status==='failed')throw Error(j.error);await new Promise(r=>setTimeout(r,100));}throw Error('Job timeout');};
 const network=await api('/api/network');
 const initial=await finishJob(await api('/api/jobs/initial',{scenario:fixture.scenario}));
 assert.equal(initial.feasible,true);assert.equal(initial.routes.length,6);assert.ok(initial.overlap_analysis.accepted);
 const customers=initial.routes.flatMap(r=>r.filter(id=>id>0));assert.equal(customers.length,24);assert.equal(new Set(customers).size,24);
 assert.equal(fixture.scenario.vehicle_count,6);assert.equal(fixture.scenario.vehicle_capacity,40);
 assert.ok(fixture.scenario.stops.every(s=>s.demand===(s.id?10:0)));
 assert.ok(initial.routes.every(r=>r.length===6));
 const sim=new Simulation(initial.road_geometry.routes,network,{durationMs:fixture.duration_ms,stops:fixture.scenario.stops});
 const session=await api('/api/simulation',{source_sha256:fixture.source_sha256});sim.setIncidentState(session);
 const run=new Presentation(fixture);run.phase='moving';sim.start();
 const completion={},seenServed=sim.snapshot().map(()=>[]);const record=()=>{for(const v of sim.snapshot()){assert.ok(seenServed[v.routeIndex].every(id=>v.served.includes(id)));assert.equal(new Set(v.served).size,v.served.length);seenServed[v.routeIndex]=v.served;if(v.status==='completed'&&completion[v.vehicleId]===undefined)completion[v.vehicleId]=sim.elapsed;}};
 const advance=ms=>{sim.advance(ms);record();};
 while(sim.elapsed<fixture.event.inject_at_ms)advance(run.budget(sim.elapsed,frame));
 const injectionSnapshot=sim.snapshot();
 if(fixture.version>=4){const v=injectionSnapshot[4];assert.equal(v.edgeId,fixture.event.edge_id);assert.ok(v.edgeFraction>0&&v.edgeFraction<1);}
 const original=JSON.stringify(sim.routes),lifecycle=['INACTIVE'];
 const injected=await api('/api/traffic/inject',{session_id:session.session_id,edge_id:fixture.event.edge_id,expected_speed:sim.metersPerMs});
 run.lifecycle=injected.lifecycle;lifecycle.push(run.lifecycle);sim.setPhysicalState(injected.physical_overrides);
 let detected; const telemetryEvidence=[];
 const owners=sim.routes.map(r=>r.stop_sequence.filter(id=>id>0).sort((a,b)=>a-b));
 for(let n=0;n<500;n++){
  while(sim.elapsed<run.nextSample&&sim.status!=='completed')advance(run.budget(sim.elapsed,frame));
  if(sim.status==='completed')break;
  const measured=await api('/api/traffic/telemetry',{session_id:session.session_id,samples:run.samples(sim)});run.nextSample+=fixture.event.sample_interval_ms;
  assert.equal(JSON.stringify(sim.routes),original);
  assert.equal(sim.incidentState.revision,0); assert.equal(sim.pending,null);
  telemetryEvidence.push(...measured.evidence.map(e=>({...e,time_ms:sim.elapsed})));
  if(measured.lifecycle==='DETECTED'){detected=measured;break;}
  assert.equal(measured.known_state.revision,0);assert.deepEqual(measured.known_state.edge_overrides,{});
 }
 if(!detected)return {accepted:false,reason:'No detection'};
 lifecycle.push(detected.lifecycle);
 const confirmations=telemetryEvidence.filter(e=>e.vehicle_id===detected.detected_vehicle).slice(-2);
 assert.equal(confirmations.length,2);assert.ok(confirmations.every(e=>e.observed_ratio<=.5&&Math.abs(e.observed_ratio-1/3)<1e-6));
 assert.equal(confirmations[1].time_ms-confirmations[0].time_ms,500);
 const detectionMs=sim.elapsed,fleet=sim.snapshot(), detector=fleet.find(v=>v.vehicleId===detected.detected_vehicle);
 const eid=fixture.event.edge_id;
 const distanceToIncident=v=>{
  const ids=sim.routes[v.routeIndex].edge_ids;
  const index=ids.findIndex((id,i)=>id===eid&&i>=v.segment);
  if(index<0)return null;
  let distance=ids.slice(v.segment,index).reduce((n,id)=>n+network.edges[id].distance,0);
  if(index>v.segment&&v.edgeId)distance-=network.edges[v.edgeId].distance*v.edgeFraction;
  return distance;
 };
 const fleetEvidence=fleet.map(v=>({...v,remaining_customers:owners[v.routeIndex].filter(id=>!v.served.includes(id)),
  distance_to_incident_m:distanceToIncident(v),incident_edge_current:v.edgeId===eid,...incidentPathState(sim.routes[v.routeIndex].edge_ids,v,eid)}));
 const users=fleet.filter(v=>sim.routes[v.routeIndex].edge_ids.includes(eid)).map(v=>{
  const route=sim.routes[v.routeIndex];
  // Occurrence indices, not static membership: a repeated past traversal disqualifies.
  const progress=incidentPathState(route.edge_ids,v,eid);
  return {vehicle_id:v.vehicleId,active_at_detection:v.status!=='completed'&&v.progress<1,
   served_count_at_detection:v.served.length,remaining_customers_at_detection:owners[v.routeIndex].filter(id=>!v.served.includes(id)),
   distance_to_incident_m:distanceToIncident(v),incident_edge_current:v.edgeId===eid,
   ...progress,
   remaining_geometry_before:route.edge_ids.slice(v.segment),
   route_contains_incident_before:route.edge_ids.slice(v.segment).includes(eid)};
 });
 const proactive=users.filter(v=>v.vehicle_id!==5&&v.active_at_detection&&v.remaining_customers_at_detection.length>0&&!v.incident_edge_already_traversed&&v.incident_edge_ahead_at_detection);
 const currentEvent=sim.plans[detector.routeIndex].events.find(e=>e.end>sim.clocks[detector.routeIndex]);
 const leg=sim.routes[detector.routeIndex].legs[currentEvent.legIndex];
 const geometryBefore=structuredClone(sim.routes);

 sim.setIncidentState(detected.known_state);
 // Production waits 700ms to show detection. Solver latency is an explicit
 // deterministic validation parameter; no runtime simulation code is changed.
 for(let t=0;t<700;t+=frame)advance(Math.min(frame,700-t));
 const snapshots=sim.beginReoptimization(fixture.scenario);
 const queued=await api('/api/reoptimize',{session_id:session.session_id,revision:detected.known_state.revision,scenario:fixture.scenario,vehicles:snapshots});
 lifecycle.push((await api('/api/traffic/telemetry',{session_id:session.session_id,samples:[]})).lifecycle);
 const result=await finishJob(queued);assert.equal(result.failures.length,0);assert.ok(result.completed_lns_solves>0);
 for(let t=0;t<solveAdvanceMs;t+=frame)advance(Math.min(frame,solveAdvanceMs-t));
 const beforeApply=sim.snapshot(),positions=beforeApply.map(v=>v.position);
 sim.applyReoptimization(result);assert.deepEqual(sim.snapshot().map(v=>v.position),positions);
 assert.deepEqual(sim.snapshot().map(v=>v.served),beforeApply.map(v=>v.served));
 for(const snap of snapshots){
  const route=sim.routes[snap.route_index];
  assert.deepEqual(route.stop_sequence.filter(id=>id>0).sort((a,b)=>a-b),owners[snap.route_index]);
  const update=result.updates.find(u=>u.route_index===snap.route_index);
  if(update){assert.ok(update.order.every(id=>!snap.served.includes(id)));assert.deepEqual([...update.order].sort((a,b)=>a-b),[...snap.remaining].sort((a,b)=>a-b));}
  assert.deepEqual(route.edge_ids.slice(0,snap.prefixLegs.flatMap(l=>l.edge_ids).length),snap.prefixLegs.flatMap(l=>l.edge_ids));
 }
 for(const v of users){
  const i=v.vehicle_id-1, now=sim.snapshot()[i];
  v.remaining_geometry_after=sim.routes[i].edge_ids.slice(now.segment);
  v.route_contains_incident_after=sim.routes[i].edge_ids.slice(now.segment).includes(eid);
  v.route_changed_after_reoptimization=JSON.stringify(geometryBefore[i].edge_ids)!==JSON.stringify(sim.routes[i].edge_ids);
 }
 const edgeDistance=ids=>ids.reduce((n,id)=>n+network.edges[id].distance,0);
 const sharedDistance=(a,b)=>{const counts=new Map();for(const id of b)counts.set(id,(counts.get(id)||0)+1);return a.reduce((n,id)=>{if(!counts.get(id))return n;counts.set(id,counts.get(id)-1);return n+network.edges[id].distance;},0);};
 const detours=[0,3].map(i=>{
  const snap=snapshots[i],update=result.updates.find(u=>u.route_index===i);
  const old=snap.suffix_edge_ids,after=update?.geometry.edge_ids||old;
  const oldDistance=edgeDistance(old),newDistance=edgeDistance(after),shared=sharedDistance(old,after);
  const novel=after.filter(id=>!old.includes(id));
  return {vehicle_id:i+1,update_received:!!update,old_order:snap.remaining,new_order:update?.order||snap.remaining,
   old_future_edge_ids:old,new_future_edge_ids:after,old_contains_incident:old.includes(eid),new_contains_incident:after.includes(eid),
   old_distance_m:oldDistance,new_distance_m:newDistance,shared_old_new_distance_m:shared,
   unique_new_geometry_m:newDistance-shared,changed_geometry_ratio:1-shared/Math.max(oldDistance,newDistance),
   novel_edge_ids:novel,novel_distance_m:edgeDistance(novel),metrics:update?.metrics};
 });
 const sharedNew=sharedDistance(detours[0].new_future_edge_ids,detours[1].new_future_edge_ids);
 const sharedNovel=sharedDistance(detours[0].novel_edge_ids,detours[1].novel_edge_ids);
 const distinct={shared_new_distance_m:sharedNew,vehicle_1_unique_new_distance_m:detours[0].new_distance_m-sharedNew,
  vehicle_4_unique_new_distance_m:detours[1].new_distance_m-sharedNew,
  geometry_similarity_ratio:sharedNew/Math.max(...detours.map(v=>v.new_distance_m)),
  shared_novel_distance_m:sharedNovel,vehicle_1_exclusive_novel_m:detours[0].novel_distance_m-sharedNovel,
  vehicle_4_exclusive_novel_m:detours[1].novel_distance_m-sharedNovel};
 // Spatial evidence: opposite directed edges on the same road do not count as separate corridors.
 const {measureSeparation}=require('./detour_geometry.cjs');
 for(const [i,id] of [1,4].entries()){
  const m=measureSeparation(network,detours[i].novel_edge_ids,detours[1-i].novel_edge_ids);
  distinct[`vehicle_${id}_sampled_detour_separation`]=m.samples;
  distinct[`vehicle_${id}_median_detour_separation_m`]=m.median_m;
  distinct[`vehicle_${id}_maximum_detour_separation_m`]=m.maximum_m;
  distinct[`vehicle_${id}_novel_length_at_least_100m_away`]=m.length_at_100m;
  distinct[`vehicle_${id}_spatially_separated_novel_m`]=m.length_at_75m;
 }
 const thresholds={distance_to_incident_m:300,unique_new_geometry_m:300,changed_geometry_ratio:.15,exclusive_novel_geometry_m:150,spatial_separation_m:75,separated_novel_geometry_m:250};
 distinct.meaningfully_distinct=distinct.vehicle_1_unique_new_distance_m>=300&&distinct.vehicle_4_unique_new_distance_m>=300&&distinct.vehicle_1_exclusive_novel_m>=150&&distinct.vehicle_4_exclusive_novel_m>=150&&distinct.vehicle_1_spatially_separated_novel_m>=250&&distinct.vehicle_4_spatially_separated_novel_m>=250;
 const avoided=proactive.filter(v=>!v.route_contains_incident_after&&v.route_changed_after_reoptimization);

 lifecycle.push((await api('/api/traffic/applied',{session_id:session.session_id,job_id:queued.job_id})).lifecycle);
 while(sim.elapsed<600000&&sim.status!=='completed')advance(frame);
 assert.equal(sim.status,'completed'); const served=sim.snapshot().flatMap(v=>v.served);assert.equal(served.length,24);assert.equal(new Set(served).size,24);assert.deepEqual([...served].sort((a,b)=>a-b),fixture.scenario.stops.filter(s=>s.id>0).map(s=>s.id).sort((a,b)=>a-b));
 assert.deepEqual(lifecycle,['INACTIVE','ACTIVE_UNDETECTED','DETECTED','REOPTIMIZING','ROUTES_UPDATED']);
 const report={fleet_evidence_at_detection:fleetEvidence,detours,distinct_detours:distinct,visual_thresholds:thresholds,injection_ms:fixture.event.inject_at_ms,injection_snapshot:injectionSnapshot,frame_ms:frame,solver_advance_ms:solveAdvanceMs,detection_ms:detectionMs,detected_vehicle:detected.detected_vehicle,
 detected_vehicle_status:detector.status,detected_vehicle_progress:detector.progress,
 detected_vehicle_served_count:detector.served.length,detected_vehicle_remaining_count:owners[detector.routeIndex].length-detector.served.length,
 active_vehicles_at_detection:fleet.filter(v=>v.status!=='completed').map(v=>v.vehicleId),
 fleet_served_at_detection:fleet.reduce((n,v)=>n+v.served.length,0),fleet_unserved_at_detection:24-fleet.reduce((n,v)=>n+v.served.length,0),
 fleet_snapshot_at_detection:fleet,incident_vehicles:users,
 incident_initial_vehicle_ids:users.map(v=>v.vehicle_id),incident_initial_vehicle_count:users.length,
 proactive_candidate_vehicle_ids:proactive.map(v=>v.vehicle_id),proactive_rerouted_vehicle_ids:avoided.map(v=>v.vehicle_id),proactive_rerouted_vehicle_count:avoided.length,
 incident_leg_from_stop:leg.from_stop,incident_leg_to_stop:leg.to_stop,incident_on_return_to_depot:leg.to_stop===0,
 vehicle_completion_ms:completion,customer_counts:initial.routes.map(r=>r.length-2),incident_edge_id:eid,
 lifecycle,completed_lns_solves:result.completed_lns_solves,reoptimization_failures:result.failures,
 telemetry_evidence:telemetryEvidence.filter(e=>e.vehicle_id===5),all_customers_completed:true,
 pre_detection_routes_unchanged:true,pre_detection_known_revision:0,pre_detection_known_overrides:{},pre_detection_dynamic_solves:0,positions_preserved:true,served_customers_preserved:true,ownership_preserved:true,committed_segments_preserved:true,
 initial_routes:initial.routes,initial_geometry_edge_ids:initial.road_geometry.routes.map(r=>r.edge_ids)};
 report.accepted=report.detected_vehicle===5&&report.detected_vehicle_served_count>=1&&report.detected_vehicle_remaining_count>=2&&detector.status!=='completed'&&detector.progress<1&&!report.incident_on_return_to_depot&&users.length>=3&&proactive.length>=2&&avoided.length>=1;
 report.mid_delivery_accepted=report.accepted;
 const failures=[];
 if(!report.mid_delivery_accepted)failures.push('mid_delivery_contract');
 if(leg.from_stop<=0||leg.to_stop<=0)failures.push('incident_not_customer_to_customer');
 for(const id of [1,4]){
  const v=users.find(v=>v.vehicle_id===id),d=detours.find(v=>v.vehicle_id===id);
  if(!proactive.some(v=>v.vehicle_id===id))failures.push(`vehicle_${id}_not_approaching`);
  if(!v||v.distance_to_incident_m<300||v.incident_edge_current)failures.push(`vehicle_${id}_too_close`);
  if(!d.update_received||d.new_contains_incident)failures.push(`vehicle_${id}_did_not_avoid`);
  if(!d.old_contains_incident)failures.push(`vehicle_${id}_old_suffix_missing_incident`);
  if(d.unique_new_geometry_m<300||d.changed_geometry_ratio<.15)failures.push(`vehicle_${id}_weak_visible_change`);
 }
 if(!distinct.meaningfully_distinct)failures.push('detours_not_distinct');
 report.acceptance_failures=failures;report.accepted=failures.length===0;
 report.configuration_seed=fixture.configuration_seed;
 report.incident_from_node=network.edges[eid].from_node;
 report.incident_to_node=network.edges[eid].to_node;
 report.vehicle_5_served_at_detection=detector.served;
 report.vehicle_5_remaining_at_detection=owners[4].filter(id=>!detector.served.includes(id));
 report.affected_vehicle_ids=snapshots.filter(v=>v.affected).map(v=>v.route_index+1);
 for(const id of [1,4]){
  const d=detours.find(v=>v.vehicle_id===id),v=users.find(v=>v.vehicle_id===id);
  report[`vehicle_${id}_distance_to_incident_at_detection`]=v?.distance_to_incident_m??null;
  for(const key of ['old_contains_incident','new_contains_incident','unique_new_geometry_m','changed_geometry_ratio'])report[`vehicle_${id}_${key}`]=d[key];
 }
 report.vehicle_1_vehicle_4_new_shared_distance_m=sharedNew;
 report.vehicle_1_vehicle_4_distinct_detours=distinct.meaningfully_distinct;
 const depot=fixture.scenario.stops.find(s=>s.id===0),incident=network.nodes[network.edges[eid].from_node];
 report.incident_distance_from_depot_m=Math.hypot((incident.lon-depot.lon)*109400,(incident.lat-depot.lat)*111320);
 report.score_components={mid_delivery:report.mid_delivery_accepted?20:-100,
  proactive_avoidance:10*avoided.filter(v=>[1,4].includes(v.vehicle_id)).length,
  approach_separation:users.filter(v=>[1,4].includes(v.vehicle_id)).reduce((n,v)=>n+Math.min(10,(v.distance_to_incident_m||0)/100),0),
  visible_change:detours.reduce((n,v)=>n+10*Math.min(1,v.unique_new_geometry_m/600)+10*Math.min(1,v.changed_geometry_ratio),0),
  distinct_detours:distinct.meaningfully_distinct?20:-20,failed_requirements:-20*failures.length,
  balanced_loads:initial.routes.every(r=>r.length===6)?10:-50,
  detector_delivery_progress:detector.progress>=.35&&detector.progress<=.6?10:-5,
  customer_to_customer:leg.from_stop>0&&leg.to_stop>0?10:-20,
  depot_separation:Math.min(10,report.incident_distance_from_depot_m/100),
  corridor_clutter:-5*Math.max(0,users.length-3),
  completion_and_lifecycle:report.all_customers_completed&&report.positions_preserved?10:-100};
 report.presentation_score=Object.values(report.score_components).reduce((a,b)=>a+b,0);
 return report;
}
module.exports={validateScenario,incidentPathState};
if(require.main===module){validateScenario(JSON.parse(fs.readFileSync(process.argv[2],'utf8'))).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e);process.exitCode=1;});}
