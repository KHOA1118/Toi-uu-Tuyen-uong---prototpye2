const {test}=require('node:test');
const assert=require('node:assert/strict');
const {measureSeparation}=require('../tools/detour_geometry.cjs');
const network={nodes:{a:{lat:10.75,lon:106.7},b:{lat:10.75,lon:106.705},c:{lat:10.75+120/111320,lon:106.7},d:{lat:10.75+120/111320,lon:106.705}},
 edges:{ab:{from_node:'a',to_node:'b',distance:500},ba:{from_node:'b',to_node:'a',distance:500},cd:{from_node:'c',to_node:'d',distance:500}}};
test('opposite directed edges on the same road do not produce spatial novelty',()=>{
 const m=measureSeparation(network,['ab'],['ba']);
 assert.ok(m.maximum_m<1e-6);assert.equal(m.length_at_75m,0);assert.equal(m.length_at_100m,0);
});
test('separation records weighted median, maximum, samples and both distance thresholds',()=>{
 const m=measureSeparation(network,['ab'],['cd']);
 assert.ok(Math.abs(m.median_m-120)<1e-6);assert.ok(Math.abs(m.maximum_m-120)<1e-6);
 assert.equal(m.samples.length,3);assert.equal(m.length_at_75m,500);assert.equal(m.length_at_100m,500);
});
test('missing other detour cannot count as infinitely separated',()=>{
 const m=measureSeparation(network,['ab'],[]);
 assert.equal(m.median_m,null);assert.equal(m.maximum_m,null);assert.equal(m.length_at_75m,0);
});
