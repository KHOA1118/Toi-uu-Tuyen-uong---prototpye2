// Detection-only real API/Simulation check. Does not run dynamic optimization.
const fs=require('node:fs');
const assert=require('node:assert/strict');
const {Simulation}=require('../frontend/simulation.js');
const {Presentation}=require('../frontend/presentation.js');
async function check(fixture,base='http://127.0.0.1:8016'){
 const api=async(path,body)=>{const r=await fetch(base+path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});const d=await r.json();assert.ok(r.ok,JSON.stringify(d));return d;};
 const network=await api('/api/network'),job=await api('/api/jobs/initial',{scenario:fixture.scenario});
 let initial;
 for(let i=0;i<300;i++){const j=await api('/api/jobs/'+job.job_id);if(j.status==='completed'){initial=j.result;break;}assert.notEqual(j.status,'failed',j.error);await new Promise(r=>setTimeout(r,100));}
 assert.ok(initial);const sim=new Simulation(initial.road_geometry.routes,network,{durationMs:fixture.duration_ms,stops:fixture.scenario.stops});
 const session=await api('/api/simulation',{source_sha256:fixture.source_sha256});sim.setIncidentState(session);
 const run=new Presentation(fixture);run.phase='moving';sim.start();
 while(sim.elapsed<fixture.event.inject_at_ms)sim.advance(run.budget(sim.elapsed,50));
 const injected=await api('/api/traffic/inject',{session_id:session.session_id,edge_id:fixture.event.edge_id,expected_speed:sim.metersPerMs});sim.setPhysicalState(injected.physical_overrides);run.lifecycle='ACTIVE_UNDETECTED';
 const samples=[];
 for(let i=0;i<100;i++){
  while(sim.elapsed<run.nextSample)sim.advance(run.budget(sim.elapsed,50));
  const fleet=sim.snapshot(),reply=await api('/api/traffic/telemetry',{session_id:session.session_id,samples:run.samples(sim)});
  samples.push({time_ms:sim.elapsed,vehicles:fleet.filter(v=>v.edgeId===fixture.event.edge_id),evidence:reply.evidence});
  if(reply.lifecycle==='DETECTED')return {passed:true,incident:fixture.event.edge_id,detector:reply.detected_vehicle,detection_ms:sim.elapsed,detector_snapshot:fleet.find(v=>v.vehicleId===reply.detected_vehicle),initial_orders:initial.routes,samples};
  run.nextSample+=fixture.event.sample_interval_ms;
 }
 return {passed:false,samples};
}
if(require.main===module){const fixture=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));if(process.argv[3])fixture.event.edge_id=fixture.event.incident_edge_id=process.argv[3];check(fixture).then(x=>console.log(JSON.stringify(x,null,2))).catch(e=>{console.error(e);process.exitCode=1;});}
module.exports={check};
