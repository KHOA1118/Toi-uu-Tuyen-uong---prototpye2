const test=require('node:test');
const assert=require('node:assert/strict');
const {validateScenario:primary}=require('../tools/validate_presentation.cjs');
const {validateScenario:fallback}=require('../tools/validate_role_fallback.cjs');

test('role validator preserves the complete primary contract for default roles',
 {skip:!process.env.LNS_TEST_URL,timeout:120000},async()=>{
  const base=process.env.LNS_TEST_URL;
  const response=await fetch(base+'/api/presentation-scenario');
  assert.ok(response.ok);
  const fixture=await response.json();
  const a=await primary(fixture,{base});
  const b=await fallback(fixture,{base});
  assert.deepEqual(b.actual_roles,{detector:5,affected:[1,4]});
  for(const key of ['accepted','acceptance_failures','visual_thresholds','distinct_detours',
   'detection_ms','vehicle_completion_ms','all_customers_completed','positions_preserved',
   'ownership_preserved','served_customers_preserved','initial_routes','lifecycle']){
   assert.deepEqual(b[key],a[key],key);
  }
  const geometry=r=>r.detours.map(({metrics,...evidence})=>evidence);
  assert.deepEqual(geometry(b),geometry(a));
 });
