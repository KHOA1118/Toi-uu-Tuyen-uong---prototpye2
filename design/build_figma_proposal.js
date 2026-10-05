// Design artifact only. Does not run in the application.
await figma.setCurrentPageAsync(await figma.getNodeByIdAsync('0:1'));
for(const style of ['Regular','Medium','Semi Bold','Bold'])await figma.loadFontAsync({family:'Inter',style});
const page=figma.currentPage;page.name='SOPTIX · Proposal';
const made=[];const record=n=>{made.push(n.id);return n;};
const rgb=h=>({r:parseInt(h.slice(1,3),16)/255,g:parseInt(h.slice(3,5),16)/255,b:parseInt(h.slice(5,7),16)/255});
const palette={primary:'#2563EB',navy:'#172B4D',teal:'#0F9F8F',success:'#16A34A',warning:'#F59E0B',danger:'#DC2626',background:'#F5F7FA',surface:'#FFFFFF',secondary:'#667085',border:'#DCE4EE',soft:'#EFF6FF'};
const collection=figma.variables.createVariableCollection('SOPTIX / Source palette');
const tokens={};
// Same creation/binding sequence as the skill's createSemanticTokens helper.
for(const [name,hex] of Object.entries(palette)){
 const primitive=figma.variables.createVariable('primitive/'+name,collection,'COLOR');primitive.scopes=[];primitive.setValueForMode(collection.defaultModeId,rgb(hex));primitive.setVariableCodeSyntax('WEB',`var(--color-${name})`);
 const semantic=figma.variables.createVariable('semantic/'+name,collection,'COLOR');semantic.scopes=['FRAME_FILL','SHAPE_FILL','TEXT_FILL','STROKE_COLOR'];semantic.setValueForMode(collection.defaultModeId,{type:'VARIABLE_ALIAS',id:primitive.id});semantic.setVariableCodeSyntax('WEB',`var(--${name==='primary'?'brand-primary':name})`);tokens[name]=semantic;
}
function fill(n,key){n.fills=[figma.variables.setBoundVariableForPaint({type:'SOLID',color:rgb(palette[key])},'color',tokens[key])];}
const styles={};for(const [name,size,style] of [['Body',14,'Regular'],['Label',12,'Medium'],['Heading',16,'Semi Bold'],['Value',30,'Bold'],['Caption',11,'Regular']]){const s=figma.createTextStyle();s.name='SOPTIX/'+name;s.fontName={family:'Inter',style};s.fontSize=size;s.lineHeight={unit:'PERCENT',value:140};styles[name]=s;}
function text(value,kind='Body',color='navy'){const t=record(figma.createText());t.fontName={family:'Inter',style:'Regular'};t.characters=value;t.textStyleId=styles[kind].id;fill(t,color);return t;}
function box(name,dir='VERTICAL',w=100,h=100,bg='surface'){const n=record(figma.createAutoLayout(dir));n.name=name;n.resize(w,h);n.primaryAxisSizingMode='FIXED';n.counterAxisSizingMode='FIXED';n.itemSpacing=8;fill(n,bg);return n;}
function append(p,n){p.appendChild(n);return n;}
function pad(n,x){n.paddingLeft=n.paddingRight=n.paddingTop=n.paddingBottom=x;}
function border(n){n.strokes=[figma.variables.setBoundVariableForPaint({type:'SOLID',color:rgb(palette.border)},'color',tokens.border)];n.strokeWeight=1;}
function component(name,w,h,dir='HORIZONTAL'){const c=record(figma.createComponent());c.name='SOPTIX/'+name;c.resize(w,h);c.layoutMode=dir;c.primaryAxisSizingMode='FIXED';c.counterAxisSizingMode='FIXED';c.itemSpacing=8;fill(c,'surface');c.description='Visual-only SOPTIX component; existing product behavior and DOM hooks are preserved in implementation.';c.x=1700;c.y=made.length*8;return c;}
const button=component('Button',110,42);button.primaryAxisAlignItems='CENTER';button.counterAxisAlignItems='CENTER';button.cornerRadius=8;fill(button,'primary');append(button,text('Tối Ưu','Body','surface'));const labelProp=button.addComponentProperty('Label','TEXT','Tối Ưu');button.children[0].componentPropertyReferences={characters:labelProp};
function btn(label,primary=false,width=110){const n=record(button.createInstance());n.setProperties({[labelProp]:label});n.resize(width,42);if(!primary){fill(n,'surface');border(n);fill(n.findOne(x=>x.type==='TEXT'),'navy');}return n;}
const badge=component('Status badge',112,28);badge.primaryAxisAlignItems='CENTER';badge.counterAxisAlignItems='CENTER';badge.cornerRadius=6;fill(badge,'soft');append(badge,text('● Hoàn tất','Label','teal'));
const kpi=component('KPI item',260,88,'VERTICAL');pad(kpi,16);kpi.itemSpacing=4;append(kpi,text('Xe đang hoạt động','Label','secondary'));append(kpi,text('0','Value'));
const row=component('Vehicle information row',332,46);pad(row,8);append(row,text('● Xe 1','Label','primary'));append(row,text('Đã về depot · Đã giao 4','Label','secondary'));
const route=component('Route information row',332,60,'VERTICAL');pad(route,8);append(route,text('Tuyến 1 · 4 khách','Label'));append(route,text('0 → 2 → 1 → 15 → 9 → 0','Caption','secondary'));
const section=component('Panel section',368,60,'VERTICAL');pad(section,16);append(section,text('Mô phỏng đội xe','Heading'));
const header=component('Header',1440,64);pad(header,24);header.paddingTop=header.paddingBottom=8;header.counterAxisAlignItems='CENTER';append(header,text('SOPTIX','Heading'));append(header,text('Fleet Routing & Dispatch Optimization','Label','secondary'));const space=append(header,box('Flexible space','HORIZONTAL',600,20));space.layoutSizingHorizontal='FILL';append(header,record(badge.createInstance()));append(header,btn('Tối Ưu',true));
const root=box('SOPTIX / Desktop / 1440 × 900','VERTICAL',1440,900,'background');root.x=200;root.y=100;root.itemSpacing=0;root.clipsContent=true;
append(root,record(header.createInstance()));
const body=append(root,box('Workspace','VERTICAL',1440,836,'background'));pad(body,24);body.itemSpacing=16;
const kpibar=append(body,box('Fleet status','HORIZONTAL',1392,88));kpibar.itemSpacing=0;kpibar.cornerRadius=10;border(kpibar);
for(const [label,value] of [['Xe đang hoạt động','0'],['Điểm giao hàng','24'],['Thời gian tuyến còn lại','68,1 phút'],['Xe bị ảnh hưởng','4'],['Ước tính tiết kiệm','1,3 phút']]){const n=append(kpibar,record(kpi.createInstance()));n.resize(278.4,88);const ts=n.findAllWithCriteria({types:['TEXT']});ts[0].characters=label;ts[1].characters=value;}
const main=append(body,box('Map + Operations','HORIZONTAL',1392,684,'background'));main.itemSpacing=16;
const map=append(main,box('Map · 72.4%','VERTICAL',1008,684));map.itemSpacing=0;map.cornerRadius=10;map.clipsContent=true;border(map);
const mh=append(map,box('Map toolbar','HORIZONTAL',1008,64));pad(mh,16);mh.counterAxisAlignItems='CENTER';append(mh,text('Mạng lưới giao hàng','Heading'));const ms=append(mh,box('Spacer','HORIZONTAL',150,20));ms.layoutSizingHorizontal='FILL';append(mh,btn('Kế hoạch ban đầu',false,152));append(mh,btn('Kế hoạch hiện tại',false,154));
const timeline=append(map,box('Lifecycle','HORIZONTAL',1008,40));timeline.paddingLeft=16;timeline.counterAxisAlignItems='CENTER';append(timeline,text('✓ Đang giao hàng     →     ✓ Phát hiện ùn tắc     →     ✓ Tái tối ưu     →     3 tuyến đã đổi','Label','teal'));
const stage=append(map,box('Real OSM map snapshot','VERTICAL',1008,540));stage.clipsContent=true;stage.itemSpacing=0;
// MAP_SVG is supplied from the existing rendered SVG; no invented road geometry.
const vector=record(figma.createNodeFromSvg(MAP_SVG));append(stage,vector);vector.name='Actual OSM roads, routes and original customer positions';vector.resize(1008,540);
const foot=append(map,box('Map footer','HORIZONTAL',1008,40));foot.paddingLeft=foot.paddingRight=16;foot.counterAxisAlignItems='CENTER';append(foot,text('hcm_map4.osm · 14.450 nút · 28.563 cạnh có hướng','Caption','secondary'));const fs=append(foot,box('Spacer','HORIZONTAL',100,10));fs.layoutSizingHorizontal='FILL';append(foot,text('© OpenStreetMap contributors','Caption','secondary'));
const ops=append(main,box('Operations · scroll vertically','VERTICAL',368,684));ops.itemSpacing=0;ops.cornerRadius=10;ops.clipsContent=true;ops.overflowDirection='VERTICAL';border(ops);
function title(label){const s=append(ops,record(section.createInstance()));s.findOne(x=>x.type==='TEXT').characters=label;return s;}
title('Điều hành đội xe');
const controls=append(ops,box('Simulation controls','VERTICAL',368,112));controls.paddingLeft=controls.paddingRight=16;
for(const labels of [['Bắt đầu','Tạm dừng'],['Tiếp tục','Đặt lại']]){const line=append(controls,box('Buttons','HORIZONTAL',336,42));for(const l of labels)append(line,btn(l,false,164));}
for(let i=1;i<=6;i++){const r=append(ops,record(row.createInstance()));r.resize(368,46);r.paddingLeft=r.paddingRight=16;r.findAllWithCriteria({types:['TEXT']})[0].characters='● Xe '+i;}
title('Báo cáo sự cố giao thông');
const incident=append(ops,box('Incident controls','VERTICAL',368,214));pad(incident,16);append(incident,text('Tuyến đường hoặc xe đang di chuyển','Label','secondary'));append(incident,btn('Chọn đoạn đường…',false,336));append(incident,btn('Kẹt xe (thời gian ×3)',false,336));append(incident,btn('Ghi nhận báo cáo',true,336));
title('Tái tối ưu tự động');const optimize=append(ops,box('Reoptimization','VERTICAL',368,112));pad(optimize,16);append(optimize,text('3 xe đổi tuyến · Giảm 80,6 giây','Label','teal'));append(optimize,btn('Tái tối ưu',false,336));
title('Các tuyến đường');const orders=['0 → 2 → 1 → 15 → 9 → 0','0 → 19 → 11 → 12 → 8 → 0','0 → 24 → 7 → 10 → 16 → 0','0 → 5 → 4 → 21 → 3 → 0','0 → 20 → 22 → 6 → 23 → 0','0 → 14 → 17 → 18 → 13 → 0'];for(let i=0;i<6;i++){const r=append(ops,record(route.createInstance()));r.resize(368,60);r.paddingLeft=16;const ts=r.findAllWithCriteria({types:['TEXT']});ts[0].characters=`Tuyến ${i+1} · 4 khách`;ts[1].characters=orders[i];}
for(const label of ['Điểm giao thoa mạng lưới','Thông tin vị trí','Kết quả tối ưu ban đầu','Bảng thông số hệ thống tối ưu','So sánh hiệu quả (Trước/Sau)','Cách hệ thống xử lý']){title(label);const b=append(ops,box(label+' / existing content','VERTICAL',368,56));pad(b,16);append(b,text('Nội dung hiện có · cuộn để xem chi tiết','Caption','secondary'));}
const library=box('SOPTIX / Components','VERTICAL',1480,760,'background');library.x=1740;library.y=100;pad(library,24);library.itemSpacing=16;for(const c of [header,kpi,section,button,badge,row,route])append(library,c);
figma.viewport.scrollAndZoomIntoView([root]);
return {frameId:root.id,operationsId:ops.id,componentIds:[header,kpi,section,button,badge,row,route].map(n=>n.id),createdNodeIds:made,collectionId:collection.id,tokenIds:Object.values(tokens).map(v=>v.id),dimensions:{width:root.width,height:root.height},note:'Proposed visual direction. Existing completed demo snapshot, not invented KPI data. Production files unchanged.'};
