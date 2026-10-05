// Reuse the unchanged strict two-detour contract for every pair of three roles.
// Each run executes real Simulation, telemetry, initial LNS and dynamic APIs.
const fs=require('node:fs');
const assert=require('node:assert/strict');
const {validateScenario}=require('./validate_role_fallback.cjs');
async function validateThree(fixture,options={}){
 const ids=fixture.roles?.affected;
 assert.equal(ids?.length,3);
 assert.equal(new Set([fixture.roles.detector,...ids]).size,4);
 const runs=[];
 for(const pair of [[ids[0],ids[1]],[ids[0],ids[2]],[ids[1],ids[2]]]){
  const run=await validateScenario({...fixture,roles:{...fixture.roles,affected:pair}},options);
  runs.push(run);
 }
 const reference=runs[0];
 for(const run of runs.slice(1)){
  assert.deepEqual(run.initial_routes,reference.initial_routes);
  assert.equal(run.detection_ms,reference.detection_ms);
  assert.deepEqual(run.vehicle_completion_ms,reference.vehicle_completion_ms);
  assert.deepEqual(run.incident_vehicles,reference.incident_vehicles);
 }
 const detours=ids.map(id=>runs.flatMap(r=>r.detours).find(d=>d.vehicle_id===id));
 const failures=[...new Set(runs.flatMap(r=>r.acceptance_failures||[r.reason].filter(Boolean)))];
 return {accepted:runs.every(r=>r.accepted),roles:fixture.roles,configuration_seed:fixture.configuration_seed,
  acceptance_failures:failures,detours,pairwise_runs:runs,deterministic:true};
}
module.exports={validateThree};
if(require.main===module)validateThree(JSON.parse(fs.readFileSync(process.argv[2],'utf8'))).then(r=>{
 const text=JSON.stringify(r,null,2)+'\n';
 if(process.argv[3])fs.writeFileSync(process.argv[3],text);else console.log(text);
 console.error(JSON.stringify({accepted:r.accepted,failures:r.acceptance_failures}));
}).catch(e=>{console.error(e);process.exitCode=1;});
