const {test}=require('node:test');
const assert=require('node:assert/strict');
const {future,capture,changes,differences,placeLabels}=require('../frontend/presentation.js');
const route={edge_ids:['history','committed','old','return'],coordinates:[[0,0],[1,0],[2,0],[3,0],[0,0]]};
const vehicle={routeIndex:0,status:'moving',segment:1,position:{lon:1.5,lat:0}};
test('snapshot begins at physical position, excludes traveled history, owns its copies',()=>{
  const before=JSON.stringify(route),snap=capture([route],[vehicle]);
  assert.deepEqual(snap[0].edges,['committed','old','return']);
  assert.deepEqual(snap[0].coordinates,[[1.5,0],[2,0],[3,0],[0,0]]);
  snap[0].coordinates[1][0]=99;snap[0].position.lon=99;
  assert.equal(JSON.stringify(route),before);assert.equal(vehicle.position.lon,1.5);
  assert.deepEqual(future(route,{...vehicle,status:'completed'}),{edges:[],coordinates:[]});
});
test('only changed future edges animate; committed prefix and unchanged return stay normal',()=>{
  const next={edge_ids:['history','committed','detour-a','detour-b','return'],coordinates:[[0,0],[1,0],[2,0],[2,1],[3,0],[0,0]]};
  const before=capture([route],[vehicle]),result=changes(before,[next],[vehicle],[{route_index:0}]);
  assert.deepEqual(result[0].removed,[[[2,0],[3,0]]]);
  assert.deepEqual(result[0].added,[[[2,0],[2,1],[3,0]]]);
  assert.deepEqual(result[0].position,vehicle.position);
  assert.deepEqual(changes(before,[next],[vehicle],[]),[]);
  assert.deepEqual(changes(before,[route],[vehicle],[{route_index:0}]),[]);
});
test('revisited directed edges are compared as occurrences, not membership sets',()=>{
  const a={edges:['a','b','a','c'],coordinates:[[0,0],[1,0],[0,0],[1,0],[2,0]]};
  const b={edges:['a','c'],coordinates:[[0,0],[1,0],[2,0]]};
  assert.equal(differences(a,b).removed.flat().length,3);
  assert.deepEqual(differences(a,b).added,[]);
});
test('cluster labels stay inside view, separate each other and leave geographic inputs untouched',()=>{
  const nodes=Array.from({length:8},(_,i)=>({id:i,x:110+(i%2)*4,y:110+Math.floor(i/2)*4,text:String(i)}));
  const original=JSON.stringify(nodes),labels=placeLabels(nodes,[[[0,110],[300,110]]],300,250);
  assert.equal(JSON.stringify(nodes),original);
  assert.deepEqual(labels,placeLabels(nodes,[[[0,110],[300,110]]],300,250));
  for(let i=0;i<labels.length;i++){
    const a=labels[i].box;assert.ok(a.x>=5&&a.y>=5&&a.x+a.w<=295&&a.y+a.h<=245);
    for(let j=0;j<i;j++){const b=labels[j].box;assert.ok(!(a.x<b.x+b.w&&a.x+a.w>b.x&&a.y<b.y+b.h&&a.y+a.h>b.y));}
  }
});
test('single label avoids a route crossing its default location',()=>{
  const label=placeLabels([{id:1,x:100,y:100,text:'1'}],[[[105,88],[135,88]]],300,200)[0];
  assert.ok(label.box.y>88||label.box.y+label.box.h<88||label.box.x+label.box.w<105||label.box.x>135);
});
const {declutterNodes}=require('../frontend/presentation.js');
test('node decluttering is bounded, deterministic, preserves isolated nodes and depot, and never mutates inputs',()=>{
  const nodes=[{id:0,x:20,y:20},{id:99,x:280,y:200},...Array.from({length:12},(_,i)=>({id:i+1,x:110+i%3*3,y:100+Math.floor(i/3)*3}))];
  const original=JSON.stringify(nodes),result=declutterNodes(nodes);
  assert.equal(JSON.stringify(nodes),original);
  assert.deepEqual(result,declutterNodes(nodes));
  for(const p of result){assert.ok(Math.hypot(p.dx,p.dy)<=72+1e-9);for(const q of result)if(p.id!==q.id)assert.ok(Math.hypot(p.x-q.x,p.y-q.y)>=34-1e-9);}
  assert.equal(result[0].dx,0);assert.equal(result[1].dx,0);
});
