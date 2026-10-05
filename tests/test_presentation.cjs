const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Presentation}=require('../frontend/presentation.js');
const {Simulation}=require('../frontend/simulation.js');
const {Dashboard}=require('../frontend/dashboard.js');
const base=process.env.LNS_TEST_URL||'http://127.0.0.1:8011';
async function api(path,body){const r=await fetch(base+path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});const d=await r.json();assert.ok(r.ok,JSON.stringify(d));return d;}
async function completed(job,advance){for(let n=0;n<300;n++){const j=await api('/api/jobs/'+job.job_id);if(j.status==='completed')return j.result;if(j.status==='failed')throw Error(j.error);if(advance)advance();await new Promise(r=>setTimeout(r,100));}throw Error('Job timeout');}
test('three real road-cost LNS demos: hidden physics, two telemetry intervals, async solve, preserved progress, depot return',async()=>{
 const fixture=await api('/api/presentation-scenario'),network=await api('/api/network'),runs=[];
 for(const frame of [17,50,100]){
  const initial=await completed(await api('/api/jobs/initial',{scenario:fixture.scenario}));
  assert.equal(initial.feasible,true);assert.equal(initial.routes.length,6);assert.equal(initial.cost_unit,'seconds');assert.ok(initial.overlap_analysis.accepted);
  const geometry=initial.road_geometry, scenario=fixture.scenario;
  assert.equal(scenario.vehicle_count,6);assert.equal(scenario.vehicle_capacity,40);
  assert.equal(scenario.stops.length,25);assert.ok(scenario.stops.every(s=>s.demand===(s.id?10:0)));
  assert.ok(initial.routes.every(r=>r.length===6));
  assert.equal(new Set(initial.routes.flatMap(r=>r.filter(id=>id>0))).size,24);
  assert.ok(geometry.routes[4].edge_ids.includes(fixture.event.edge_id));
  const sim=new Simulation(geometry.routes,network,{durationMs:fixture.duration_ms,stops:scenario.stops});
  const session=await api('/api/simulation',{source_sha256:fixture.source_sha256});sim.setIncidentState(session);
  const dashboard=new Dashboard();dashboard.initial({...geometry,initial_routes:geometry.routes},initial,network,session);
  const run=new Presentation(fixture);run.phase='moving';sim.start();
  const completionTimes={};
  const advance=ms=>{sim.advance(ms);for(const v of sim.snapshot())if(v.status==='completed'&&completionTimes[v.vehicleId]===undefined)completionTimes[v.vehicleId]=sim.elapsed;};
  while(sim.elapsed<fixture.event.inject_at_ms)advance(run.budget(sim.elapsed,frame));
  const original=JSON.stringify(sim.routes);
  const injected=await api('/api/traffic/inject',{session_id:session.session_id,edge_id:fixture.event.edge_id,expected_speed:sim.metersPerMs});
  run.lifecycle=injected.lifecycle;sim.setPhysicalState(injected.physical_overrides);
  assert.equal((await api('/api/simulation?session_id='+session.session_id)).revision,0);
  const premature=await fetch(base+'/api/reoptimize',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({session_id:session.session_id,revision:0})});assert.equal(premature.status,422);
  assert.match((await premature.json()).error,/not been detected/);
  let detected,evidence=[];
  for(let n=0;n<500;n++){
   while(sim.elapsed<run.nextSample)advance(run.budget(sim.elapsed,frame));
   const measured=await api('/api/traffic/telemetry',{session_id:session.session_id,samples:run.samples(sim)});run.nextSample+=500;
   evidence.push(...measured.evidence);
   assert.equal(JSON.stringify(sim.routes),original);
   if(measured.lifecycle==='DETECTED'){detected=measured;break;}
   assert.equal(measured.known_state.revision,0);assert.deepEqual(measured.known_state.edge_overrides,{});
  }
  assert.ok(detected,'vehicle reaches hidden incident');
  assert.equal(detected.detected_vehicle,5);
  const detector=sim.snapshot().find(v=>v.vehicleId===5);
  assert.notEqual(detector.status,'completed');assert.ok(detector.progress<1);
  assert.ok(detector.served.length>=1);assert.ok(4-detector.served.length>=2);
  const detectionMs=sim.elapsed;
  assert.ok(evidence.filter(e=>e.observed_ratio<=.5).length>=2);
  assert.ok(Math.abs(evidence.at(-1).observed_ratio-1/3)<1e-6);
  sim.setIncidentState(detected.known_state);dashboard.incident(sim);
  advance(700); // existing UI detection presentation delay
  const snapshots=sim.beginReoptimization(scenario);dashboard.begin(sim,snapshots,network,detected.known_state);
  assert.ok(snapshots.some(s=>s.served.length));
  const queued=await api('/api/reoptimize',{session_id:session.session_id,revision:detected.known_state.revision,scenario,vehicles:snapshots});
  assert.ok(queued.job_id);assert.equal((await api('/api/traffic/telemetry',{session_id:session.session_id,samples:[]})).lifecycle,'REOPTIMIZING');
  const result=await completed(queued,()=>advance(100));
  assert.equal(result.failures.length,0);assert.ok(result.completed_lns_solves>0);
  const positions=sim.snapshot().map(v=>v.position);sim.applyReoptimization(result);dashboard.applied(result,sim.elapsed);
  assert.deepEqual(sim.snapshot().map(v=>v.position),positions);
  assert.equal((await api('/api/traffic/applied',{session_id:session.session_id,job_id:queued.job_id})).lifecycle,'ROUTES_UPDATED');
  assert.ok(dashboard.rerouted>0);assert.ok(dashboard.before.travel>dashboard.after.travel);
  for(let t=0;t<600000&&sim.status!=='completed';t+=100)advance(100);
  assert.equal(sim.status,'completed');assert.deepEqual(dashboard.live(sim,24),{active:0,remaining:0});
  const report={frame,detectionMs,detectedVehicle:detected.detected_vehicle,completionTimes,affected:dashboard.affected,rerouted:dashboard.rerouted,initialSeconds:initial.initial_pipeline_seconds,geometrySeconds:initial.geometry_seconds,reoptSeconds:result.elapsed_seconds,workerPid:result.worker_pid,summary:run.summary(dashboard)};runs.push(report);console.log(JSON.stringify(report));
 }
 assert.equal(runs.length,3);
});
test('presentation summary never invents savings',()=>{const p=new Presentation({event:{inject_at_ms:5000,sample_interval_ms:500}});assert.equal(p.budget(0,100),0);assert.match(p.summary({before:{travel:10},after:{travel:20},rerouted:1}),/Tăng/);assert.match(p.summary({before:{travel:null},after:{travel:20}}),/Không thể/);assert.match(p.summary({before:{travel:20},after:{travel:20},rerouted:0}),/Không đổi/);});

test('scenario timing evidence uses real Simulation across frame sizes and solver delays',async()=>{
 const {validateScenario}=require('../tools/validate_presentation.cjs');
 const fixture=await api('/api/presentation-scenario');
 const evidence=require('../data/scenario_validation.json');
 for(const [frame,solveAdvanceMs] of [[17,0],[50,500],[100,2500]]){
  const report=await validateScenario(fixture,{base,frame,solveAdvanceMs});
  assert.equal(report.mid_delivery_accepted,true,JSON.stringify(report));
  assert.equal(report.detected_vehicle,5);
  assert.ok(report.detected_vehicle_served_count>=1);
  assert.ok(report.detected_vehicle_remaining_count>=2);
  assert.equal(report.incident_on_return_to_depot,false);
  assert.ok(report.incident_leg_from_stop>0&&report.incident_leg_to_stop>0);
  assert.ok(report.incident_initial_vehicle_count>=3);
  assert.ok(report.proactive_candidate_vehicle_ids.length>=2);
  assert.ok(report.proactive_rerouted_vehicle_count>=1);
  assert.equal(report.injection_snapshot[4].edgeId,fixture.event.edge_id);
  assert.ok(report.detection_ms>report.injection_ms+500);
  for(const id of report.proactive_rerouted_vehicle_ids){
   const v=report.incident_vehicles.find(v=>v.vehicle_id===id);
   assert.notEqual(id,5);assert.equal(v.incident_edge_already_traversed,false);
   assert.equal(v.incident_edge_ahead_at_detection,true);
   assert.ok(v.remaining_customers_at_detection.length>0);
   assert.equal(v.route_contains_incident_before,true);assert.equal(v.route_contains_incident_after,false);
   assert.equal(v.route_changed_after_reoptimization,true);
  }
  assert.deepEqual(report.initial_routes,evidence.initial_routes);
  assert.deepEqual(report.proactive_rerouted_vehicle_ids,evidence.proactive_rerouted_vehicle_ids);
  assert.deepEqual(report.proactive_candidate_vehicle_ids,evidence.proactive_candidate_vehicle_ids);
  assert.equal(report.all_customers_completed,true);
  assert.equal(report.positions_preserved,true);assert.equal(report.committed_segments_preserved,true);
  assert.equal(report.served_customers_preserved,true);assert.equal(report.ownership_preserved,true);
  assert.deepEqual(report.reoptimization_failures,[]);
  if(frame===50){
   assert.equal(report.detection_ms,evidence.detection_ms);
   assert.deepEqual(report.vehicle_completion_ms,evidence.vehicle_completion_ms);
   assert.equal(report.detected_vehicle,evidence.detected_vehicle);
  }
 }
});


test('future incident evidence excludes past traversals but includes the next edge during service',()=>{
 const {incidentPathState}=require('../tools/validate_presentation.cjs');
 assert.deepEqual(incidentPathState(['hot','other','hot'],{segment:1,edgeId:'other',edgeFraction:.2},'hot'),{incident_edge_already_traversed:true,incident_edge_ahead_at_detection:true});
 assert.deepEqual(incidentPathState(['other','hot'],{segment:1,edgeId:null,edgeFraction:.5},'hot'),{incident_edge_already_traversed:false,incident_edge_ahead_at_detection:true});
 assert.deepEqual(incidentPathState(['other','hot'],{segment:1,edgeId:'hot',edgeFraction:.2},'hot'),{incident_edge_already_traversed:true,incident_edge_ahead_at_detection:false});
});


test('current presentation has two distant proactive vehicles and spatially distinct detours',async()=>{
 const {validateScenario}=require('../tools/validate_presentation.cjs');
 const report=await validateScenario(await api('/api/presentation-scenario'),{base});
 assert.equal(report.accepted,true,JSON.stringify({seed:report.configuration_seed,failures:report.acceptance_failures,detours:report.detours.map(v=>({id:v.vehicle_id,unique:v.unique_new_geometry_m,ratio:v.changed_geometry_ratio})),distinct:report.distinct_detours}));
 for(const id of [1,4]){
  const v=report.fleet_evidence_at_detection.find(v=>v.vehicleId===id),d=report.detours.find(v=>v.vehicle_id===id);
  assert.ok(v.distance_to_incident_m>=300);assert.equal(v.incident_edge_current,false);
  assert.equal(v.incident_edge_already_traversed,false);assert.equal(v.incident_edge_ahead_at_detection,true);
  assert.notEqual(v.status,'completed');assert.ok(v.remaining_customers.length>0);
  assert.equal(d.update_received,true);assert.equal(d.old_contains_incident,true);assert.equal(d.new_contains_incident,false);
  assert.ok(d.unique_new_geometry_m>=300);assert.ok(d.changed_geometry_ratio>=.15);
 }
 assert.equal(report.distinct_detours.meaningfully_distinct,true);
 assert.ok(report.distinct_detours.vehicle_1_spatially_separated_novel_m>=250);
 assert.ok(report.distinct_detours.vehicle_4_spatially_separated_novel_m>=250);
});
