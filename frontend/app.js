const $ = id => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';
const state = {geometry: null, network: null, scenario: null, nodes: [], result: null, mode: 'after', selected: null, route: null, zoom: 1, tx: 0, ty: 0};
let simulation = null, simulationFrame = null, simulationTimestamp = null;
let incidentState = null, incidentPending = false;
let reoptimizationPending = false;
let demo = null;
let demoSetupPending = false;
let optimizationLoading = false;
const story={phase:'READY',detector:null,edge:null,focus:new Set(),changes:[],detectedAt:0,appliedAt:0};
let storyTimer=null,revealTimer=null,cameraFrame=null,labelFrame=null;
function storyPhase(phase,count=0){
  story.phase=phase;
  const phases=['ACTIVE','DETECTED','REOPTIMIZING','ROUTES_UPDATED'],at=phases.indexOf(phase);
  $('map-timeline').dataset.phase=phase;
  [...$('map-timeline').children].forEach((el,i)=>{el.classList.toggle('current',i===at);el.classList.toggle('done',i<at);el.setAttribute('aria-current',i===at?'step':'false');});
  $('story-updated').textContent=phase==='ROUTES_UPDATED'?`${count} tuyến đã cập nhật`:'Đã cập nhật tuyến';
}
function resetStory(){
  clearTimeout(storyTimer);clearTimeout(revealTimer);cancelAnimationFrame(cameraFrame);cameraFrame=null;
  Object.assign(story,{detector:null,edge:null,focus:new Set(),changes:[],detectedAt:0,appliedAt:0});
  for(const id of ['ghost-layer','new-route-layer','callout-layer'])$(id).replaceChildren();
  for(const id of ['ghost-layer','new-route-layer','callout-layer'])$(id).classList.remove('story-fade');
  $('route-comparison-key').hidden=true;storyPhase('READY');renderStoryFocus();
}
function screenPoint(p){const [x,y]=MapData.displayProjection(state.network)(p);return [x*state.zoom+state.tx,y*state.zoom+state.ty];}
let nodeDisplayCache={key:null,nodes:[]};
function layoutLabels(){
  if(!state.network)return;
  const originalNodes=state.nodes.map(n=>{const [x,y]=screenPoint(n);return {id:n.id,x,y,text:n.id===0?'DEPOT':String(n.id)};});
  const map=$('network-map'),rect=map.getBoundingClientRect();
  const key=JSON.stringify([originalNodes,state.zoom,map.clientWidth,map.clientHeight]);
  if(nodeDisplayCache.key!==key){
    const obstacles=[...document.querySelectorAll('.map-tools button,[data-vehicle-id]')].map(el=>{
      const r=el.getBoundingClientRect();return {x:r.x-rect.x,y:r.y-rect.y,w:r.width,h:r.height};
    });
    nodeDisplayCache={key,nodes:DemoPresentation.declutterNodes(originalNodes,obstacles)};
  }
  const nodes=nodeDisplayCache.nodes;
  nodes.forEach((n,i)=>{
    const group=$('customer-layer').querySelector(`[data-node-id="${n.id}"]`);
    if(!group)return;
    const original=originalNodes[i],x=(n.x-state.tx)/state.zoom,y=(n.y-state.ty)/state.zoom;
    group.style.transform=`translate(${x}px,${y}px)`;
    group.dataset.displayDx=n.dx;group.dataset.displayDy=n.dy;
    let leader=$('customer-layer').querySelector(`[data-node-leader="${n.id}"]`);
    if(!leader){leader=svgElement('line',{'data-node-leader':n.id,class:'node-leader','vector-effect':'non-scaling-stroke'});$('customer-layer').prepend(leader);}
    for(const [name,value] of Object.entries({x1:(original.x-state.tx)/state.zoom,y1:(original.y-state.ty)/state.zoom,x2:x,y2:y}))leader.setAttribute(name,value);
    leader.style.display=Math.hypot(n.dx,n.dy)>6?'':'none';
  });
  const segments=[];
  for(const r of state.geometry?.[state.mode==='before'?'initial_routes':'routes']||[]){const p=r.coordinates.map(([lon,lat])=>screenPoint({lon,lat}));for(let i=1;i<p.length;i++)segments.push([p[i-1],p[i]]);}
  for(const p of DemoPresentation.placeLabels(nodes,segments,$('network-map').clientWidth,$('network-map').clientHeight)){
    const el=$('customer-layer').querySelector(`[data-node-id="${p.id}"] .node-label`);
    // SVG text x/y attributes work consistently; CSS geometry properties do not
    // position <text> in all browsers. Only label offsets are changed here.
    if(el){el.setAttribute('x',p.dx/state.zoom);el.setAttribute('y',p.dy/state.zoom);}
  }
  layoutStoryCallouts();
}
function layoutStoryCallouts(){
  const map=$('network-map'),placed=[],w=map.clientWidth,h=map.clientHeight;
  const overlap=(a,b)=>a.x<b.x+b.w&&a.x+a.w>b.x&&a.y<b.y+b.h&&a.y+a.h>b.y;
  for(const g of $('callout-layer').querySelectorAll('.story-callout')){
    const [x,y]=screenPoint({lon:Number(g.dataset.lon),lat:Number(g.dataset.lat)}),bw=Number(g.dataset.width),bh=Number(g.dataset.height);
    const options=[[14,-bh-12],[-bw-14,-bh-12],[14,16],[-bw-14,16],[-bw/2,-bh-45],[-bw/2,45],[35,-bh/2],[-bw-35,-bh/2]];
    let best;
    for(let i=0;i<options.length;i++){
      const [dx,dy]=options[i],box={x:Math.max(8,Math.min(w-bw-8,x+dx)),y:Math.max(8,Math.min(h-bh-8,y+dy)),w:bw,h:bh};
      const score=placed.filter(b=>overlap(box,b)).length*10000+Math.hypot(box.x-x-dx,box.y-y-dy)+i;
      if(!best||score<best.score)best={...box,score};
    }
    placed.push(best);const dx=best.x-x,dy=best.y-y;
    const rect=g.querySelector('rect');rect.setAttribute('x',dx);rect.setAttribute('y',dy);
    [...g.querySelectorAll('text')].forEach((text,i)=>{text.setAttribute('x',dx+10);text.setAttribute('y',dy+18+i*18);});
    const line=g.querySelector('line');line.setAttribute('x2',Math.max(dx,Math.min(dx+bw,0)));line.setAttribute('y2',Math.max(dy,Math.min(dy+bh,0)));
  }
}
function storyCamera(coordinates,maxZoom=6){
  if(!coordinates.length)return;cancelAnimationFrame(cameraFrame);cameraFrame=null;
  const project=MapData.displayProjection(state.network),p=coordinates.map(([lon,lat])=>project({lon,lat}));
  const xs=p.map(p=>p[0]),ys=p.map(p=>p[1]),w=$('network-map').clientWidth,h=$('network-map').clientHeight;
  const zoom=Math.min(maxZoom,(w-140)/Math.max(80,Math.max(...xs)-Math.min(...xs)),(h-130)/Math.max(80,Math.max(...ys)-Math.min(...ys)));
  const target={zoom,tx:w/2-zoom*(Math.min(...xs)+Math.max(...xs))/2,ty:h/2-zoom*(Math.min(...ys)+Math.max(...ys))/2};
  const from={zoom:state.zoom,tx:state.tx,ty:state.ty},start=performance.now(),duration=matchMedia('(prefers-reduced-motion: reduce)').matches?0:650;
  function frame(now){const t=duration?Math.min(1,(now-start)/duration):1,e=1-(1-t)**3;for(const k of ['zoom','tx','ty'])state[k]=from[k]+(target[k]-from[k])*e;transformView();if(t<1)cameraFrame=requestAnimationFrame(frame);else {cameraFrame=null;layoutLabels();}}
  cameraFrame=requestAnimationFrame(frame);
}
function storyPolyline(layer,coords,attrs){
  const project=MapData.displayProjection(state.network);
  const el=svgElement('polyline',{points:coords.map(([lon,lat])=>project({lon,lat}).join(',')).join(' '),fill:'none','vector-effect':'non-scaling-stroke','stroke-linejoin':'round','stroke-linecap':'round',...attrs});
  $(layer).append(el);return el;
}
function storyCallout(position,title,subtitle='',kind=''){
  const [x,y]=MapData.displayProjection(state.network)(position),g=svgElement('g',{transform:`translate(${x} ${y})`,class:`story-callout ${kind}`});
  const box=svgElement('g',{class:'story-callout-box'}),width=Math.max(title.length*6.5,subtitle.length*6)+22;
  Object.assign(g.dataset,{lon:position.lon,lat:position.lat,width,height:subtitle?48:26});
  box.append(svgElement('line',{x1:0,y1:0,x2:12,y2:-12,stroke:'#8896a7','stroke-width':1}));
  box.append(svgElement('rect',{x:12,y:subtitle?-59:-35,width,height:subtitle?48:26,rx:6}));
  box.append(svgElement('text',{x:22,y:subtitle?-40:-17},title));
  if(subtitle)box.append(svgElement('text',{x:22,y:-22,class:'secondary'},subtitle));
  g.append(box);$('callout-layer').append(g);
}
function renderStoryFocus(){
  const focused=story.focus.size>0&&state.mode==='after'&&['DETECTED','REOPTIMIZING','ROUTES_UPDATED'].includes(story.phase);
  const revealing=story.appliedAt&&performance.now()-story.appliedAt<800&&state.mode==='after';
  document.querySelectorAll('[data-route-index]').forEach(el=>{const i=Number(el.dataset.routeIndex),selected=state.route===null||state.route===i;const hideForReveal=revealing&&story.changes.some(c=>c.index===i);el.style.transition=hideForReveal?'none':'';el.style.opacity=hideForReveal?0:selected?(focused&&!story.focus.has(i+1)?.22:.98):.15;});
  document.querySelectorAll('.unchanged-future').forEach(el=>el.style.display=revealing?'':'none');
  document.querySelectorAll('[data-route-history]').forEach(el=>el.style.opacity=focused?.15:.32);
  document.querySelectorAll('[data-vehicle-id]').forEach(el=>el.style.opacity=focused&&!story.focus.has(Number(el.dataset.vehicleId))?.25:(state.route===null||state.route===Number(el.dataset.vehicleId)-1?1:.2));
  for(const id of ['ghost-layer','new-route-layer','callout-layer'])$(id).style.display=state.mode==='before'?'none':'';
}
function showDetected(result){
  story.detector=result.detected_vehicle;story.edge=demo.fixture.event.edge_id;story.detectedAt=performance.now();
  story.focus=new Set(simulation.snapshot().filter(v=>simulation.routes[v.routeIndex].edge_ids.slice(v.segment).includes(story.edge)).map(v=>v.vehicleId));story.focus.add(story.detector);
  storyPhase('DETECTED');
  const edge=state.network.edges[story.edge],a=state.network.nodes[edge.from_node],b=state.network.nodes[edge.to_node];
  storyCallout({lon:(a.lon+b.lon)/2,lat:(a.lat+b.lat)/2},`⚠ Xe ${story.detector} phát hiện ùn tắc`,'Thời gian di chuyển ×3','detection-callout');
  const detector=simulation.snapshot().find(v=>v.vehicleId===story.detector);
  storyCamera([[a.lon,a.lat],[b.lon,b.lat],...(detector?[[detector.position.lon,detector.position.lat]]:[])],Math.min(2.2,state.zoom*1.7));
  layoutStoryCallouts();renderStoryFocus();
}
function showRouteChanges(before,result){
  story.changes=DemoPresentation.changes(before,simulation.routes,simulation.snapshot(),result.updates);story.appliedAt=performance.now();
  storyPhase('ROUTES_UPDATED',story.changes.length);
  for(const id of ['ghost-layer','new-route-layer'])$(id).replaceChildren();
  $('callout-layer').querySelectorAll('.change-callout').forEach(el=>el.remove());
  story.focus=new Set([story.detector].filter(Number.isFinite));
  const coordinates=[];
  for(const c of story.changes){
    story.focus.add(c.index+1);coordinates.push(...c.coordinates,...c.next.coordinates);
    storyPolyline('ghost-layer',c.coordinates,{stroke:'#788494','stroke-width':4,'stroke-dasharray':'7 5',class:'old-future','data-old-vehicle':c.index+1});
    storyPolyline('new-route-layer',c.next.coordinates,{stroke:routeColor(c.index),'stroke-width':5,pathLength:1,class:'new-detour','data-new-vehicle':c.index+1});
    storyCallout(c.position,`↗ Xe ${c.index+1} · Đổi tuyến`,'','change-callout');
  }
  if(story.edge){const e=state.network.edges[story.edge];for(const id of [e.from_node,e.to_node]){const n=state.network.nodes[id];coordinates.push([n.lon,n.lat]);}}
  for(const v of simulation.snapshot())if(story.focus.has(v.vehicleId))coordinates.push([v.position.lon,v.position.lat]);
  if(story.changes.length)storyCamera(coordinates);
  $('route-comparison-key').hidden=!story.changes.length;layoutStoryCallouts();renderStoryFocus();
  clearTimeout(revealTimer);revealTimer=setTimeout(renderStoryFocus,810);
  clearTimeout(storyTimer);storyTimer=setTimeout(()=>{
    for(const id of ['ghost-layer','new-route-layer','callout-layer'])$(id).classList.add('story-fade');
    renderStoryFocus();
    storyTimer=setTimeout(()=>{for(const id of ['ghost-layer','new-route-layer','callout-layer']){$(id).replaceChildren();$(id).classList.remove('story-fade');}$('route-comparison-key').hidden=true;},600);
  },4200);
}
const API_BASE_URL = (window.APP_CONFIG?.API_BASE_URL || '').replace(/\/$/, '');
async function boundedFetch(path, options={}) {
  try {
    const url = API_BASE_URL + path;
    if (location.protocol === 'https:' && url.startsWith('http:')) throw new Error('Cấu hình API phải dùng HTTPS khi website dùng HTTPS.');
    return await fetch(url, {...options, signal:options.signal || AbortSignal.timeout(20000)});
  } catch(error) {
    if (['TypeError','TimeoutError','AbortError'].includes(error.name)) throw new Error('Không thể kết nối máy chủ tối ưu hoặc máy chủ phản hồi quá chậm');
    throw error;
  }
}
async function runJob(path,payload){
  const response=await boundedFetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  const accepted=await response.json();if(response.status!==202)throw new Error(accepted.error||'Không khởi tạo được công việc');
  const started=performance.now();
  while(performance.now()-started<30000){
    await new Promise(resolve=>setTimeout(resolve,300));
    const response=await boundedFetch('/api/jobs/'+accepted.job_id);const status=await response.json();
    if(!response.ok||status.status==='failed')throw new Error(status.error||'Thuật toán thất bại');
    if(status.status==='completed')return {...status.result,job_id:accepted.job_id};
  }
  throw new Error('Thuật toán chưa hoàn tất sau 30 giây có thể thử lại');
}
async function injectHidden(run){
  const eid=run.fixture.event.edge_id;run.lifecycle='ACTIVE_UNDETECTED';
  simulation.setPhysicalState({[eid]:{available:true,travel_time_factor:3}});
  try{
    const response=await boundedFetch('/api/traffic/inject',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({session_id:incidentState.session_id,edge_id:eid,expected_speed:simulation.metersPerMs})});
    const result=await response.json();if(!response.ok)throw new Error(result.error);run.injected=true;
  }catch(error){if(run.active){simulation.setPhysicalState({});stopDemo(`Không thể tạo điều kiện mô phỏng: ${error.message}`);}}
}
async function sendTelemetry(run){
  if(run.sending||!run.injected||!run.sampleQueue.length)return;run.sending=true;
  try{
    while(run.active&&run.lifecycle==='ACTIVE_UNDETECTED'&&run.sampleQueue.length){
      const samples=run.sampleQueue.shift();
      const response=await boundedFetch('/api/traffic/telemetry',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({session_id:incidentState.session_id,samples})});
      const result=await response.json();if(!response.ok)throw new Error(result.error);if(!run.active)return;
      if(result.lifecycle==='DETECTED'){
        run.lifecycle='DETECTED';run.sampleQueue=[];
        incidentState=result.known_state;simulation.setIncidentState(incidentState);dashboard.incident(simulation);
        showDetected(result);
        $('demo-status').textContent='Phát hiện bất thường tốc độ';$('incident-status').textContent='Phát hiện bất thường tốc độ';
        renderIncidents();renderDashboard();
        setTimeout(()=>{if(run.active&&demo===run){run.lifecycle='REOPTIMIZING';$('demo-status').textContent='Đang tái tối ưu tuyến...';reoptimizeFleet();}},700);
      }
    }
  }catch(error){if(run.active)stopDemo(`Lỗi: ${error.message}`);}
  finally{run.sending=false;}
}
function demoControls(){
  $('run-demo').disabled=!state.network || !!demo?.active || demoSetupPending || reoptimizationPending || optimizationLoading;
  $('stop-demo').hidden=!demo?.active;
  if(demo?.active) for(const id of ['incident-submit','incident-context','incident-type','reoptimize','sim-start','sim-pause','sim-resume','sim-reset','show-before','show-after']) $(id).disabled=true;
}
function stopDemo(message){
  if(story.phase!=='ROUTES_UPDATED')resetStory();
  if(demo) demo.active=false;
  stopClock();simulation?.pause();
  $('demo-status').textContent=message;
  $('incident-type').disabled=false;
  $('show-before').disabled=$('show-after').disabled=!state.result;
  $('reoptimize').disabled=!simulation;
  incidentControls();renderSimulation();demoControls();
}
$('stop-demo').addEventListener('click',()=>stopDemo('Đã dừng trình diễn.'));
async function runDemo(){
  if(demo?.active || demoSetupPending || reoptimizationPending || !state.network)return;
  demoSetupPending=true;demo={active:true};demoControls();stopClock();simulation?.pause();
  $('demo-status').textContent='Đang chuẩn bị thuật toán và tính tuyến thật…';
  $('demo-summary').textContent='';
  try{
    const response=await boundedFetch('/api/presentation-scenario');const fixture=await response.json();
    if(!response.ok)throw new Error(fixture.error);
    if(!demo.active)return;
    const run=demo=new DemoPresentation.Presentation(fixture);
    const session=await boundedFetch('/api/simulation',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source_sha256:fixture.source_sha256})});
    const fresh=await session.json();if(!session.ok)throw new Error(fresh.error);
    if(!run.active)return;
    incidentState=fresh;$('request-json').value=JSON.stringify(fixture.scenario);
    if(!await optimizeScenario())throw new Error('Không tạo được tuyến ban đầu');
    if(!run.active)return;
    run.phase='preview';demoControls();
    $('demo-status').textContent='Đội xe chuẩn bị xuất phát';
    setTimeout(()=>{if(demo!==run||!run.active)return;run.phase='moving';$('demo-status').textContent='Đội xe đang giao hàng.';simulation.start();dashboard.moving(0);runClock();renderSimulation();},1500);
  }catch(error){stopDemo(`Không thể chạy demo: ${error.message} Kiểm tra máy chủ rồi thử lại.`);}
  finally{demoSetupPending=false;demoControls();}
}
$('run-demo').addEventListener('click',runDemo);
const dashboard = new DecisionDashboard.Dashboard();
let timelineSignature = '';
function renderDashboard() {
  const pair=(key,scale,unit)=>[dashboard.before,dashboard.after].map(v=>!v?'—':v[key]===null?'Bị chặn':`${(v[key]/scale).toFixed(1)} ${unit}`).join(' → ');
  const live=dashboard.live(simulation,state.nodes.filter(n=>n.id>0).length);
  $('decision-distance').textContent=pair('distance',1000,'km');
  $('decision-time').textContent=pair('travel',60,'phút');
  $('decision-active').textContent=simulation ? live.active : '—';
  $('decision-remaining').textContent=simulation ? live.remaining : '—';
  $('decision-affected').textContent=dashboard.affected;
  $('decision-rerouted').textContent=dashboard.rerouted;
  $('decision-runtime').textContent=dashboard.runtime==null?'—':`${dashboard.runtime.toFixed(2)} s`;
  $('decision-feasibility').textContent=dashboard.feasibility;
  const scopeLabel = $('decision-scope');
  if (scopeLabel) scopeLabel.textContent = dashboard.scope || 'Tối ưu tuyến để bắt đầu.';
  renderBusinessMetrics(live);
  const signature=JSON.stringify(dashboard.events);
  if(signature!==timelineSignature){
    timelineSignature=signature; $('decision-timeline').replaceChildren();
    for(const e of dashboard.events){const li=document.createElement('li');li.textContent=`${e.seconds.toFixed(1)} s · ${e.label}`;$('decision-timeline').append(li);}
  }
}
async function reoptimizeFleet() {
  if (!simulation || !incidentState || reoptimizationPending || state.mode !== 'after') return;
  const active = simulation, revision = incidentState.revision;
  const presentationRun=demo?.active ? demo : null;
  let decisionCapture = null;
  reoptimizationPending = true;
  $('reoptimize').disabled = true;
  $('reopt-status').textContent = 'Thuật toán thật đang tối ưu phần giao hàng còn lại… Xe tiếp tục đoạn đường đã đi vào, rồi chuyển tuyến tại nút tiếp theo.';
  try {
    const vehicles = active.beginReoptimization(state.scenario);
    storyPhase('REOPTIMIZING');
    dashboard.begin(active,vehicles,state.network,incidentState); renderDashboard();
    decisionCapture = dashboard.capture;
    const result=await runJob('/api/reoptimize',{session_id:incidentState.session_id,revision,scenario:state.scenario,vehicles});
    if(presentationRun && !presentationRun.active)throw new Error('Trình diễn đã dừng');
    if (active !== simulation || revision !== incidentState.revision) throw new Error('Trạng thái đã thay đổi; hãy thử lại');
    if(demo?.active && result.failures.length)throw new Error('Có xe chưa tìm được tuyến hợp lệ; chưa áp dụng kết quả demo.');
    if (active.status === 'running') { const now=performance.now(); active.advance(Math.max(0,now-simulationTimestamp)); simulationTimestamp=now; }
    const visualBefore=DemoPresentation.capture(active.routes,active.snapshot());
    const applyStarted=performance.now();
    const geometry = active.applyReoptimization(result);
    showRouteChanges(visualBefore,result);
    result.frontend_application_ms=performance.now()-applyStarted;
    dashboard.applied(result,active.elapsed);
    if(demo?.active){
      demo.phase='finishing';demo.lifecycle='ROUTES_UPDATED';$('demo-status').textContent='Tuyến đã được cập nhật';
      $('demo-summary').textContent=demo.summary(dashboard);
    }
    state.geometry.routes = structuredClone(geometry);
    state.dynamicRoutes = geometry.map(r=>r.stop_sequence.filter(id=>id>=0));
    state.currentSolution={routes:structuredClone(state.dynamicRoutes),geometry:structuredClone(geometry)};
    renderMap(); renderLegend(); renderSimulation(); incidentControls();
    $('map-caption').textContent = 'Tuyến động đã cập nhật · Giữ nguyên phần đã đi';
    $('overlap-info').textContent = 'Phân tích giao thoa trước đó thuộc phương án ban đầu; xem tuyến động hiện tại trên bản đồ.';
    $('reopt-status').textContent = result.updates.map(u=>`Xe ${u.route_index+1}: ${u.metrics.before_available ? u.metrics.before.toFixed(1)+' s' : 'tuyến bị chặn'} → ${u.metrics.after.toFixed(1)} s (${u.engine})`).join(' · ') || 'Không có phần tuyến còn lại bị ảnh hưởng.';
    if (result.failures.length) $('reopt-status').textContent += ' | '+result.failures.map(f=>`Xe ${f.route_index+1}: ${f.error}`).join(' · ');
    result.frontend_application_ms=performance.now()-applyStarted;
    if(presentationRun?.active){
      const acknowledgement=await boundedFetch('/api/traffic/applied',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({session_id:incidentState.session_id,job_id:result.job_id})});
      if(!acknowledgement.ok)throw new Error('Không ghi nhận được trạng thái áp dụng');
    }
    $('raw').textContent = JSON.stringify(result,null,2);
  } catch(error) {
    if(active===simulation && dashboard.capture===decisionCapture){dashboard.failed(active.elapsed);renderDashboard();}
    active.cancelReoptimization(); $('reopt-status').textContent = `Chưa áp dụng tuyến mới: ${error.message}`;
    if(demo?.active)stopDemo(`Demo dừng: ${error.message} (Có thể chạy lại từ đầu)`);
  } finally { reoptimizationPending=false; $('reoptimize').disabled=!simulation || state.mode!=='after'; demoControls(); }
}
$('reoptimize').addEventListener('click', reoptimizeFleet);
const incidentNames = {congestion: 'Kẹt xe', accident: 'Tai nạn', road_blockage: 'Chặn đường'};
function incidentControls() {
  const picker = $('incident-context'), previous = picker.value;
  picker.replaceChildren();
  if (simulation) {
    simulation.snapshot().forEach(v => picker.add(new Option(`Xe ${v.vehicleId} đoạn hiện tại`, `vehicle:${v.vehicleId}`)));
    const edges = new Set(state.geometry[state.mode === 'before' ? 'initial_routes' : 'routes'].flatMap(r => r.edge_ids));
    for (const id of edges) {
      const e = state.network.edges[id], name = state.network.ways[e.way_id]?.tags.name || 'Tuyến Đường';
      picker.add(new Option(`${name} ${id} (${e.from_node} → ${e.to_node})`, id));
    }
    const hotspot = state.geometry.overlap?.incident_hotspot?.edge_id;
    picker.value = [...picker.options].some(o => o.value === previous) ? previous : (edges.has(hotspot) ? hotspot : [...edges][0]);
  }
  picker.disabled = !simulation || incidentPending;
  $('incident-submit').disabled = !simulation || !incidentState || incidentPending;
  demoControls();
}
function renderIncidents() {
  let layer = $('incident-layer');
  if (!layer) { layer = svgElement('g', {id:'incident-layer','aria-label':'Đoạn đường có sự cố'}); $('map-world').append(layer); }
  layer.replaceChildren(); $('incident-list').replaceChildren();
  if (!incidentState || !state.network) return;
  const project = MapData.displayProjection(state.network);
  for (const e of Object.values(incidentState.edge_overrides)) {
    const a = project(state.network.nodes[e.from_node]), b = project(state.network.nodes[e.to_node]);
    layer.append(svgElement('line',{x1:a[0],y1:a[1],x2:b[0],y2:b[1],class:'incident-halo','vector-effect':'non-scaling-stroke'}));
    const line = svgElement('line',{x1:a[0],y1:a[1],x2:b[0],y2:b[1],stroke:'var(--color-danger)','stroke-width':5,class:story.edge===e.edge_id&&performance.now()-story.detectedAt<2000?'incident-detected':'','vector-effect':'non-scaling-stroke','data-incident-edge':e.edge_id});
    line.append(svgElement('title',{},`${e.edge_id} · ${e.available ? `thời gian ×${e.travel_time_factor}` : 'Bị chặn'}`)); layer.append(line);
  }
  for (const incident of incidentState.incidents) {
    const row = document.createElement('p'); row.className = 'incident-row';
    row.textContent = `${incidentNames[incident.type]} - Đang có hiệu lực - ${incident.edge_id}${incident.vehicle_id ? `- Báo từ xe ${incident.vehicle_id}` : ''}`;
    $('incident-list').append(row);
  }
}
async function sendIncident(event) {
  event.preventDefault(); if (!simulation || !incidentState || incidentPending) return;
  const context = $('incident-context').value;
  let edgeId = context, vehicleId = null;
  if (context.startsWith('vehicle:')) {
    vehicleId = Number(context.slice(8));
    edgeId = simulation.snapshot().find(v => v.vehicleId === vehicleId)?.edgeId;
    if (!edgeId) { $('incident-status').textContent = 'Chọn đoạn đường cụ thể hoặc chờ xe di chuyển'; return; }
  }
  const sid = incidentState.session_id;
  const presentationRun=demo?.active ? demo : null;
  incidentPending = true; incidentControls(); $('incident-status').textContent = 'Đang gửi báo cáo đến máy chủ…';
  try {
    const response = await boundedFetch('/api/incidents',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({session_id:sid,type:$('incident-type').value,edge_id:edgeId,vehicle_id:vehicleId})});
    const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Không gửi được báo cáo');
    if(presentationRun && !presentationRun.active)return;
    if (incidentState.session_id !== sid) return;
    // Account for movement before acknowledgement, then apply effects prospectively.
    if (simulation?.status === 'running') { const now = performance.now(); simulation.advance(demo?.active ? demo.budget(simulation.elapsed,now-simulationTimestamp) : now - simulationTimestamp); simulationTimestamp = now; }
    incidentState = result; simulation?.setIncidentState(result);
    if(simulation) dashboard.incident(simulation);
    renderIncidents(); renderSimulation();
    $('incident-status').textContent = `Máy chủ đã ghi nhận - ${result.incidents.length} sự cố đang có hiệu lực - Phiên bản ${result.revision}.`;
    if(demo?.active){demo.phase='impact';$('demo-status').textContent='3/5 - Tai nạn đã được đánh dấu - Tuyến hiện tại chịu thời gian tăng ×6.';} else await reoptimizeFleet();
  } catch (error) { $('incident-status').textContent = `Báo cáo chưa được xác nhận: ${error.message}.`; if(demo?.active)stopDemo(`Báo cáo thất bại: ${error.message}`); }
  finally { incidentPending = false; incidentControls(); }
}
$('incident-form').addEventListener('submit', sendIncident);
function stopClock() {
  if (simulationFrame !== null) cancelAnimationFrame(simulationFrame);
  simulationFrame = null; simulationTimestamp = null;
}
function prepareSimulation() {
  resetStory();
  stopClock();
  simulation = state.geometry ? new VehicleSimulation.Simulation(state.geometry.routes, state.network, {stops:state.scenario.stops,durationMs:demo?.fixture?.duration_ms || 180000}) : null;
  $('reoptimize').disabled = !simulation || reoptimizationPending;
  if (simulation && incidentState) simulation.setIncidentState(incidentState);
  if(simulation && state.result) dashboard.initial(state.geometry,state.result,state.network,incidentState);
  else dashboard.reset();
  incidentControls(); renderIncidents();
  renderSimulation();
}
function tickSimulation(timestamp) {
  simulationFrame = null;
  if (!simulation || simulation.status !== 'running') return;
  const delta=Math.max(0,timestamp-simulationTimestamp);
  simulation.advance(demo?.active ? demo.budget(simulation.elapsed,delta) : delta); simulationTimestamp = timestamp;
  if(demo?.active){
    const event=demo.fixture.event;
    if(demo.lifecycle==='INACTIVE' && demo.phase==='moving' && simulation.elapsed>=event.inject_at_ms)injectHidden(demo);
    if(demo.lifecycle==='ACTIVE_UNDETECTED' && simulation.elapsed>=demo.nextSample){
      demo.sampleQueue.push(demo.samples(simulation));demo.nextSample+=event.sample_interval_ms;sendTelemetry(demo);
    }
    $('demo-status').dataset.trafficLifecycle=demo.lifecycle;
    if(simulation.status==='completed'){demo.phase='completed';stopDemo('(Hoàn tất) Tất cả xe đã về depot, mọi khách hàng đã được phục vụ.');}
  }
  renderSimulation();
  if (simulation.status === 'running') simulationFrame = requestAnimationFrame(tickSimulation);
}
function runClock() { if(story.phase==='READY')storyPhase('ACTIVE'); simulationTimestamp = performance.now(); simulationFrame = requestAnimationFrame(tickSimulation); }
let lastSimulationPaint=0;
function renderSimulation() {
  if(simulation?.status==='running' && performance.now()-lastSimulationPaint<50)return;
  lastSimulationPaint=performance.now();
  renderDashboard();renderRouteProgress();
  let layer = $('vehicle-layer');
  if (!layer) { layer = svgElement('g', {id: 'vehicle-layer', 'aria-label': 'Vị trí đội xe'}); $('map-world').append(layer); }
  layer.style.display=state.mode==='before'?'none':'';
  layer.replaceChildren(); $('vehicle-list').replaceChildren();
  const status = simulation?.status;
  $('sim-start').disabled = status !== 'ready'; $('sim-pause').disabled = status !== 'running';
  $('sim-resume').disabled = status !== 'paused'; $('sim-reset').disabled = !simulation;
  const names = {ready: 'Sẵn sàng', running: 'Đang chạy', paused: 'Tạm dừng', completed: 'Tất cả xe đã về depot'};
  $('sim-status').textContent = simulation ? `${names[status]} · ${(simulation.elapsed / 1000).toFixed(1)} giây - Mốc không sự cố: ${(simulation.duration / 1000).toFixed(0)} giây` : 'Tối ưu tuyến để chuẩn bị xe.';
  demoControls();
  if (!simulation) return;
  const project = MapData.displayProjection(state.network);
  for (const v of simulation.snapshot()) {
    const [x, y] = project(v.position);
    const marker = svgElement('g', {transform: `translate(${x} ${y})`, 'data-vehicle-id': v.vehicleId, 'data-segment': v.segment, 'data-edge-id': v.edgeId || '', 'data-lat': v.position.lat, 'data-lon': v.position.lon, 'data-status': v.status, opacity: state.route === null || state.route === v.routeIndex ? 1 : .2});
    const symbol=svgElement('g',{class:'vehicle-symbol'});marker.append(symbol);
    if(v.vehicleId===story.detector&&performance.now()-story.detectedAt<4500){
      symbol.append(svgElement('circle',{r:19,fill:'#ef4444',opacity:.2,class:'detector-warning-halo','data-detector-halo':v.vehicleId}));
      symbol.append(svgElement('text',{x:0,y:-23,'text-anchor':'middle',fill:'#b91c1c','font-size':9,'font-weight':700},'PHÁT HIỆN'));
    }
    symbol.append(svgElement('rect', {x: -9, y: -7, width: 18, height: 14, rx: 4, fill: routeColor(v.routeIndex), stroke: 'white', 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke'}));
    symbol.append(svgElement('text', {'text-anchor': 'middle', y: 4, fill: 'white', 'font-size': 10, 'font-weight': 700}, String(v.vehicleId)));
    marker.append(svgElement('title', {}, `Xe ${v.vehicleId} - đoạn ${v.segment}/${v.segmentCount}`)); layer.append(marker);
    const row = document.createElement('p'); row.className = 'vehicle-row'; row.style.borderLeftColor = routeColor(v.routeIndex);
    const activity = v.status === 'blocked' ? 'Dừng do chặn đường' : v.status === 'slowed' ? 'Đi chậm do sự cố' : v.status === 'servicing' ? `Giao khách ${v.stopId}` : v.status === 'completed' ? 'Đã về depot' : v.status === 'ready' ? 'Tại depot' : (v.stopId < 0 ? 'Đến nút chuyển tuyến' : `Đến khách ${v.stopId || 'depot'}`);
    row.textContent = `Xe ${v.vehicleId} · ${activity} - đoạn ${v.segment}/${v.segmentCount} - Đã giao ${v.served.length}`;
    row.title = `${v.position.lat.toFixed(6)}, ${v.position.lon.toFixed(6)} - ${v.edgeId || 'Dừng'}`;
    $('vehicle-list').append(row);
  }
  renderStoryFocus();
}
$('sim-start').addEventListener('click', () => { simulation?.start(); if (simulation?.status === 'running' && simulationFrame === null) {dashboard.moving(simulation.elapsed);runClock();} renderSimulation(); });
$('sim-pause').addEventListener('click', () => { if (simulation?.status === 'running') { simulation.advance(performance.now() - simulationTimestamp); simulation.pause(); } stopClock(); renderSimulation(); });
$('sim-resume').addEventListener('click', () => { if (simulation?.status === 'paused') { simulation.resume(); runClock(); } renderSimulation(); });
$('sim-reset').addEventListener('click', () => { resetStory(); stopClock(); simulation?.reset(); if(state.result)dashboard.initial(state.geometry,state.result,state.network,incidentState); renderSimulation(); });
document.addEventListener('visibilitychange', () => { if (document.hidden && simulation?.status === 'running') $('sim-pause').click(); });
const palette = ['#2563EB','#0EA5A8','#16A34A','#F59E0B','#7C3AED','#E11D48'];
function routeColor(i) { return palette[i] || `hsl(${(i * 137.508) % 360} 65% 38%)`; }
function routes() { return (state.mode==='before'?state.initialSolution:state.currentSolution)?.routes || []; }
function svgElement(tag, attributes, text) {
  const node = document.createElementNS(NS, tag);
  Object.entries(attributes).forEach(([k, v]) => node.setAttribute(k, v));
  if (text !== undefined) node.textContent = text;
  return node;
}
function resetView() {
  cancelAnimationFrame(cameraFrame);cameraFrame=null;
  if(!state.network||!state.nodes.length){state.zoom=1;state.tx=state.ty=0;transformView();return;}
  const project=MapData.displayProjection(state.network);
  const coordinates=[...state.nodes.map(n=>[n.lon,n.lat]),...(state.geometry?.[state.mode==='before'?'initial_routes':'routes']||[]).flatMap(r=>r.coordinates)];
  const p=coordinates.map(([lon,lat])=>project({lon,lat}));
  const xs=p.map(p=>p[0]),ys=p.map(p=>p[1]);const minx=Math.min(...xs),maxx=Math.max(...xs),miny=Math.min(...ys),maxy=Math.max(...ys);
  const map=$('network-map'),w=map.clientWidth||800,h=map.clientHeight||680;
  map.setAttribute('viewBox',`0 0 ${w} ${h}`);
  state.zoom=Math.min(Math.max(w-120,100)/Math.max(maxx-minx,1),Math.max(h-100,100)/Math.max(maxy-miny,1));
  state.tx=w/2-state.zoom*(minx+maxx)/2;state.ty=h/2-state.zoom*(miny+maxy)/2;transformView();
}
function transformView() {
  $('network-map').style.setProperty('--map-zoom',state.zoom);
  $('map-world').setAttribute('transform', `translate(${state.tx} ${state.ty}) scale(${state.zoom})`);
  $('zoom-level').textContent = `${Math.round(state.zoom * 100)}%`;
  if(!cameraFrame){cancelAnimationFrame(labelFrame);labelFrame=requestAnimationFrame(layoutLabels);}
}
function zoomBy(factor, x = $('network-map').clientWidth/2, y = $('network-map').clientHeight/2) {
  cancelAnimationFrame(cameraFrame);cameraFrame=null;
  const next = Math.max(0.5, Math.min(6, state.zoom * factor));
  const ratio = next / state.zoom;
  state.tx = x - (x - state.tx) * ratio;
  state.ty = y - (y - state.ty) * ratio;
  state.zoom = next; transformView();
}
function svgPoint(event) {
  return new DOMPoint(event.clientX, event.clientY).matrixTransform($('network-map').getScreenCTM().inverse());
}
function renderMap() {
  const world = $('overlay-layer'); world.replaceChildren(); $('customer-layer').replaceChildren();
  $('map-empty').style.display = state.nodes.length ? 'none' : '';
  if (!state.nodes.length) return;
  const project = MapData.displayProjection(state.network);
  const points = new Map(state.nodes.map(n => [n.id, project(n)]));
  const current = routes();
  current.forEach((route, i) => {
    const path = svgElement('polyline', {
      points: state.geometry[state.mode === 'before' ? 'initial_routes' : 'routes'][i].coordinates.map(([lon, lat]) => project({lon, lat}).join(',')).join(' '), fill: 'none', stroke: routeColor(i),
      'stroke-width': state.route === i ? 4 : 3, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
      'stroke-dasharray': i % 3 === 1 ? '9 4' : i % 3 === 2 ? '3 4' : 'none',
      opacity: state.route !== null && state.route !== i ? 0.15 : 0.98,
      'vector-effect': 'non-scaling-stroke', 'data-route-index': i,
    });
    path.append(svgElement('title', {}, `Tuyến ${i + 1}: ${route.join(' → ')}`));
    world.append(svgElement('polyline',{fill:'none',stroke:routeColor(i),'stroke-width':3,opacity:.45,'vector-effect':'non-scaling-stroke','data-route-history':i}));
    world.append(path);
  });
  state.nodes.forEach(n => {
    const [x, y] = points.get(n.id);
    const index = current.findIndex(route => n.id !== 0 && route.includes(n.id));
    const color = index >= 0 ? routeColor(index) : '#516e7b';
    const label = n.id === 0 ? 'Depot 0' : `Khách hàng ${n.id}`;
    const group = svgElement('g', {transform: `translate(${x} ${y})`, class: `node-marker${state.selected === n.id ? ' selected' : ''}`, role: 'button', tabindex: 0, 'aria-label': label, 'aria-pressed': String(state.selected === n.id), 'data-node-id': n.id});
    group.append(svgElement('title', {}, `${label} · Nhu cầu ${n.demand}`));
    group.append(svgElement('circle', {r: 8, fill: '#E9EEF3', stroke: '#526D82', 'stroke-width': 2, class: 'selection-ring'}));
    if (n.id === 0) group.append(svgElement('rect', {x: -10, y: -10, width: 20, height: 20, rx: 1, fill: '#243447', stroke: '#fff', 'stroke-width': 2, class: 'marker-shape'}));
    else group.append(svgElement('circle', {r: 5.5, fill: '#fff', stroke: color, 'stroke-width': 2, class: 'marker-shape'}));
    group.append(svgElement('text', {x: 8, y: -8, class: 'node-label'}, n.id === 0 ? 'DEPOT' : String(n.id)));
    group.addEventListener('click', () => selectNode(n.id));
    group.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectNode(n.id); } });
    $('customer-layer').append(group);
  });
  transformView();renderRouteProgress();renderStoryFocus();
}
function renderRouteProgress(){
  if(!simulation||!state.geometry||state.mode==='before')return;
  const project=MapData.displayProjection(state.network);
  const points=coords=>coords.map(([lon,lat])=>project({lon,lat}).join(',')).join(' ');
  for(const v of simulation.snapshot()){
    const route=state.geometry.routes[v.routeIndex],position=[v.position.lon,v.position.lat];
    const history=document.querySelector(`[data-route-history="${v.routeIndex}"]`),future=document.querySelector(`[data-route-index="${v.routeIndex}"]`);
    if(history)history.setAttribute('points',v.status==='ready'?'':points([...route.coordinates.slice(0,v.segment+1),position]));
    if(future)future.setAttribute('points',v.status==='completed'?'':points([position,...route.coordinates.slice(v.segment+1)]));
  }
}
function selectNode(id) {
  state.selected = id;
  $('node-picker').value = String(id);
  // Update marker state without replacing focused SVG elements.
  document.querySelectorAll('.node-marker').forEach(node => {
    const selected = Number(node.dataset.nodeId) === id;
    node.classList.toggle('selected', selected); node.setAttribute('aria-pressed', String(selected));
  });
  renderNodeInfo();
}
function renderNodeInfo() {
  const container = $('node-info'); container.replaceChildren();
  const n = state.nodes.find(n => n.id === state.selected);
  if (!n) { const p = document.createElement('p'); p.className = 'hint'; p.textContent = 'Chọn depot hoặc khách hàng để xem chi tiết.'; container.append(p); return; }
  const heading = document.createElement('h3'); heading.textContent = n.id === 0 ? 'Depot · Điểm xuất phát' : `Khách hàng ${n.id}`; container.append(heading);
  const current = routes(), index = current.findIndex(route => n.id !== 0 && route.includes(n.id));
  const data = [['Vĩ độ / Kinh độ', `${n.lat.toFixed(6)} / ${n.lon.toFixed(6)}`], ['OSM node gần nhất', n.nearest_osm_node_id || 'Chưa ghép'], ['Khoảng cách ghép', n.snap_distance_m === undefined ? '—' : `${n.snap_distance_m.toFixed(1)} m`], ['Nhu cầu', n.demand], ['Khung giờ', `${n.ready_time} – ${n.due_date}`], ['Thời gian phục vụ', n.service_time], ['Tuyến', n.id === 0 ? 'Tất cả tuyến' : index >= 0 ? `Tuyến ${index + 1}` : 'Chưa phân tuyến']];
  if (index >= 0) data.push(['Thứ tự ghé', current[index].indexOf(n.id)]);
  const dl = document.createElement('dl');
  for (const [label, value] of data) { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = label; dd.textContent = String(value); dl.append(dt, dd); }
  container.append(dl);
}
function renderLegend() {
  const list = $('route-list'); list.replaceChildren();
  const current = routes();
  if (!current.length) { const p = document.createElement('p'); p.className = 'hint'; p.textContent = 'Chạy kịch bản mẫu để nhận tuyến từ LNS.'; list.append(p); }
  current.forEach((route, i) => {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'route-button'; button.setAttribute('aria-pressed', String(state.route === i));
    button.setAttribute('aria-label', `Làm nổi bật tuyến ${i + 1}`);
    const swatch = document.createElement('span'); swatch.className = 'route-swatch'; swatch.style.setProperty('--route-color', routeColor(i));
    if (i % 3) swatch.style.borderTopStyle = i % 3 === 1 ? 'dashed' : 'dotted';
    const text = document.createElement('span'), title = document.createElement('strong'), description = document.createElement('small');
    title.textContent = `Tuyến ${i + 1} · ${route.filter(id => id !== 0).length} khách`;
    const road = state.geometry[state.mode === 'before' ? 'initial_routes' : 'routes'][i];
    description.textContent = `${route.join(' → ')} · Đường OSM ${(road.distance_m / 1000).toFixed(2)} km`; text.append(title, description); button.append(swatch, text);
    button.addEventListener('click', () => {
      state.route = state.route === i ? null : i; renderMap(); renderSimulation();
      [...list.children].forEach((item, j) => item.setAttribute('aria-pressed', String(state.route === j)));
    });
    list.append(button);
  });
  $('route-count').textContent = state.result ? String(current.length) : '—';
  $('view-summary').textContent = `${state.nodes.length ? state.nodes.length - 1 : 0} khách hàng · ${current.length} tuyến · Nền đường OSM thật`;
}
function renderOverlap() {
  const container = $('overlap-info'); container.replaceChildren();
  const overlap = state.geometry?.overlap;
  if (!overlap) { const p = document.createElement('p'); p.className = 'hint'; p.textContent = 'Tối ưu tuyến để phân tích các nút và đoạn đường OSM được nhiều xe dùng chung.'; container.append(p); return; }
  const summary = document.createElement('p'); summary.className = 'overlap-summary';
  summary.textContent = `${overlap.shared_node_count} nút chung · ${overlap.shared_edge_count} đoạn đường chung`;
  container.append(summary);
  const hotspot = overlap.incident_hotspot;
  if (!hotspot) { const p = document.createElement('p'); p.className = 'hint'; p.textContent = 'Không có đoạn đường chung để đề xuất điểm sự cố.'; container.append(p); return; }
  const title = document.createElement('h3'); title.textContent = 'Điểm sự cố đề xuất'; container.append(title);
  const details = [['Đoạn OSM', hotspot.edge_id], ['Xe bị ảnh hưởng', hotspot.vehicles_affected.map(v => `Xe ${v}`).join(', ')], ['Chiều dài nền', `${hotspot.baseline_distance_m.toFixed(1)} m`], ['Thời gian nền', hotspot.baseline_travel_time_s == null ? 'Không có dữ liệu' : `${hotspot.baseline_travel_time_s.toFixed(1)} giây`]];
  const dl = document.createElement('dl');
  for (const [label, value] of details) { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = label; dd.textContent = value; dl.append(dt, dd); }
  container.append(dl);
}
function setMode(mode) {
  const changed = state.mode !== mode;
  state.mode = mode; state.route = null;
  $('show-before').setAttribute('aria-pressed', String(mode === 'before'));
  $('show-after').setAttribute('aria-pressed', String(mode === 'after'));
  $('map-caption').textContent = state.result ? (mode === 'before' ? 'Kế hoạch ban đầu · không thay đổi' : 'Kế hoạch hiện tại') : 'Các điểm đầu vào · Chưa tối ưu';
  renderMap(); renderLegend(); renderNodeInfo();
  if (changed) renderSimulation();
}
function setNodes(nodes) {
  state.nodes = nodes; state.selected = null; state.route = null;
  const picker = $('node-picker'); picker.replaceChildren(new Option('Chọn một điểm…', ''));
  nodes.forEach(n => picker.add(new Option(n.id === 0 ? 'Depot 0' : `Khách hàng ${n.id}`, String(n.id))));
  $('customer-count').textContent = String(nodes.filter(n => n.id !== 0).length);
  resetView(); renderNodeInfo();
}
function clearResult() {
  state.dynamicRoutes = null;state.initialSolution=null;state.currentSolution=null;
  state.result = null; state.geometry = null; state.route = null;
  prepareSimulation();
  $('show-before').disabled = true; $('show-after').disabled = true;
  $('distance').textContent = '—'; $('runtime').textContent = '—'; $('raw').textContent = 'Chưa có kết quả.';
  renderOverlap();
  setMode('after');
}
$('node-picker').addEventListener('change', event => selectNode(event.target.value === '' ? null : Number(event.target.value)));
$('show-before').addEventListener('click', () => setMode('before'));
$('show-after').addEventListener('click', () => setMode('after'));
$('zoom-in').addEventListener('click', () => zoomBy(1.3));
$('zoom-out').addEventListener('click', () => zoomBy(1 / 1.3));
$('fit').addEventListener('click', resetView);
const svg = $('network-map'); let drag = null;
svg.addEventListener('wheel', event => { event.preventDefault(); const p = svgPoint(event); zoomBy(event.deltaY < 0 ? 1.12 : 1 / 1.12, p.x, p.y); }, {passive: false});
svg.addEventListener('pointerdown', event => { if (event.button !== 0 || event.target.closest('.node-marker')) return; const p = svgPoint(event); cancelAnimationFrame(cameraFrame);cameraFrame=null; drag = {id: event.pointerId, x: p.x, y: p.y, tx: state.tx, ty: state.ty}; svg.setPointerCapture(event.pointerId); });
svg.addEventListener('pointermove', event => { if (!drag || drag.id !== event.pointerId) return; const p = svgPoint(event); state.tx = drag.tx + p.x - drag.x; state.ty = drag.ty + p.y - drag.y; transformView(); });
function endDrag() { drag = null; }
svg.addEventListener('pointerup', endDrag); svg.addEventListener('pointercancel', endDrag); svg.addEventListener('lostpointercapture', endDrag);

async function optimizeScenario() {
  optimizationLoading=true;clearResult();$('status').className='';$('status').textContent='Đang tính ma trận thời gian đường OSM và tối ưu LNS...';
  try{
    const scenario=JSON.parse($('request-json').value);
    const data=await runJob('/api/jobs/initial',{scenario});
    const geometry=data.road_geometry;
    if(demo?.active && !data.overlap_analysis.accepted)throw new Error('Kịch bản không đạt điều kiện giao thoa đường thực');
    if(demo?.active){
      const shared=geometry.overlap.shared_edges.find(e=>e.edge_id===demo.fixture.event.edge_id);
      if(!shared || shared.routes_affected<3)throw new Error('Điểm ùn tắc không được chia sẻ bởi ít nhất ba xe');
    }
    state.scenario=scenario;state.result=data;
    state.initialSolution={routes:structuredClone(data.routes),geometry:structuredClone(geometry.routes)};
    state.currentSolution=structuredClone(state.initialSolution);
    state.geometry={...geometry,initial_routes:structuredClone(geometry.routes)};
    setNodes(data.dataset.nodes.map(n=>{
      const stop=scenario.stops.find(s=>s.id===n.id);
      if(!stop||n.x!==stop.lon||n.y!==stop.lat)throw new Error('Tọa độ đầu ra LNS không khớp');
      return {...n,...stop,...geometry.snapped_stops.find(s=>s.id===n.id)};
    }));
    renderOverlap();$('show-before').disabled=$('show-after').disabled=false;
    $('distance').textContent=`${data.initial_objective[1].toFixed(1)} → ${data.objective[1].toFixed(1)} s`;
    $('runtime').textContent=`${data.total_seconds.toFixed(2)} s · Hình học ${data.geometry_seconds.toFixed(2)} s`;
    $('raw').textContent=JSON.stringify(data,null,2);
    setMode('after');prepareSimulation();resetView();
    $('status').textContent=`6 tuyến đường thực · ${data.overlap_analysis.shared_corridors} vùng dùng chung · LNS theo thời gian OSM · Nghiệm hợp lệ`;
    return true;
  }catch(error){clearResult();$('status').className='error';$('status').textContent=`Không thể tối ưu: ${error.message}`;return false;}
  finally{optimizationLoading=false;demoControls();}
}
function renderRoads() {
  const project = MapData.displayProjection(state.network), paths = new Map();
  let count = 0;
  for (const way of Object.values(state.network.ways)) {
    if (way.edge_exclusion_reason) continue;
    const category = way.tags.highway;
    const d = way.node_ids.map((id, i) => {
      const [x, y] = project(state.network.nodes[id]);
      return `${i ? 'L' : 'M'}${x.toFixed(3)},${y.toFixed(3)}`;
    }).join(' ');
    paths.set(category, (paths.get(category) || '') + d + ' '); count++;
  }
  const layer = $('road-layer'); layer.replaceChildren();
  for (const [category, d] of paths) {
    const major = /^(motorway|trunk|primary|secondary|tertiary)/.test(category);
    layer.append(svgElement('path', {d,fill:'none',stroke:'var(--map-outline)','stroke-width':major?3:1.8,'vector-effect':'non-scaling-stroke'}));
    layer.append(svgElement('path', {d, fill: 'none', stroke: major ? 'var(--map-major)' : 'var(--map-minor)',opacity:major?.9:.8,
      'stroke-width': major ? 1.8 : 0.9, 'vector-effect': 'non-scaling-stroke', 'data-highway': category}));
  }
  layer.dataset.wayCount = String(count);
}
let mapLoading=false;
async function loadNetwork() {
  if(mapLoading)return;
  mapLoading=true;$('retry-load').hidden=true;
  $('status').className='';$('status').textContent='Đang tải bản đồ và chuẩn bị đội xe…';
  try {
    const response = await boundedFetch('/api/network');
    const network = await response.json();
    if (!response.ok) throw new Error(network.error || 'Không tải được bản đồ');
    const scenarioResponse = await boundedFetch('/api/presentation-scenario');
    const fixture = await scenarioResponse.json();
    const scenario = fixture.scenario;
    if (!scenarioResponse.ok) throw new Error(fixture.error || 'Không tạo được kịch bản trình diễn');
    const request = MapData.toRequest(network, scenario);
    state.network = network; state.scenario = scenario;
    const sessionResponse = await boundedFetch('/api/simulation',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source_sha256:network.metadata.source.sha256})});
    incidentState = await sessionResponse.json();
    if (!sessionResponse.ok) { const message = incidentState.error; incidentState = null; throw new Error(message || 'Không tạo được phiên mô phỏng'); }
    renderRoads(); loadDisplayContext();
    $('request-json').value = JSON.stringify(scenario, null, 2);
    setNodes(MapData.bindResult(network, scenario, {dataset: {nodes: request.instance.nodes}})); setMode('after'); renderDashboard();
    const source = network.metadata.source;
    $('map-source').textContent = `${source.filename} · ${Object.keys(network.nodes).length.toLocaleString('vi-VN')} nút · ${Object.keys(network.edges).length.toLocaleString('vi-VN')} cạnh có hướng`;
    $('map-source').title = `SHA256: ${source.sha256}`;
    $('status').textContent = 'Bản đồ đã sẵn sàng. Bấm Chạy kịch bản mẫu để bắt đầu trình diễn.';
    demoControls();
  } catch (error) {
    state.network = null;
    $('retry-load').hidden=false;demoControls();
    $('status').className = 'error'; $('status').textContent = `Không thể tải bản đồ: ${error.message}. Kiểm tra nguồn --map-data rồi tải lại trang.`;
  } finally{mapLoading=false;}
}
$('retry-load').addEventListener('click',loadNetwork);
loadNetwork();

new ResizeObserver(()=>{if(state.nodes.length)resetView();}).observe($('network-map'));

async function loadDisplayContext(){
  try{
    const response=await boundedFetch('/api/network/context');if(!response.ok)return;
    const context=await response.json(),project=MapData.displayProjection(state.network),layer=$('context-layer');
    layer.replaceChildren();
    for(const feature of context.features||[]){
      const polygon=feature.geometry.type==='Polygon',coords=polygon?feature.geometry.coordinates[0]:feature.geometry.coordinates;
      const d=coords.map(([lon,lat],i)=>(i?'L':'M')+project({lon,lat}).join(',')).join(' ')+(polygon?' Z':'');
      const color=feature.properties.kind==='water'?'var(--map-water)':'var(--map-green)';
      layer.append(svgElement('path',{d,fill:polygon?color:'none',stroke:color,'stroke-width':polygon?0:3,'vector-effect':'non-scaling-stroke'}));
    }
  }catch(error){console.info('Lớp cảnh quan không khả dụng; giữ nền trung tính.');}
}

let chartSignature='';
function renderBusinessMetrics(live){
  const fmt=(v,scale=1,unit='')=>Number.isFinite(v)?`${(v/scale).toLocaleString('vi-VN',{maximumFractionDigits:1})}${unit}`:'—';
  $('kpi-active').textContent=simulation?live.active:'—';
  $('kpi-customers').textContent=state.nodes.length?state.nodes.filter(n=>n.id>0).length:'—';
  $('kpi-time').textContent=fmt(dashboard.after?.travel,60,' phút');
  $('kpi-time').title=dashboard.scope||'Chưa có kết quả tối ưu';
  $('kpi-time').nextElementSibling.textContent=dashboard.scope?.includes('còn lại')?'Thời gian tuyến còn lại':'Tổng thời gian di chuyển';
  $('kpi-affected').textContent=dashboard.before?dashboard.affected:'—';
  const before=dashboard.before?.travel,after=dashboard.after?.travel;
  $('kpi-saved').textContent=Number.isFinite(before)&&Number.isFinite(after)?fmt(before-after,60,' phút'):'—';
  const fleet=simulation?.routes?.length||state.geometry?.routes?.length||0;
  const signature=JSON.stringify([dashboard.before,dashboard.after,dashboard.rerouted,dashboard.scope,fleet]);
  if(signature===chartSignature)return;chartSignature=signature;
  const chart=$('comparison-chart');chart.replaceChildren();
  const make=(tag,cls,text)=>{const e=document.createElement(tag);e.className=cls;if(text!==undefined)e.textContent=text;return e;};
  const number=value=>value.toLocaleString('vi-VN',{maximumFractionDigits:1,minimumFractionDigits:1});
  const distanceDelta=Number.isFinite(dashboard.before?.distance)&&Number.isFinite(dashboard.after?.distance)?(dashboard.after.distance-dashboard.before.distance)/1000:null;
  const timeDelta=Number.isFinite(before)&&Number.isFinite(after)?(after-before)/60:null;
  for(const [label,a,b,scale,unit] of [['Quãng đường',dashboard.before?.distance,dashboard.after?.distance,1000,'km'],['Thời gian',before,after,60,'phút']]){
    const card=make('article','comparison-card');card.append(make('h3','',label));
    const plot=make('div','vertical-comparison');plot.setAttribute('role','img');
    plot.setAttribute('aria-label',`${label}: Trước ${fmt(a,scale,' '+unit)}, Sau ${fmt(b,scale,' '+unit)}`);
    const max=Math.max(Number.isFinite(a)?a:0,Number.isFinite(b)?b:0,1);
    for(const [value,name,kind] of [[a,'Trước','before'],[b,'Sau','after']]){
      const column=make('div','comparison-column');
      const track=make('div','vertical-track');const bar=make('div','vertical-bar '+kind);
      bar.style.height=Number.isFinite(value)?`${Math.max(0,value)/max*76}%`:'0%';
      bar.append(make('strong','bar-value',fmt(value,scale,' '+unit)));track.append(bar);
      column.append(track,make('span','bar-label',name));plot.append(column);
    }
    const delta=Number.isFinite(a)&&Number.isFinite(b)?(b-a)/scale:null;
    const caption=make('p','comparison-delta'+(label==='Thời gian'&&delta<0?' time-saving':''),delta===null?'Chờ dữ liệu so sánh':`${delta>0?'+':delta<0?'−':''}${number(Math.abs(delta))} ${unit}`);
    card.append(plot,caption);chart.append(card);
  }
  const count=dashboard.after?dashboard.rerouted:null,ratio=count!==null&&fleet>0?count/fleet:null;
  const card=make('article','comparison-card');card.append(make('h3','','Xe đổi tuyến'));
  const donut=make('div','fleet-donut');donut.style.setProperty('--fleet-share',`${Math.max(0,Math.min(1,ratio??0))*100}%`);
  donut.setAttribute('role','img');donut.setAttribute('aria-label',ratio===null?'Chưa có dữ liệu xe đổi tuyến':`${count} trên ${fleet} xe đổi tuyến`);
  const center=make('div','donut-center');center.append(make('strong','',ratio===null?'—':`${count} / ${fleet}`),make('span','','xe đổi tuyến'));donut.append(center);
  card.append(donut,make('p','comparison-delta',ratio===null?'Chờ dữ liệu so sánh':`${(ratio*100).toLocaleString('vi-VN',{maximumFractionDigits:1})}% đội xe được điều chỉnh`));chart.append(card);
  let insight='Chạy kịch bản để xem dữ liệu thực.';
  if(distanceDelta!==null&&timeDelta!==null){
    const distanceText=Math.abs(distanceDelta)<.05?'Quãng đường gần như không đổi':`${distanceDelta>0?'Đi xa hơn':'Đi ngắn hơn'} ${number(Math.abs(distanceDelta))} km`;
    const timeText=Math.abs(timeDelta)<.05?'thời gian gần như không đổi':`${timeDelta<0?'tiết kiệm':'tăng'} ${number(Math.abs(timeDelta))} phút`;
    insight=`${distanceText} ${distanceDelta>0&&timeDelta<0?'nhưng':'và'} ${timeText}${distanceDelta>0&&timeDelta<0&&dashboard.scope?.includes('còn lại')?' nhờ tránh khu vực ùn tắc':''}.`;
  }
  $('chart-scope').textContent=insight;
  $('chart-scope').title=dashboard.scope||'';
}
