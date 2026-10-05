// Offline validation only: length-weighted samples to the other polyline.
function measureSeparation(network, ids, other) {
 const xy=id=>{const n=network.nodes[id];return [n.lon*111320*Math.cos(10.75*Math.PI/180),n.lat*111320];};
 const segment=id=>{const e=network.edges[id];return [xy(e.from_node),xy(e.to_node)];};
 const distance=(p,a,b)=>{const dx=b[0]-a[0],dy=b[1]-a[1],t=Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/(dx*dx+dy*dy||1)));return Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy);};
 const targets=other.map(segment);
 const samples=targets.length?ids.flatMap(id=>{const [a,b]=segment(id);return [.25,.5,.75].map(t=>{const p=[a[0]+t*(b[0]-a[0]),a[1]+t*(b[1]-a[1])];return {distance_m:Math.min(...targets.map(([x,y])=>distance(p,x,y))),weight_m:network.edges[id].distance/3};});}):[];
 const sorted=[...samples].sort((a,b)=>a.distance_m-b.distance_m),half=sorted.reduce((n,s)=>n+s.weight_m,0)/2;
 let total=0,median=null;for(const s of sorted){total+=s.weight_m;if(total>=half){median=s.distance_m;break;}}
 return {samples,median_m:median,maximum_m:sorted.length?sorted.at(-1).distance_m:null,
  length_at_75m:samples.filter(s=>s.distance_m>=75).reduce((n,s)=>n+s.weight_m,0),
  length_at_100m:samples.filter(s=>s.distance_m>=100).reduce((n,s)=>n+s.weight_m,0)};
}
module.exports={measureSeparation};
