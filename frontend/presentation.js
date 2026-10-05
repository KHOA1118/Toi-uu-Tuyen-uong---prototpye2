(function(root){
  class Presentation {
    constructor(fixture){this.fixture=fixture;this.phase='loading';this.active=true;this.lifecycle='INACTIVE';this.nextSample=fixture.event.inject_at_ms+fixture.event.sample_interval_ms;this.sampleQueue=[];this.sending=false;}
    budget(elapsed,ms){
      if(['loading','preview'].includes(this.phase))return 0;
      const limit=this.lifecycle==='INACTIVE'?this.fixture.event.inject_at_ms:this.lifecycle==='ACTIVE_UNDETECTED'?this.nextSample:Infinity;
      return Math.max(0,Math.min(ms,limit-elapsed));
    }
    samples(sim){return sim.snapshot().map(v=>({vehicle_id:v.vehicleId,edge_id:v.edgeId,fraction:v.edgeFraction??0,time_ms:sim.elapsed}));}
    summary(d){const a=d.before?.travel,b=d.after?.travel;if(a==null||b==null)return 'Không thể so sánh thời gian khi tuyến bị chặn';const gain=a-b;return `${d.rerouted} xe đổi tuyến - ${gain>0?'Giảm':gain<0?'Tăng':'Không đổi'} ${Math.abs(gain).toFixed(1)} giây thời gian chạy dự kiến`;}
  }
  // Presentation-only copies. Never write into Simulation routes, plans or clocks.
  function future(route, vehicle) {
    if(vehicle.status==='completed')return {edges:[],coordinates:[]};
    return {edges:route.edge_ids.slice(vehicle.segment),coordinates:[[vehicle.position.lon,vehicle.position.lat],...route.coordinates.slice(vehicle.segment+1).map(p=>[...p])]};
  }
  function capture(routes, vehicles) {
    return vehicles.map(v=>({index:v.routeIndex,position:{...v.position},...future(routes[v.routeIndex],v)}));
  }
  // LCS matches edge occurrences, rather than sets (a route can revisit an edge).
  function differences(a,b) {
    const rows=Array.from({length:a.edges.length+1},()=>new Uint32Array(b.edges.length+1));
    for(let i=a.edges.length-1;i>=0;i--)for(let j=b.edges.length-1;j>=0;j--)
      rows[i][j]=a.edges[i]===b.edges[j]?1+rows[i+1][j+1]:Math.max(rows[i+1][j],rows[i][j+1]);
    const sameA=new Set(),sameB=new Set();let i=0,j=0;
    while(i<a.edges.length&&j<b.edges.length){if(a.edges[i]===b.edges[j]){sameA.add(i++);sameB.add(j++);}else if(rows[i+1][j]>=rows[i][j+1])i++;else j++;}
    function sections(path,same){const parts=[];let part=null;path.edges.forEach((edge,k)=>{if(same.has(k)){part=null;return;}if(!part){part=[path.coordinates[k]];parts.push(part);}part.push(path.coordinates[k+1]);});return parts;}
    return {removed:sections(a,sameA),added:sections(b,sameB),unchanged:sections(b,new Set(b.edges.map((_,i)=>i).filter(i=>!sameB.has(i))))};
  }
  function changes(before,routes,vehicles,updates) {
    const allowed=new Set(updates.map(u=>u.route_index));
    return before.filter(v=>allowed.has(v.index)).flatMap(old=>{
      const v=vehicles.find(v=>v.routeIndex===old.index),next=future(routes[old.index],v),diff=differences(old,next);
      return diff.removed.length||diff.added.length?[{...old,...diff,next}]:[];
    });
  }
  // Pure screen-space placement; output is never passed to routing or Simulation.
  function declutterNodes(nodes, obstacles=[], spacing=34, maxDisplacement=72) {
    const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
    const fixed=nodes.filter(n=>n.id===0||!nodes.some(m=>m.id!==n.id&&distance(n,m)<spacing));
    const placed=fixed.map(n=>({...n}));
    const moving=nodes.filter(n=>!fixed.includes(n)).sort((a,b)=>a.id-b.id);
    for(const n of moving){
      let best=null;
      for(let radius=0;radius<=maxDisplacement;radius+=2){
        const count=radius?Math.max(16,Math.ceil(2*Math.PI*radius/3)):1;
        for(let k=0;k<count;k++){
          const angle=k*2*Math.PI/count,point={...n,x:n.x+radius*Math.cos(angle),y:n.y+radius*Math.sin(angle)};
          const overlap=placed.reduce((sum,p)=>sum+Math.max(0,spacing-distance(point,p))**2,0);
          const blocked=obstacles.reduce((sum,b)=>sum+(point.x>b.x-10&&point.x<b.x+b.w+10&&point.y>b.y-10&&point.y<b.y+b.h+10?1:0),0);
          const score=overlap*10000+blocked*100000+radius;
          if(!best||score<best.score)best={...point,score};
        }
        if(best.score<=radius)break;
      }
      placed.push(best);
    }
    return nodes.map(n=>{const p=placed.find(p=>p.id===n.id);return {...n,x:p.x,y:p.y,dx:p.x-n.x,dy:p.y-n.y};});
  }
  // Screen-space label placement: prefer short offsets, penalize road crossings,
  // marker/label collisions and clipping. Geographic coordinates stay untouched.
  function placeLabels(nodes,segments,width,height) {
    const placed=[],out=[];
    const overlaps=(a,b)=>a.x<b.x+b.w&&a.x+a.w>b.x&&a.y<b.y+b.h&&a.y+a.h>b.y;
    for(const n of nodes){let best=null;
      for(const radius of [17,28,40,54,70])for(let k=0;k<12;k++){
        const angle=k*Math.PI/6-Math.PI/4,w=n.text.length*7+6,h=16;
        const box={x:n.x+Math.cos(angle)*radius-w/2,y:n.y+Math.sin(angle)*radius-h/2,w,h};
        let score=radius*.1;
        if(box.x<5||box.y<5||box.x+w>width-5||box.y+h>height-5)score+=10000;
        score+=placed.filter(p=>overlaps(box,{x:p.x-2,y:p.y-2,w:p.w+4,h:p.h+4})).length*2000;
        score+=nodes.filter(p=>overlaps(box,{x:p.x-8,y:p.y-8,w:16,h:16})).length*1500;
        for(const [a,b] of segments){
          // Liang–Barsky segment / padded label rectangle intersection.
          let lo=0,hi=1;const dx=b[0]-a[0],dy=b[1]-a[1];
          for(const [p,q] of [[-dx,a[0]-box.x],[dx,box.x+w-a[0]],[-dy,a[1]-box.y],[dy,box.y+h-a[1]]]){
            if(p===0){if(q<0){hi=-1;break;}}else if(p<0)lo=Math.max(lo,q/p);else hi=Math.min(hi,q/p);
          }if(lo<=hi)score+=25;
        }
        if(!best||score<best.score)best={...box,score};
      }
      placed.push(best);out.push({id:n.id,dx:best.x+3-n.x,dy:best.y+12-n.y,box:best});
    }return out;
  }
  const exports={Presentation,future,capture,differences,changes,placeLabels,declutterNodes};
  if(typeof module!=='undefined')module.exports=exports;else root.DemoPresentation=exports;
})(globalThis);
