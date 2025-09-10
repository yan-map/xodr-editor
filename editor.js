// Custom lightweight axis editor without Mapbox Draw
// Modes: idle | draw | select | edit

import { fc, offsetPolyline, toPolygon, toLineString } from './xodr/geometry.js';

let map = null; // will be assigned from window.XODR_MAP

const roadsById = new Map(); // id -> Feature<LineString>
let roadIndex = null; // geojson-rbush index
let intersections = [];
let snapSegments = []; // smoothed centerline segments used for snapping

// Derived road segments (split by intersections). Recomputed on changes
// We don't persist them; we rebuild and render into XODR-like layers via index.js helper

let mode = 'idle';
let selectEnabled = false; // toggled by Edit Axis button
let activeId = null;
let drawingCoords = []; // while drawing
let dragging = { on: false, kind: null, index: -1 }; // kind: 'vertex'
let hoverRoadId = null;
let snapPx = 10;           // segment snapping px
let snapVertexPx = 16;     // vertex snapping px (priority)
let overVertex = false;
let editBtnEl = null; // reference to Edit Axis button for UI text updates
let selectedVertexIdx = -1;
const historyEdit = []; // stack of { type:'edit'|'deleteVertex', id, prevCoords }
let dragPrevCoords = null;
const roundingByAxis = new Map(); // axisId -> { [vertexIndex]: k in [0,1] }
const radiusOffsetPx = 12; // visual offset so handle never overlaps vertex when radius=0
let radiusLabelError = { axisId: null, idx: -1, until: 0 };
let radiusEditorEl = null; // DOM input for inline editing
let radiusEditorCtx = null; // { axisId, idx }
let _realtimeTimer = null;
const importedAxisIds = new Set(); // axes restored from import to avoid overlay duplication

// Utility
const nextId = (()=>{ let n=0; return ()=>`axis_${++n}`; })();
const asPoint = (xy) => ({ type:'Feature', geometry:{ type:'Point', coordinates: xy }, properties:{} });

function ensureSources() {
  if (!map.getSource('axis-roads')) {
    map.addSource('axis-roads', { type: 'geojson', data: fc() });
    map.addLayer({ id:'axis-roads', type:'line', source:'axis-roads', paint:{ 'line-color':'#444', 'line-width':2.5, 'line-opacity':0.85 } });
  }
  if (!map.getSource('axis-roads-active')) {
    map.addSource('axis-roads-active', { type: 'geojson', data: fc() });
    map.addLayer({ id:'axis-roads-active', type:'line', source:'axis-roads-active', paint:{ 'line-color':'#2f7ef3', 'line-width':3.0, 'line-opacity':0.9 } });
  }
  if (!map.getSource('axis-verts')) {
    map.addSource('axis-verts', { type: 'geojson', data: fc() });
    map.addLayer({ id:'axis-verts', type:'circle', source:'axis-verts', paint:{ 'circle-radius':6, 'circle-color':'#ff6b00', 'circle-stroke-color':'#fff', 'circle-stroke-width':1 } });
  }
  if (!map.getSource('axis-vert-selected')) {
    map.addSource('axis-vert-selected', { type: 'geojson', data: fc() });
    map.addLayer({ id:'axis-vert-selected', type:'circle', source:'axis-vert-selected', paint:{ 'circle-radius':9, 'circle-color':'#ff6b00', 'circle-stroke-color':'#111', 'circle-stroke-width':2, 'circle-opacity':0.95 } });
  }
  if (!map.getSource('axis-midverts')) {
    map.addSource('axis-midverts', { type: 'geojson', data: fc() });
    map.addLayer({ id:'axis-midverts', type:'circle', source:'axis-midverts', paint:{ 'circle-radius':3, 'circle-color':'#2f7ef3', 'circle-stroke-color':'#fff', 'circle-stroke-width':1, 'circle-opacity':0.8 } });
  }
  if (!map.getSource('axis-radius')) {
    map.addSource('axis-radius', { type: 'geojson', data: fc() });
    map.addLayer({ id:'axis-radius', type:'circle', source:'axis-radius', paint:{ 'circle-radius':5, 'circle-color':'#8b5cf6', 'circle-stroke-color':'#fff', 'circle-stroke-width':1.5, 'circle-opacity':0.95 } });
    try { map.moveLayer('axis-radius'); } catch {}
  }
  if (!map.getSource('axis-radius-labels')) {
    map.addSource('axis-radius-labels', { type: 'geojson', data: fc() });
    map.addLayer({ id:'axis-radius-labels', type:'symbol', source:'axis-radius-labels', layout:{ 'text-field':['get','text'], 'text-size':12, 'text-font':['DIN Offc Pro Medium','Arial Unicode MS Regular'], 'text-rotate':['get','angle'], 'text-allow-overlap': true, 'text-anchor':['get','anchor'], 'text-offset':[0.1,0] }, paint:{ 'text-color':['case',['get','error'],'#ff2d2d','#111111'], 'text-halo-color':'#ffffff', 'text-halo-width':1 } });
    try { map.moveLayer('axis-radius-labels'); } catch {}
  }
  if (!map.getSource('axis-preview')) {
    map.addSource('axis-preview', { type: 'geojson', data: fc() });
    map.addLayer({ id:'axis-preview', type:'line', source:'axis-preview', paint:{ 'line-color':'#2f7ef3', 'line-width':2, 'line-dasharray':[1,1], 'line-opacity':0.7 } });
  }
  if (!map.getSource('axis-hover')) {
    map.addSource('axis-hover', { type: 'geojson', data: fc() });
    map.addLayer({ id:'axis-hover', type:'line', source:'axis-hover', paint:{ 'line-color':'#2f7ef3', 'line-width':14, 'line-opacity':0.15 } });
  }
  if (!map.getSource('axis-hit')) {
    map.addSource('axis-hit', { type: 'geojson', data: fc() });
    map.addLayer({ id:'axis-hit', type:'line', source:'axis-hit', paint:{ 'line-color':'#000', 'line-width':20, 'line-opacity':0 }, layout:{ 'line-cap':'round' } });
  }
  if (!map.getSource('axis-intersections')) {
    map.addSource('axis-intersections', { type:'geojson', data: fc() });
    map.addLayer({ id:'axis-intersections', type:'circle', source:'axis-intersections', paint:{ 'circle-radius':8, 'circle-opacity':0.5,  'circle-color':'#ff3d00', 'circle-stroke-color':'#fff', 'circle-stroke-width':1 } });
  }
}

function rebuildIndex() {
  try { roadIndex = (window.geojsonRbush && window.geojsonRbush()) || (window.GeoJSONRBush && window.GeoJSONRBush()) || null; } catch { roadIndex = null; }
  if (!roadIndex) return;
  const feats = Array.from(roadsById.values()).map(f=>JSON.parse(JSON.stringify(f)));
  for (const f of feats) { try { f.bbox = turf.bbox(f); roadIndex.insert(f); } catch {} }
}

function refreshSources() {
  const all = Array.from(roadsById.values());
  if (map.getSource('axis-roads')) { map.getSource('axis-roads').setData(fc(all)); try { map.setLayoutProperty('axis-roads','visibility','visible'); } catch {} }
  // active
  const act = activeId ? [roadsById.get(activeId)].filter(Boolean) : [];
  if (map.getSource('axis-roads-active')) { map.getSource('axis-roads-active').setData(fc(act)); try { map.setLayoutProperty('axis-roads-active','visibility','visible'); } catch {} }
  // hit and hover use all
  if (map.getSource('axis-hit')) { map.getSource('axis-hit').setData(fc(all)); try { map.setLayoutProperty('axis-hit','visibility','visible'); } catch {} }
  try { console.log('[editor] refreshSources: axes on map =', all.length); } catch {}
}

function setPreviewPath(coords) {
  if (!coords || coords.length < 2) { try { map.getSource('axis-preview').setData(fc()); } catch {} return; }
  const line = { type:'Feature', geometry:{ type:'LineString', coordinates: coords }, properties:{} };
  try { map.getSource('axis-preview').setData(fc([line])); } catch {}
}

function setActiveHandles(coords) {
  // Ensure sources exist in case ensureSources ran before these were added
  try { ensureSources(); } catch {}
  const pts = (coords||[]).map(c => asPoint(c));
  try { map.getSource('axis-verts').setData(fc(pts)); } catch {}
  // midpoints
  const mids = [];
  for (let i=0;i<coords.length-1;i++) {
    const c0 = coords[i], c1 = coords[i+1];
    const m = [(c0[0]+c1[0])/2, (c0[1]+c1[1])/2];
    mids.push(asPoint(m));
  }
  try { map.getSource('axis-midverts').setData(fc(mids)); } catch {}
  // selected vertex marker
  try {
    if (selectedVertexIdx>=0 && coords && coords[selectedVertexIdx]) {
      map.getSource('axis-vert-selected').setData(fc([asPoint(coords[selectedVertexIdx])]));
    } else {
      map.getSource('axis-vert-selected').setData(fc());
    }
  } catch {}
  // radius handles for internal vertices when editing a specific axis
  try {
    const handles = [];
    const labels = [];
    // Show radius handle ONLY when a single internal vertex is selected
    const hasSelection = (mode==='edit' && activeId && Array.isArray(coords) && coords.length>2 && selectedVertexIdx>=1 && selectedVertexIdx<=coords.length-2);
    if (!hasSelection) {
      if (map.getSource('axis-radius')) map.getSource('axis-radius').setData(fc());
      if (map.getSource('axis-radius-labels')) map.getSource('axis-radius-labels').setData(fc());
      return;
    }
    if (hasSelection) {
      const toPx = (ll)=>map.project({lng:ll[0],lat:ll[1]});
      const toLL = (p)=>{ const u=map.unproject({x:p.x,y:p.y}); return [u.lng,u.lat]; };
      const sub=(a,b)=>({x:a.x-b.x,y:a.y-b.y});
      const len=(v)=>Math.hypot(v.x,v.y);
      const norm=(v)=>{ const L=len(v); return L>1e-9?{x:v.x/L,y:v.y/L}:{x:0,y:0}; };
      const i0 = selectedVertexIdx;
      const start = i0; // only selected
      console.log('[editor] setActiveHandles: activeId=', activeId, 'selectedVertexIdx=', selectedVertexIdx, 'coordsLen=', coords.length, 'startIdx=', start);
      for (let i=start;i<=start;i++){
        const P0 = toPx(coords[i-1]);
        const P1 = toPx(coords[i]);
        const P2 = toPx(coords[i+1]);
        const v0 = norm(sub(P1,P0));
        const v1 = norm(sub(P2,P1));
        const c = v0.x*v1.x + v0.y*v1.y;
        const alpha = Math.acos(Math.max(-1,Math.min(1,c)));
        if (!isFinite(alpha)) continue;
        const Lprev = len(sub(P1,P0));
        const Lnext = len(sub(P2,P1));
        const minLen = Math.min(Lprev, Lnext);
        const tanHalfRaw = Math.tan(alpha/2);
        const tanHalf = (isFinite(tanHalfRaw) ? tanHalfRaw : 0);
        const k = getRoundK(activeId, i);
        const t_goal = (alpha > 1e-6) ? ((k * minLen / alpha) * Math.max(1e-6, tanHalf)) : 0; // safe when alpha≈0
        // neighbor-aware constraint: do not overlap with adjacent arcs/vertices
        const t_prevN = (i-1>=1) ? tangentLengthAt(coords, i-1, activeId) : 0;
        const t_nextN = (i+1<=coords.length-2) ? tangentLengthAt(coords, i+1, activeId) : 0;
        const t_max_adj = Math.max(0, Math.min(Lprev - t_prevN, Lnext - t_nextN));
        const t_max_base = 0.49*minLen;
        const t_max = Math.max(0, Math.min(t_max_base, t_max_adj));
        const t = Math.max(0, Math.min(t_goal, t_max));
        // bisector of angle between -v0 and v1
        const u0 = {x:-v0.x,y:-v0.y};
        let bis = {x:u0.x+v1.x, y:u0.y+v1.y};
        let Lb = len(bis);
        if (Lb<=1e-9) { bis = { x: -v0.y, y: v0.x }; Lb = len(bis); }
        if (Lb<=1e-9) continue; bis = {x:bis.x/Lb, y:bis.y/Lb};
        const pos = { x: P1.x + bis.x * (radiusOffsetPx + t), y: P1.y + bis.y * (radiusOffsetPx + t) };
        const h = asPoint(toLL(pos));
        h.properties = { kind:'radius', axisId: activeId, idx: i };
        handles.push(h);

        // label: radius R in meters, 1 decimal; placed further along bisector
        const Rpx = t / (Math.abs(tanHalf) > 1e-6 ? tanHalf : 1e-6); // radius in pixels
        const p1ll = toLL(P1);
        const p2 = { x: P1.x + bis.x * Rpx, y: P1.y + bis.y * Rpx };
        const p2ll = toLL(p2);
        let Rm = 0; try { Rm = turf.distance(asPoint(p1ll), asPoint(p2ll), { units:'kilometers' }) * 1000; } catch {}
        const labelDist = radiusOffsetPx + t + 18; // a bit further than handle
        const lp = { x: P1.x + bis.x * labelDist, y: P1.y + bis.y * labelDist };
        let angleDeg = Math.atan2(bis.y, bis.x) * 180 / Math.PI;
        if (angleDeg > 90) angleDeg -= 180; if (angleDeg < -90) angleDeg += 180; // keep text upright
        const lab = asPoint(toLL(lp));
        const err = (radiusLabelError.axisId===activeId && radiusLabelError.idx===i && Date.now()<radiusLabelError.until);
        // max radius in meters from t_max
        const RmaxPx = t_max > 0 ? (t_max / (Math.abs(tanHalf) > 1e-6 ? tanHalf : 1e-6)) : 0; const pMax = { x: P1.x + bis.x * RmaxPx, y: P1.y + bis.y * RmaxPx };
        let RmaxM = 0; try { RmaxM = turf.distance(asPoint(p1ll), asPoint(toLL(pMax)), { units:'kilometers' }) * 1000; } catch {}
        const anchor = (bis.x >= 0 ? 'left' : 'right');
        lab.properties = { kind:'radiusLabel', axisId: activeId, idx: i, text: `R=${(Rm||0).toFixed(1)} m`, angle: angleDeg, error: !!err, maxR: RmaxM, anchor };
        labels.push(lab);
      }
    }
    if (map.getSource('axis-radius')) { map.getSource('axis-radius').setData(fc(handles)); console.log('[editor] radius handles count=', handles.length); }
    if (map.getSource('axis-radius-labels')) { map.getSource('axis-radius-labels').setData(fc(labels)); console.log('[editor] radius labels count=', labels.length); }
  } catch {}
  // Bring editor layers above xodr layers for visibility/interaction
  try {
    const ids = ['axis-hit','axis-hover','axis-roads-active','axis-roads','axis-verts','axis-vert-selected','axis-midverts','axis-radius','axis-radius-labels'];
    for (const id of ids) { if (map.getLayer(id)) map.moveLayer(id); }
  } catch {}
}

function setHoverRoad(id) {
  hoverRoadId = id || null;
  const feat = id ? roadsById.get(id) : null;
  try { map.getSource('axis-hover').setData(fc(feat ? [feat] : [])); } catch {}
}

function setHoverVisible(show) {
  try { map.setLayoutProperty('axis-hover', 'visibility', show ? 'visible' : 'none'); } catch {}
}

function setIntersections(points) {
  intersections = points || [];
  try { map.getSource('axis-intersections').setData(fc(intersections)); } catch {}
}

function neighborsFor(feat) {
  if (!roadIndex) return Array.from(roadsById.values()).filter(f=>f.id!==feat.id);
  try {
    const search = roadIndex.search({ type:'Feature', bbox: turf.bbox(feat), geometry:{ type:'Polygon', coordinates:[] } });
    const ids = new Set((search?.features||[]).map(f=>f.id));
    return Array.from(roadsById.values()).filter(f=>f.id!==feat.id && ids.has(f.id));
  } catch { return Array.from(roadsById.values()).filter(f=>f.id!==feat.id); }
}

// Global recompute of intersections with deduplication and axis grouping
function recomputeIntersectionsAll() {
  const axes = Array.from(roadsById.values());
  const cand = [];
  const pixTol = Math.max(6, snapVertexPx); // cluster radius in px
  const pushPt = (ll, aId, bId) => {
    const f = asPoint(ll);
    f.properties = { kind:'intersection', axes: [aId, bId] };
    cand.push(f);
  };
  // Build smoothed polylines for intersections between real roads
  const smoothMap = new Map();
  for (const a of axes) smoothMap.set(a.id, smoothAxisCoords(a));
  const asLine = (id) => ({ type:'Feature', id, properties:{}, geometry:{ type:'LineString', coordinates: smoothMap.get(id) || (roadsById.get(id)?.geometry?.coordinates)||[] } });

  const checkTouch = (line1, line2) => {
    const c1 = line1.geometry.coordinates || [];
    const c2 = line2.geometry.coordinates || [];
    const endpoints = [c1[0], c1[c1.length-1]];
    for (const ep of endpoints) {
      for (let i=0;i<c2.length-1;i++) {
        const a2=c2[i], b2=c2[i+1];
        const P = map.project({lng:ep[0],lat:ep[1]});
        const A = map.project({lng:a2[0],lat:a2[1]});
        const B = map.project({lng:b2[0],lat:b2[1]});
        const ABx=B.x-A.x, ABy=B.y-A.y; const APx=P.x-A.x, APy=P.y-A.y; const ab2=ABx*ABx+ABy*ABy; if (ab2<1e-6) continue;
        let t=(APx*ABx+APy*ABy)/ab2; t=Math.max(0,Math.min(1,t)); const Px=A.x+t*ABx, Py=A.y+t*ABy;
        const d=Math.hypot(Px-P.x, Py-P.y);
        if (d<=pixTol) { const snapLL = map.unproject({x:Px,y:Py}); pushPt([snapLL.lng, snapLL.lat], line1.id, line2.id); }
      }
    }
  };

  for (let i=0;i<axes.length;i++) {
    for (let j=i+1;j<axes.length;j++) {
      const a = axes[i], b = axes[j];
      const la = asLine(a.id), lb = asLine(b.id);
      try {
        const res = turf.lineIntersect(la, lb);
        const pts = (res?.features||[]);
        for (const pt of pts) pushPt(pt.geometry.coordinates, a.id, b.id);
      } catch {}
      // also endpoint touches
      try { checkTouch(la,lb); checkTouch(lb,la); } catch {}
    }
  }
  // Cluster duplicates
  const clusters = [];
  for (const p of cand) {
    const P = map.project({lng:p.geometry.coordinates[0], lat:p.geometry.coordinates[1]});
    let found = null;
    for (const cl of clusters) {
      const d = Math.hypot(P.x - cl.x, P.y - cl.y);
      if (d <= pixTol) { found = cl; break; }
    }
    if (!found) {
      clusters.push({ x:P.x, y:P.y, pts:[p], axes:new Set(p.properties.axes) });
    } else {
      found.pts.push(p); p.properties.axes.forEach(id=>found.axes.add(id));
      // shift center (running average)
      found.x = (found.x * (found.pts.length-1) + P.x) / found.pts.length;
      found.y = (found.y * (found.pts.length-1) + P.y) / found.pts.length;
    }
  }
  const merged = [];
  for (const cl of clusters) {
    // Prefer any original axis vertex near cluster center
    let bestLL = null, bestD = Infinity;
    for (const ax of axes) {
      const coords = ax.geometry.coordinates||[];
      for (const v of [coords[0], coords[coords.length-1], ...coords]) {
        if (!v) continue;
        const V = map.project({lng:v[0],lat:v[1]});
        const d = Math.hypot(V.x - cl.x, V.y - cl.y);
        if (d < bestD && d <= pixTol) { bestD = d; bestLL = v; }
      }
    }
    let ll = bestLL;
    if (!ll) { const u = map.unproject({x:cl.x,y:cl.y}); ll = [u.lng, u.lat]; }
    const f = asPoint(ll);
    f.properties = { kind:'intersection', axes: Array.from(cl.axes).sort(), roads: [] };
    merged.push(f);
  }
  setIntersections(merged);
}

// --- Rebuild Editor Roads as XODR-like view ---
function rebuildAndRenderEditorRoads() {
  if (!map) return;
  // Recompute intersections globally to avoid duplicates and place at straight meeting points
  try { recomputeIntersectionsAll(); } catch {}
  // Build segments for every axis
  const segLines = [];
  for (const f of roadsById.values()) {
    const smooth = smoothAxisCoords(f);
    const parts = splitAxisByIntersections(f, smooth);
    for (let i=0;i<parts.length;i++) {
      const coords = parts[i];
      if (!coords || coords.length < 2) continue;
      const id = `${f.id}__seg_${i+1}`;
      segLines.push({ type:'Feature', id, properties:{ kind:'roadseg', parentId:f.id, segIndex:i }, geometry:{ type:'LineString', coordinates: coords } });
    }
  }
  // Include drawing preview as unsplit lane if in draw mode
  if (mode==='draw' && drawingCoords && drawingCoords.length>=2) {
    const id = `axis__drawing`;
    segLines.push({ type:'Feature', id, properties:{ kind:'roadseg', parentId:'__drawing__', segIndex:0 }, geometry:{ type:'LineString', coordinates: drawingCoords.slice() } });
  }
  // XODR-like geometry: centerlines = segments; lanes = buffered bands
  const centerFC = fc(segLines);
  // expose smoothed segments for snapping
  snapSegments = segLines.map(s => JSON.parse(JSON.stringify(s)));
  const lanePolys = [];
  const markings = [];
  const edgeLines = [];
  const laneWidth = 3.5; // meters
  // Use projectors from index.js (based on header lat0/lon0 when present)\n  let toLocal = (p)=>p, toWgs = (p)=>p;\n  try {\n    const pr = (window.editorGetProjectors && window.editorGetProjectors());\n    if (pr && pr.toLocal && pr.toWgs) { toLocal = pr.toLocal; toWgs = pr.toWgs; }\n    else {\n      toLocal = ([lng,lat]) => { try { return proj4('WGS84','LOCAL_TAN',[lng,lat]); } catch { return [lng,lat]; } };\n      toWgs = ([x,y]) => { try { return proj4('LOCAL_TAN','WGS84',[x,y]); } catch { return [x,y]; } };\n    }\n  } catch {}\n\n  function samplesFromLineCoords(coords, step=0.7) {(coords, step=0.7) {
    const pts = [];
    if (!coords || coords.length<2) return pts;
    let sCum = 0;
    for (let i=0;i<coords.length-1;i++) {
      const aLL = coords[i], bLL = coords[i+1];
      const a = toLocal(aLL), b = toLocal(bLL);
      const dx=b[0]-a[0], dy=b[1]-a[1];
      const L = Math.hypot(dx,dy); if (!(L>0)) continue;
      const th = Math.atan2(dy,dx);
      const n = Math.max(1, Math.ceil(L/step));
      for (let k=0;k<n;k++) {
        const t = k/n; const x=a[0]+dx*t, y=a[1]+dy*t; pts.push([x,y,th,sCum+L*t]);
      }
      sCum += L;
    }
    // push exact end
    const last = toLocal(coords[coords.length-1]);
    if (pts.length===0 || Math.hypot(pts[pts.length-1][0]-last[0], pts[pts.length-1][1]-last[1])>1e-6) {
      const prev = toLocal(coords[coords.length-2]); const th = Math.atan2(last[1]-prev[1], last[0]-prev[0]);
      const sLast = (pts.length ? pts[pts.length-1][3] : 0);
      pts.push([last[0], last[1], th, sLast]);
    }
    return pts;
  }

  for (const ln of segLines) {
    try {
      const coords = ln.geometry.coordinates || [];
      const samples = samplesFromLineCoords(coords, 0.7);
      if (samples.length<2) continue;
      const pid = ln.properties?.parentId;
      const isImported = pid && importedAxisIds.has(pid);
      const leftOuter = offsetPolyline(samples, laneWidth);
      const leftInner = offsetPolyline(samples, 0);
      const rightOuter = offsetPolyline(samples, -laneWidth);
      const rightInner = offsetPolyline(samples, 0);
      // Skip drawing overlay lanes for axes that were imported (to avoid duplication with base XODR)
      if (!isImported) {
        const leftPoly = toPolygon(leftOuter, leftInner, toWgs, { laneType:'driving' });
        const rightPoly = toPolygon(rightInner, rightOuter, toWgs, { laneType:'driving' });
        leftPoly.id = `${ln.id}__L`; rightPoly.id = `${ln.id}__R`;
        lanePolys.push(leftPoly, rightPoly);
        // center marking
        const centerLine = toLineString(samples, toWgs); centerLine.id = `${ln.id}__mark`; centerLine.properties = { kind:'marking' };
        markings.push(centerLine);
        // outer edges (dark outline)
        const leftEdge = toLineString(leftOuter, toWgs); leftEdge.id = `${ln.id}__edgeL`; leftEdge.properties = { kind:'edge', side:'left' };
        const rightEdge = toLineString(rightOuter, toWgs); rightEdge.id = `${ln.id}__edgeR`; rightEdge.properties = { kind:'edge', side:'right' };
        edgeLines.push(leftEdge, rightEdge);
      }
    } catch {}
  }
  // Attach touching roads for each intersection
  try {
    const tolPx = Math.max(6, snapVertexPx);
    const roadsByTouch = new Map();
    for (const inter of intersections) {
      const P = map.project({lng:inter.geometry.coordinates[0], lat:inter.geometry.coordinates[1]});
      const hit = [];
      for (const seg of segLines) {
        const c = seg.geometry.coordinates||[];
        let ok = false;
        for (let i=0;i<c.length-1 && !ok;i++) {
          const A = map.project({lng:c[i][0],lat:c[i][1]});
          const B = map.project({lng:c[i+1][0],lat:c[i+1][1]});
          const ABx=B.x-A.x, ABy=B.y-A.y; const APx=P.x-A.x, APy=P.y-A.y; const ab2=ABx*ABx+ABy*ABy; if (ab2<1e-6) continue;
          let t=(APx*ABx+APy*ABy)/ab2; t=Math.max(0,Math.min(1,t));
          const X=A.x+t*ABx, Y=A.y+t*ABy; const d=Math.hypot(X-P.x, Y-P.y);
          if (d<=tolPx) ok = true;
        }
        if (ok) hit.push(seg.id);
      }
      roadsByTouch.set(inter, hit);
    }
    // update intersection properties with roads
    const upd = intersections.map(p => { const c = JSON.parse(JSON.stringify(p)); c.properties = Object.assign({}, c.properties||{}, { roads: roadsByTouch.get(p)||[] }); return c; });
    setIntersections(upd);
  } catch {}

  const geo = { centerlines: centerFC, lanes: fc(lanePolys), markings: fc(markings), sidewalks: fc(), edges: fc(edgeLines), intersection: fc() };
  try { if (window.applyEditorXodr) window.applyEditorXodr(geo); } catch {}
}

function splitAxisByIntersections(feat, coordsOverride) {
  const coords = (coordsOverride && coordsOverride.length ? coordsOverride : (feat?.geometry?.coordinates)||[]);
  if (!coords || coords.length < 2) return [];
  // Build anchors: endpoints + all intersection snaps on this axis
  const anchors = [];
  // precompute cumulative pixel lengths per segment
  const cum = [0];
  for (let i=0;i<coords.length-1;i++) {
    const A = map.project({lng:coords[i][0],lat:coords[i][1]});
    const B = map.project({lng:coords[i+1][0],lat:coords[i+1][1]});
    const d = Math.hypot(B.x-A.x, B.y-A.y);
    cum.push(cum[cum.length-1] + d);
  }
  const total = cum[cum.length-1] || 0;
  const pushAnchor = (seg, t, xy) => {
    const sParam = (seg>=0 && seg<cum.length ? cum[seg] : 0) + (seg < cum.length-1 ? t * (cum[seg+1]-cum[seg]) : 0);
    anchors.push({ seg, t: Math.max(0,Math.min(1,t)), s: Math.max(0,Math.min(total,sParam)), coord: xy });
  };
  // endpoints
  pushAnchor(0, 0, coords[0]);
  pushAnchor(coords.length-2, 1, coords[coords.length-1]);
  // intersections on this axis (from global recompute over smoothed roads)
  const pts = intersections.filter(p => Array.isArray(p?.properties?.axes) && p.properties.axes.includes(feat.id));
  const projectOnSegPx = (a, b, P) => {
    const A = map.project({lng:a[0],lat:a[1]});
    const B = map.project({lng:b[0],lat:b[1]});
    const APx=P.x-A.x, APy=P.y-A.y; const ABx=B.x-A.x, ABy=B.y-A.y; const ab2=ABx*ABx+ABy*ABy; if (ab2<1e-9) return { t:0, d:Infinity };
    let t=(APx*ABx+APy*ABy)/ab2; t=Math.max(0,Math.min(1,t));
    const Px=A.x+t*ABx, Py=A.y+t*ABy; const d=Math.hypot(Px-P.x, Py-P.y);
    const ll = map.unproject({x:Px,y:Py});
    return { t, d, coord:[ll.lng, ll.lat] };
  };
  for (const p of pts) {
    const P = map.project({lng:p.geometry.coordinates[0], lat:p.geometry.coordinates[1]});
    let best = { d: Infinity, seg: -1, t: 0, coord: null };
    for (let i=0;i<coords.length-1;i++) {
      const pr = projectOnSegPx(coords[i], coords[i+1], P);
      if (pr.d < best.d) best = { d: pr.d, seg: i, t: pr.t, coord: pr.coord };
    }
    if (best.seg>=0 && best.coord) pushAnchor(best.seg, best.t, best.coord);
  }
  // sort & dedup anchors by s
  anchors.sort((a,b)=>a.s-b.s);
  const uniq = [];
  for (const a of anchors) {
    if (!uniq.length || Math.abs(a.s - uniq[uniq.length-1].s) > 1e-6) uniq.push(a);
  }
  if (uniq.length < 2) return [];
  // build segments
  const out = [];
  for (let i=0;i<uniq.length-1;i++) {
    const A = uniq[i], B = uniq[i+1];
    if (B.s <= A.s + 1e-9) continue;
    const seg = [];
    // start point
    seg.push(A.coord);
    // intermediate vertices
    if (A.seg === B.seg) {
      // same segment -> direct
    } else {
      for (let k=A.seg+1; k<=B.seg; k++) seg.push(coords[k]);
    }
    // ensure end point
    const last = seg[seg.length-1];
    if (!last || last[0]!==B.coord[0] || last[1]!==B.coord[1]) seg.push(B.coord);
    if (seg.length>=2) out.push(seg);
  }
  return out;
}

// Round internal vertices by inserting circular arcs in screen space and converting back to lng/lat
function smoothAxisCoords(feat) {
  const coords = (feat?.geometry?.coordinates)||[];
  if (coords.length <= 2) return coords.slice();
  const toPx = (ll) => map.project({ lng: ll[0], lat: ll[1] });
  const toLL = (p) => { const ll = map.unproject({ x: p.x, y: p.y }); return [ll.lng, ll.lat]; };
  const sub = (a,b) => ({ x:a.x-b.x, y:a.y-b.y });
  const add = (a,b) => ({ x:a.x+b.x, y:a.y+b.y });
  const mul = (a,k) => ({ x:a.x*k, y:a.y*k });
  const len = (v) => Math.hypot(v.x, v.y);
  const norm = (v) => { const L=len(v); return L>1e-9?{x:v.x/L,y:v.y/L}:{x:0,y:0}; };
  const leftN = (v) => ({ x: -v.y, y: v.x });
  const dot = (a,b) => a.x*b.x + a.y*b.y;
  const crossZ = (a,b) => a.x*b.y - a.y*b.x;

  const px = coords.map(toPx);
  const out = [];
  out.push(toLL(px[0]));
  for (let i=1;i<px.length-1;i++) {
    const P0 = px[i-1], P1 = px[i], P2 = px[i+1];
    const v0 = norm(sub(P1, P0));
    const v1 = norm(sub(P2, P1));
    const l1 = len(sub(P1, P0));
    const l2 = len(sub(P2, P1));
    const c = dot(v0, v1);
    const alpha = Math.acos(Math.max(-1, Math.min(1, c)));
    const turn = Math.sign(crossZ(v0, v1)); // +1 left, -1 right, 0 straight
    if (!isFinite(alpha) || alpha < 1e-3 || turn === 0) {
      // straight or degenerate; keep vertex
      out.push(toLL(P1));
      continue;
    }
    // per-vertex factor k in [0,1], default 1
    const k = getRoundK(feat.id, i);
    // target arc length (pixels)
    const Ltarget = Math.max(0, Math.min(1, k)) * Math.min(l1, l2);
    // avoid excessive offsets near 180 deg
    const tanHalf = Math.tan(alpha / 2);
    if (!isFinite(tanHalf) || tanHalf <= 1e-6) { out.push(toLL(P1)); continue; }
    const R_by_len = Ltarget / alpha;
    const t_goal = R_by_len * tanHalf;
    // neighbor-aware limit so tangency points don't overlap
    const t_prevN = (i-1>=1) ? tangentLengthAtLL(feat.id, feat.geometry.coordinates, i-1) : 0;
    const t_nextN = (i+1<=px.length-2) ? tangentLengthAtLL(feat.id, feat.geometry.coordinates, i+1) : 0;
    const t_max_adj = Math.max(0, Math.min(l1 - t_prevN, l2 - t_nextN));
    const t_max_base = 0.49 * Math.min(l1, l2);
    const t_max = Math.max(0, Math.min(t_max_base, t_max_adj));
    const t = Math.max(1.0, Math.min(t_goal, t_max));
    const R = t / tanHalf;
    // tangent points
    const T1 = add(P1, mul(v0, -t));
    const T2 = add(P1, mul(v1,  t));
    // center from both tangents (should match); use average for robustness
    const n0 = leftN(v0);
    const n1 = leftN(v1);
    const C1 = add(T1, mul(n0, turn * R));
    const C2 = add(T2, mul(n1, turn * R));
    const C = mul(add(C1, C2), 0.5);
    // angles
    const a1 = Math.atan2(T1.y - C.y, T1.x - C.x);
    const a2 = Math.atan2(T2.y - C.y, T2.x - C.x);
    let start = a1, end = a2;
    if (turn > 0) { // CCW
      while (end < start) end += Math.PI*2;
    } else { // CW
      while (end > start) end -= Math.PI*2;
    }
    const sArc = Math.abs((end - start) * R);
    const segLen = 8; // px target chord length
    const steps = Math.max(2, Math.ceil(sArc / segLen));
    // ensure we have straight from previous kept point to T1
    out.push(toLL(T1));
    for (let k=1;k<steps;k++) {
      const ttheta = start + (end - start) * (k/steps);
      const pt = { x: C.x + R * Math.cos(ttheta), y: C.y + R * Math.sin(ttheta) };
      out.push(toLL(pt));
    }
    out.push(toLL(T2));
  }
  out.push(toLL(px[px.length-1]));
  return out;
}

function scheduleRealtimeRebuild(delay=40) {
  try { if (_realtimeTimer) return; } catch {}
  _realtimeTimer = setTimeout(() => { _realtimeTimer = null; try { rebuildAndRenderEditorRoads(); } catch {} }, delay);
}

function getRoundK(axisId, idx){
  const m = roundingByAxis.get(axisId);
  const v = m && m[idx];
  return (typeof v === 'number' && isFinite(v)) ? v : 1; // default full rounding
}
function setRoundK(axisId, idx, k){
  let m = roundingByAxis.get(axisId);
  if (!m) { m = {}; roundingByAxis.set(axisId, m); }
  m[idx] = Math.max(0, Math.min(1, Number(k)||0));
}

// tangent length t for vertex idx on given axis coords (lng/lat array), using stored k of that axis.
function tangentLengthAt(coords, idx, axisId){
  if (idx<=0 || idx>=coords.length-1) return 0;
  const toPx = (ll)=>map.project({lng:ll[0],lat:ll[1]});
  const sub=(a,b)=>({x:a.x-b.x,y:a.y-b.y});
  const len=(v)=>Math.hypot(v.x,v.y);
  const norm=(v)=>{ const L=len(v); return L>1e-9?{x:v.x/L,y:v.y/L}:{x:0,y:0}; };
  const P0 = toPx(coords[idx-1]);
  const P1 = toPx(coords[idx]);
  const P2 = toPx(coords[idx+1]);
  const v0 = norm(sub(P1,P0));
  const v1 = norm(sub(P2,P1));
  const c = v0.x*v1.x + v0.y*v1.y;
  const alpha = Math.acos(Math.max(-1,Math.min(1,c)));
  if (!(alpha>1e-3)) return 0;
  const tanHalf = Math.tan(alpha/2); if (!(tanHalf>1e-6)) return 0;
  const Lprev = len(sub(P1,P0)), Lnext = len(sub(P2,P1));
  const minLen = Math.min(Lprev, Lnext);
  const k = getRoundK(axisId||'', idx);
  const t_goal = (Math.max(0,Math.min(1,k)) * minLen / alpha) * tanHalf;
  const t_max_base = 0.49*minLen;
  return Math.max(0, Math.min(t_goal, t_max_base));
}

// Variant that takes axis id and the authoritative axis coordinates (not smoothed)
function tangentLengthAtLL(axisId, axisCoordsLL, idx){
  return tangentLengthAt(axisCoordsLL, idx, axisId);
}

// Snapping in screen pixels
function snapLngLatPixelPriority(lngLat, segTolPx = snapPx, vtxTolPx = snapVertexPx) {
  const mouse = map.project(lngLat);
  let best = null; // { lngLat, dist, kind }

  function scorePoint(coord) {
    const p = map.project(coord);
    const d = Math.hypot(p.x - mouse.x, p.y - mouse.y);
    if (d <= vtxTolPx && (!best || d < best.dist)) best = { lngLat: coord, dist: d, kind:'vertex' };
  }

  // intersections and vertices (prefer global intersections)
  for (const f of intersections) scorePoint(f.geometry.coordinates);
  // vertices from smoothed road segments
  for (const r of snapSegments) {
    if ((r.properties?.parentId) === activeId) continue; // don't snap to the road being edited
    const coords = r.geometry.coordinates || [];
    for (let i=0;i<coords.length;i++) scorePoint(coords[i]);
  }
  if (best) return best.lngLat; // vertex has priority

  // segments (nearest point)
  for (const r of snapSegments) {
    if ((r.properties?.parentId) === activeId) continue; // don't snap to active road's own segments
    const coords = r.geometry.coordinates || [];
    for (let i=0;i<coords.length-1;i++) {
      const a = coords[i], b = coords[i+1];
      const A = map.project(a), B = map.project(b);
      const ABx = B.x - A.x, ABy = B.y - A.y;
      const APx = mouse.x - A.x, APy = mouse.y - A.y;
      const ab2 = ABx*ABx + ABy*ABy;
      if (ab2 <= 1e-6) continue;
      let t = (APx*ABx + APy*ABy)/ab2; t = Math.max(0, Math.min(1, t));
      const Px = A.x + t*ABx, Py = A.y + t*ABy;
      const d = Math.hypot(Px - mouse.x, Py - mouse.y);
      if (d <= segTolPx && (!best || d < best.dist)) {
        // Refine using turf.nearestPointOnLine in geographic space to hit the exact line
        let lngLatRef = null;
        try {
          const line = { type:'Feature', geometry:{ type:'LineString', coordinates: [a,b] }, properties:{} };
          const npl = turf.nearestPointOnLine(line, asPoint([lngLat.lng||lngLat[0], lngLat.lat||lngLat[1]]));
          if (npl && npl.geometry && Array.isArray(npl.geometry.coordinates)) lngLatRef = npl.geometry.coordinates;
        } catch {}
        if (!lngLatRef) {
          const ll = map.unproject({ x: Px, y: Py });
          lngLatRef = [ll.lng, ll.lat];
        }
        best = { lngLat: lngLatRef, dist: d, kind:'segment' };
      }
    }
  }
  return best ? best.lngLat : [lngLat.lng || lngLat[0], lngLat.lat || lngLat[1]];
}

function finishDrawing() {
  if (drawingCoords.length < 2) { cancelDrawing(); return; }
  const id = nextId();
  const feat = { type:'Feature', id, properties:{ id }, geometry:{ type:'LineString', coordinates: drawingCoords.slice() } };
  roadsById.set(id, feat);
  // no edit history; draw undo handled in draw mode by popping points
  rebuildIndex();
  activeId = id; mode = 'edit';
  drawingCoords = [];
  refreshSources();
  setActiveHandles(roadsById.get(activeId).geometry.coordinates);
  setPreviewPath([]);
  try { rebuildAndRenderEditorRoads(); } catch {}
  // reset cursor and double-click zoom
  try { map.getCanvas().style.cursor=''; } catch {}
  try { map.doubleClickZoom.enable(); } catch {}
}

function cancelDrawing() {
  drawingCoords = []; mode = selectEnabled ? 'select' : 'idle'; activeId = null;
  setPreviewPath([]); setActiveHandles([]);
  refreshSources();
}

function enterSelectMode() { mode = 'select'; activeId = null; setActiveHandles([]); setPreviewPath([]); setHoverVisible(true); refreshSources(); }
function enterEdit(id) { activeId = id; mode='edit'; selectedVertexIdx = -1; setHoverRoad(null); setHoverVisible(false); setActiveHandles(roadsById.get(id).geometry.coordinates); refreshSources(); }
function exitEdit() {
  console.log('[editor] exitEdit');
  activeId=null; mode= selectEnabled ? 'select' : 'idle'; setActiveHandles([]); setHoverRoad(null); setHoverVisible(selectEnabled); refreshSources();
  try { map.dragPan.enable(); } catch {}
}

function handleDrawClick(e) {
  const lngLat = [e.lngLat.lng, e.lngLat.lat];
  const snapped = snapLngLatPixelPriority(lngLat, snapPx, snapVertexPx);
  if (drawingCoords.length === 0) {
    drawingCoords.push(snapped);
    // no handles in draw mode
  } else {
    // If clicked near last vertex -> finish
    const last = drawingCoords[drawingCoords.length-1];
    const p = map.project(snapped), q = map.project(last);
    if (Math.hypot(p.x-q.x, p.y-q.y) <= Math.max(8, snapPx)) { finishDrawing(); return; }
    drawingCoords.push(snapped);
    // no handles in draw mode
  }
}

function handleEditClick(e) {
  const pt = [e.lngLat.lng, e.lngLat.lat];
  const coords = (roadsById.get(activeId)?.geometry.coordinates)||[];
  // Click on midpoint -> insert
  const mids = [];
  for (let i=0;i<coords.length-1;i++) { const m=[(coords[i][0]+coords[i+1][0])/2,(coords[i][1]+coords[i+1][1])/2]; mids.push({ m, i }); }
  const mpx = map.project(pt);
  let insertAt = -1;
  for (const {m,i} of mids) { const mp=map.project(m); if (Math.hypot(mp.x-mpx.x, mp.y-mpx.y) <= 8) { insertAt=i+1; break; } }
  if (insertAt>=0) {
    const snapped = snapLngLatPixelPriority(pt, snapPx, snapVertexPx);
    coords.splice(insertAt, 0, snapped);
    roadsById.get(activeId).geometry.coordinates = coords;
    historyEdit.push({ type:'edit', id: activeId, prevCoords: coords.map(c=>[c[0],c[1]]) });
    rebuildIndex();
    setActiveHandles(coords); refreshSources();
    return;
  }
  // Click outside editable layers -> exit edit
  const hits = map.queryRenderedFeatures(e.point, { layers:['axis-roads-active','axis-verts','axis-midverts','axis-radius','axis-radius-labels'] });
  if (!hits || hits.length===0) { exitEdit(); return; }
}

function handleEditDragMove(e) {
  if (!dragging.on || dragging.index<0) { return; }
  if (dragging.kind === 'radius') { handleRadiusDragMove(e); return; }
  const coords = roadsById.get(activeId).geometry.coordinates;
  const mouseLL = [e.lngLat.lng, e.lngLat.lat];
  const mousePx = map.project({ lng: mouseLL[0], lat: mouseLL[1] });

  const hysteresis = snapPx + 4; // px
  const projectOnSegPx = (road, si, ptPx) => {
    const c = road.geometry.coordinates; const a=c[si], b=c[si+1];
    const A = map.project({lng:a[0],lat:a[1]}), B = map.project({lng:b[0],lat:b[1]});
    const ABx=B.x-A.x, ABy=B.y-A.y; const APx=ptPx.x-A.x, APy=ptPx.y-A.y; const ab2=ABx*ABx+ABy*ABy; if (ab2<1e-6) return null;
    let t=(APx*ABx+APy*ABy)/ab2; t=Math.max(0,Math.min(1,t)); const Px=A.x+t*ABx, Py=A.y+t*ABy; const d=Math.hypot(Px-ptPx.x, Py-ptPx.y);
    const pll = map.unproject({x:Px,y:Py});
    return { lngLat:[pll.lng, pll.lat], distPx:d };
  };

  let out = mouseLL;
  let pinned = false;
  if (window.dragSnap && window.dragSnap.type==='segment') {
    const seg = snapSegments.find(s => s.id === window.dragSnap.roadId);
    if (seg && seg.geometry && seg.geometry.coordinates && seg.geometry.coordinates[window.dragSnap.segIndex+1]) {
      const proj = projectOnSegPx(seg, window.dragSnap.segIndex, mousePx);
      if (proj && proj.distPx <= hysteresis) { out = proj.lngLat; pinned = true; }
      else { window.dragSnap = null; }
    } else { window.dragSnap = null; }
  }
  if (!pinned) {
    // vertex first
    const vtx = snapLngLatPixelPriority(mouseLL, 0, snapVertexPx);
    const vtxSame = (vtx[0]===mouseLL[0] && vtx[1]===mouseLL[1]);
    if (!vtxSame) {
      out = vtx; window.dragSnap = { type:'vertex' };
    } else {
      // search nearest segment and pin
      let best = { d: Infinity, roadId:null, segIndex:-1, ll:null };
      for (const r of snapSegments) {
        if ((r.properties?.parentId)===activeId) continue;
        const c = r.geometry.coordinates||[];
        for (let i=0;i<c.length-1;i++) {
          const pr = projectOnSegPx(r, i, mousePx); if (!pr) continue;
          if (pr.distPx < best.d) { best = { d: pr.distPx, roadId: r.id, segIndex: i, ll: pr.lngLat }; }
        }
      }
      if (best.d <= snapPx) { out = best.ll; window.dragSnap = { type:'segment', roadId: best.roadId, segIndex: best.segIndex }; }
    }
  }

  coords[dragging.index] = out;
  roadsById.get(activeId).geometry.coordinates = coords;
  refreshSources(); setActiveHandles(coords);
  rebuildIndex();
  scheduleRealtimeRebuild(30);
}

function handleRadiusMouseDown(e) {
  if (mode !== 'edit' || !activeId) return;
  const feat = (e.features && e.features[0]) || null;
  const idx = feat && feat.properties && Number(feat.properties.idx);
  if (!Number.isInteger(idx)) return;
  dragging = { on: true, kind: 'radius', index: idx };
  try { e.preventDefault(); e.originalEvent && e.originalEvent.preventDefault && e.originalEvent.preventDefault(); e.originalEvent && e.originalEvent.stopPropagation && e.originalEvent.stopPropagation(); } catch {}
  try { map.dragPan.disable(); } catch {}
  try { map.getCanvas().style.cursor='grabbing'; } catch {}
}

function handleRadiusDragMove(e) {
  if (!(dragging.on && dragging.kind==='radius' && activeId)) return;
  const coords = (roadsById.get(activeId)?.geometry.coordinates)||[];
  const i = dragging.index;
  if (i<=0 || i>=coords.length-1) return;
  const toPx = (ll)=>map.project({lng:ll[0],lat:ll[1]});
  const P0 = toPx(coords[i-1]);
  const P1 = toPx(coords[i]);
  const P2 = toPx(coords[i+1]);
  const sub=(a,b)=>({x:a.x-b.x,y:a.y-b.y});
  const len=(v)=>Math.hypot(v.x,v.y);
  const norm=(v)=>{ const L=len(v); return L>1e-9?{x:v.x/L,y:v.y/L}:{x:0,y:0}; };
  const v0 = norm(sub(P1,P0));
  const v1 = norm(sub(P2,P1));
  const u0 = {x:-v0.x,y:-v0.y};
  let bis = {x:u0.x+v1.x, y:u0.y+v1.y};
  const Lb = len(bis); if (Lb<=1e-9) return; bis = {x:bis.x/Lb, y:bis.y/Lb};
  const alpha = Math.acos(Math.max(-1, Math.min(1, v0.x*v1.x + v0.y*v1.y)));
  if (!(alpha>1e-3)) return;
  const Lprev = len(sub(P1,P0));
  const Lnext = len(sub(P2,P1));
  const minLen = Math.min(Lprev, Lnext);
  const tanHalf = Math.tan(alpha/2); if (!(tanHalf>1e-6)) return;
  const M = map.project(e.lngLat);
  const dvec = { x: M.x - P1.x, y: M.y - P1.y };
  const d = dvec.x*bis.x + dvec.y*bis.y; // projection along bisector
  const t_prevN = (i-1>=1) ? tangentLengthAt(coords, i-1, activeId) : 0;
  const t_nextN = (i+1<=coords.length-2) ? tangentLengthAt(coords, i+1, activeId) : 0;
  const t_max_adj = Math.max(0, Math.min(Lprev - t_prevN, Lnext - t_nextN));
  const t_max_base = 0.49*minLen;
  const t_max = Math.max(0, Math.min(t_max_base, t_max_adj));
  const t = Math.max(0, Math.min(d - radiusOffsetPx, t_max));
  const k = Math.max(0, Math.min(1, (t * alpha / tanHalf) / minLen));
  setRoundK(activeId, i, k);
  // Live update
  try { rebuildAndRenderEditorRoads(); } catch {}
  try { setActiveHandles(coords); } catch {}
}

function handleRadiusLabelClick(e) {
  try { e.preventDefault(); e.originalEvent && e.originalEvent.preventDefault && e.originalEvent.preventDefault(); e.originalEvent && e.originalEvent.stopPropagation && e.originalEvent.stopPropagation(); } catch {}
  const feat = (e.features && e.features[0]) || null;
  if (!feat || !feat.properties) return;
  const axisId = feat.properties.axisId;
  const idx = Number(feat.properties.idx);
  if (!axisId || !Number.isInteger(idx)) return;
  if (!roadsById.has(axisId)) return;
  const coords = (roadsById.get(axisId)?.geometry.coordinates)||[];
  if (idx<=0 || idx>=coords.length-1) return;
  const toPx = (ll)=>map.project({lng:ll[0],lat:ll[1]});
  const toLL = (p)=>{ const u=map.unproject({x:p.x,y:p.y}); return [u.lng,u.lat]; };
  const sub=(a,b)=>({x:a.x-b.x,y:a.y-b.y});
  const len=(v)=>Math.hypot(v.x,v.y);
  const norm=(v)=>{ const L=len(v); return L>1e-9?{x:v.x/L,y:v.y/L}:{x:0,y:0}; };
  const P0 = toPx(coords[idx-1]);
  const P1 = toPx(coords[idx]);
  const P2 = toPx(coords[idx+1]);
  const v0 = norm(sub(P1,P0));
  const v1 = norm(sub(P2,P1));
  const c = v0.x*v1.x + v0.y*v1.y;
  const alpha = Math.acos(Math.max(-1,Math.min(1,c)));
  if (!(alpha>1e-3)) return;
  const u0 = {x:-v0.x,y:-v0.y};
  let bis = {x:u0.x+v1.x, y:u0.y+v1.y};
  const Lb = len(bis); if (Lb<=1e-9) return; bis = {x:bis.x/Lb, y:bis.y/Lb};
  const Lprev = len(sub(P1,P0));
  const Lnext = len(sub(P2,P1));
  const minLen = Math.min(Lprev, Lnext);
  const tanHalf = Math.tan(alpha/2); if (!(tanHalf>1e-6)) return;
  // current radius in meters for initial value
  const kCur = getRoundK(axisId, idx);
  const t_goal = (kCur * minLen / alpha) * tanHalf;
  const t_prevN = (idx-1>=1) ? tangentLengthAt(coords, idx-1, axisId) : 0;
  const t_nextN = (idx+1<=coords.length-2) ? tangentLengthAt(coords, idx+1, axisId) : 0;
  const t_max_adj = Math.max(0, Math.min(Lprev - t_prevN, Lnext - t_nextN));
  const t_max_base = 0.49*minLen;
  const t_max = Math.max(0, Math.min(t_max_base, t_max_adj));
  const t = Math.max(0, Math.min(t_goal, t_max));
  const Rpx = t / tanHalf;
  const p1ll = toLL(P1);
  const p2 = { x: P1.x + bis.x * Rpx, y: P1.y + bis.y * Rpx };
  const p2ll = toLL(p2);
  let Rm = 0; try { Rm = turf.distance(asPoint(p1ll), asPoint(p2ll), { units:'kilometers' }) * 1000; } catch {}

  // Open inline input at click point
  const container = map.getContainer();
  const editor = document.createElement('input');
  editor.type = 'text';
  editor.value = (Rm||0).toFixed(1);
  editor.className = 'axis-radius-editor';
  Object.assign(editor.style, { position:'absolute', zIndex: 9999, padding:'2px 4px', font:'12px/1.2 sans-serif', border:'1px solid #888', background:'#fff', borderRadius:'3px', boxShadow:'0 1px 2px rgba(0,0,0,0.2)' });
  // place near mouse point
  const pt = e.point || map.project(feat.geometry.coordinates);
  editor.style.left = (pt.x + 6) + 'px';
  editor.style.top  = (pt.y - 10) + 'px';
  container.appendChild(editor);
  editor.select();
  radiusEditorEl = editor; radiusEditorCtx = { axisId, idx };

  const finish = (apply) => {
    if (!radiusEditorEl) return;
    const valStr = radiusEditorEl.value;
    container.removeChild(radiusEditorEl); radiusEditorEl = null; radiusEditorCtx = null;
    if (!apply) return;
    let val = Number(valStr);
    if (!isFinite(val) || val < 0) val = 0;
    // Convert meters to pixels along bisector
    const q2 = { x: P1.x + bis.x * 50, y: P1.y + bis.y * 50 };
    let metersFor50 = 1; try { metersFor50 = turf.distance(asPoint(toLL(P1)), asPoint(toLL(q2)), { units:'kilometers' }) * 1000; } catch {}
    const pxPerMeter = metersFor50 > 1e-6 ? (50 / metersFor50) : 0;
    const RpxDesired = val * pxPerMeter;
    const RpxMax = (t_max / tanHalf);
    let clamped = false; let RpxFinal = RpxDesired;
    if (!(RpxFinal <= RpxMax + 1e-6)) { RpxFinal = RpxMax; clamped = true; }
    const kNew = Math.max(0, Math.min(1, (RpxFinal * alpha) / minLen));
    setRoundK(axisId, idx, kNew);
    if (clamped) { radiusLabelError = { axisId, idx, until: Date.now() + 500 }; }
    try { rebuildAndRenderEditorRoads(); } catch {}
    try { setActiveHandles((roadsById.get(axisId)?.geometry.coordinates)||[]); } catch {}
  };

  editor.addEventListener('input', () => {
    // auto-replace comma with dot
    const pos = editor.selectionStart;
    const nv = editor.value.replace(/,/g, '.');
    if (nv !== editor.value) { editor.value = nv; try { editor.setSelectionRange(pos, pos); } catch {} }
  });
  editor.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
    else if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
  });
  editor.addEventListener('blur', () => finish(true));
}

function handleEditMouseDown(e) {
  console.log('[editor] mousedown on map (edit mode)');
  // Prefer layer event feature
  const feat = (e.features && e.features[0]) || null;
  let pt = feat && feat.geometry && feat.geometry.coordinates;
  if (!pt) {
    const hits = map.queryRenderedFeatures(e.point, { layers:['axis-verts'] });
    if (hits && hits.length) pt = hits[0].geometry.coordinates;
  }
  if (!pt) { console.log('[editor] no vertex feature under cursor'); return; }
  const coords = (roadsById.get(activeId)?.geometry.coordinates)||[];
  // Robust pick by nearest in pixels
  const ex = e.point && e.point.x, ey = e.point && e.point.y;
  let idx = -1; let best = Infinity;
  for (let i=0;i<coords.length;i++) {
    const p = map.project({ lng: coords[i][0], lat: coords[i][1] });
    const d = Math.hypot(p.x - ex, p.y - ey);
    if (d < best) { best = d; idx = i; }
  }
  if (!(best <= Math.max(8, snapPx))) idx = -1;
  console.log('[editor] vertex idx nearest ->', idx, 'dist=', best);
  if (idx>=0) {
    dragging = { on:true, kind:'vertex', index: idx };
    selectedVertexIdx = idx;
    dragPrevCoords = (roadsById.get(activeId)?.geometry.coordinates||[]).map(c=>[c[0],c[1]]);
    try { e.preventDefault(); e.originalEvent && e.originalEvent.preventDefault && e.originalEvent.preventDefault(); e.originalEvent && e.originalEvent.stopPropagation && e.originalEvent.stopPropagation(); } catch {}
    try { map.dragPan.disable(); } catch {}
    try { map.getCanvas().style.cursor='grabbing'; } catch {}
    console.log('[editor] drag start idx=', idx);
    setActiveHandles(coords);
  }
}

function handleVertexSelect(e) {
  const coords = (roadsById.get(activeId)?.geometry.coordinates)||[];
  if (!coords || coords.length<3) return;
  // Prefer feature coordinate if present
  const feat = (e.features && e.features[0]) || null;
  let pt = feat && feat.geometry && feat.geometry.coordinates;
  if (!pt) pt = [e.lngLat.lng, e.lngLat.lat];
  // pick nearest vertex by pixel distance
  const ex = e.point && e.point.x, ey = e.point && e.point.y;
  let idx = -1; let best = Infinity;
  for (let i=0;i<coords.length;i++) {
    const p = map.project({ lng: coords[i][0], lat: coords[i][1] });
    const d = Math.hypot(p.x - ex, p.y - ey);
    if (d < best) { best = d; idx = i; }
  }
  if (idx<=0 || idx>=coords.length-1) { selectedVertexIdx = -1; setActiveHandles(coords); return; }
  selectedVertexIdx = idx;
  setActiveHandles(coords);
}

function handleMouseUp() {
  if (dragging.on) {
    dragging.on=false;
    rebuildIndex(); // finalize
    try { rebuildAndRenderEditorRoads(); } catch {}
    try { map.dragPan.enable(); } catch {}
    try { map.getCanvas().style.cursor=''; } catch {}
    if (dragPrevCoords) { historyEdit.push({ type:'edit', id: activeId, prevCoords: dragPrevCoords }); dragPrevCoords = null; }
  }
}

function deleteSelectedVertex() {
  if (mode !== 'edit' || selectedVertexIdx < 0) return;
  const f = roadsById.get(activeId); if (!f) return;
  const coords = f.geometry.coordinates || [];
  if (coords.length <= 2) return; // keep at least a segment
  const prev = coords.map(c=>[c[0],c[1]]);
  coords.splice(selectedVertexIdx, 1);
  f.geometry.coordinates = coords;
  selectedVertexIdx = Math.min(selectedVertexIdx, coords.length-1);
  historyEdit.push({ type:'edit', id: activeId, prevCoords: prev });
  refreshSources(); setActiveHandles(coords);
  rebuildIndex();
  try { rebuildAndRenderEditorRoads(); } catch {}
}

function undoEdit() {
  const act = historyEdit.pop();
  if (!act) { console.log('[editor] undo (edit): empty'); return; }
  if (act.type === 'edit' && act.id && act.prevCoords) {
    const f = roadsById.get(act.id);
    if (f) {
      f.geometry.coordinates = act.prevCoords.map(c=>[c[0],c[1]]);
      refreshSources(); setActiveHandles(f.geometry.coordinates);
      rebuildIndex();
      try { rebuildAndRenderEditorRoads(); } catch {}
    }
  }
  console.log('[editor] undo depth edit=', historyEdit.length);
}

// Hover buffer in select mode
function handleSelectHover(e) {
  if (mode!=='select') { setHoverRoad(null); return; }
  const hits = map.queryRenderedFeatures(e.point, { layers:['axis-hit'] });
  const id = (hits && hits[0] && (hits[0].id || hits[0].properties?.id)) || null;
  setHoverRoad(id);
}

function handleSelectClick(e) {
  if (mode!=='select') return;
  const hits = map.queryRenderedFeatures(e.point, { layers:['axis-hit'] });
  const id = (hits && hits[0] && (hits[0].id || hits[0].properties?.id)) || null;
  if (id) enterEdit(id);
}

// Wire UI
window.addEventListener('DOMContentLoaded', () => {
  function boot() {
    if (!map) map = window.XODR_MAP;
    if (!map || typeof map.on !== 'function') return false;
    if (boot._done) return true; boot._done = true;
    if (map.loaded()) { ensureSources(); refreshSources(); } else { map.on('load', () => { ensureSources(); refreshSources(); }); }
    try { roadIndex = (window.geojsonRbush && window.geojsonRbush())(); } catch {}
  const bDraw = document.getElementById('drawAxis');
  const bEdit = document.getElementById('editAxis');
  editBtnEl = bEdit;
  const snapInput = document.getElementById('snapPx');
  if (snapInput) { const apply=()=>{ const v=Number(snapInput.value); if (isFinite(v)&&v>=0) snapPx=v; }; apply(); snapInput.addEventListener('input', apply); }
  const snapVInput = document.getElementById('snapVertexPx');
  if (snapVInput) { const applyV=()=>{ const v=Number(snapVInput.value); if (isFinite(v)&&v>=0) snapVertexPx=v; }; applyV(); snapVInput.addEventListener('input', applyV); }
  if (bDraw) {
      bDraw.addEventListener('click', () => {
        mode='draw'; activeId=null; drawingCoords=[]; selectEnabled=false;
        if (editBtnEl) editBtnEl.textContent = 'Edit Axis';
        setHoverRoad(null); setHoverVisible(false);
        map.getCanvas().style.cursor='crosshair'; setActiveHandles([]); setPreviewPath([]);
        try { map.doubleClickZoom.disable(); } catch {}
        refreshSources();
      });
    }
    if (bEdit) {
      const applyBtn = ()=>{ bEdit.textContent = selectEnabled ? 'Edit Axis: ON' : 'Edit Axis'; };
      bEdit.addEventListener('click', () => {
        selectEnabled = !selectEnabled;
        applyBtn();
        if (selectEnabled) { if (mode!=='draw') enterSelectMode(); }
        else { setHoverRoad(null); if (mode!=='draw') { mode='idle'; activeId=null; setActiveHandles([]); refreshSources(); } }
      });
      applyBtn();
    }

    map.on('mousemove', (e) => {
      if (mode==='draw') {
        if (drawingCoords.length>0) {
          const snap = snapLngLatPixelPriority([e.lngLat.lng, e.lngLat.lat], snapPx, snapVertexPx);
          const coords = drawingCoords.concat([snap]);
          setPreviewPath(coords);
          scheduleRealtimeRebuild(60);
        }
      } else if (mode==='select') {
        handleSelectHover(e);
      } else if (mode==='edit') {
        handleEditDragMove(e);
      }
    });
    map.on('click', (e) => {
      if (mode==='draw') handleDrawClick(e);
      else if (mode==='select') handleSelectClick(e);
      else if (mode==='edit') handleEditClick(e);
    });
    function undoDrawPoint() {
      if (mode!=='draw') return;
      if (drawingCoords.length>0) {
        drawingCoords.pop();
        if (drawingCoords.length<=1) { setPreviewPath([]); }
        console.log('[editor] undo (draw): points left=', drawingCoords.length);
      }
    }
    map.on('dblclick', (e) => {
      if (mode==='draw') {
        // prevent map zoom and finish with adding the snapped point
        try {
          e.preventDefault();
          e.originalEvent && e.originalEvent.preventDefault && e.originalEvent.preventDefault();
          e.originalEvent && e.originalEvent.stopPropagation && e.originalEvent.stopPropagation();
        } catch {}
        if (drawingCoords.length>0) {
          const snap = snapLngLatPixelPriority([e.lngLat.lng, e.lngLat.lat], snapPx, snapVertexPx);
          const last = drawingCoords[drawingCoords.length-1];
          const lp = map.project(last), sp = map.project(snap);
          if (Math.hypot(lp.x-sp.x, lp.y-sp.y) > 0.5) drawingCoords.push(snap);
        }
        finishDrawing();
      }
    });
    // ESC to cancel draw or exit edit, Delete vertex, and Ctrl/Cmd+Z undo
    document.addEventListener('keydown', (ev) => {
      const isRadiusEditing = document.activeElement && document.activeElement.classList && document.activeElement.classList.contains('axis-radius-editor');
      if (isRadiusEditing) return; // don't interfere while editing inline radius
      if (ev.key === 'Escape') {
        if (mode==='draw') { ev.preventDefault(); cancelDrawing(); try { map.doubleClickZoom.enable(); } catch {}; try { map.getCanvas().style.cursor=''; } catch {} }
        else if (mode==='edit') { ev.preventDefault(); exitEdit(); }
      } else if ((ev.key === 'Delete' || ev.key === 'Backspace') && mode==='edit') {
        ev.preventDefault(); deleteSelectedVertex();
      } else if ((ev.ctrlKey || ev.metaKey) && ev.code === 'KeyZ') {
        ev.preventDefault();
        if (mode==='edit') { undoEdit(); }
        else if (mode==='draw') { undoDrawPoint(); }
      }
    }, true);
    // Listen specifically on vertex layer so the event always reaches us
    map.on('mousedown', 'axis-verts', (e) => { if (mode==='edit') handleEditMouseDown(e); });
    map.on('click', 'axis-verts', (e) => { if (mode==='edit') handleVertexSelect(e); });
    map.on('mousedown', 'axis-radius', (e) => { if (mode==='edit') handleRadiusMouseDown(e); });
    map.on('click', 'axis-radius-labels', (e) => { if (mode==='edit') handleRadiusLabelClick(e); });
    map.on('mouseup', handleMouseUp);
    // capture-phase mousedown to stop map drag before it starts when over vertex
    try {
      map.on('mouseenter','axis-verts', ()=>{ overVertex=true; map.getCanvas().style.cursor='grab'; });
      map.on('mouseleave','axis-verts', ()=>{ overVertex=false; map.getCanvas().style.cursor=''; });
      map.on('mouseenter','axis-radius-labels', ()=>{ map.getCanvas().style.cursor='text'; });
      map.on('mouseleave','axis-radius-labels', ()=>{ map.getCanvas().style.cursor=''; });
    } catch {}
    // Remove global mousedown blocker to allow layer handler to receive events
    // prevent dblclick zoom globally while in draw/edit
    document.addEventListener('dblclick', (ev) => {
      if (mode==='draw' || mode==='edit') { ev.preventDefault(); ev.stopPropagation(); }
    }, true);
    return true;
  }
  if (!boot()) {
    const iv = setInterval(() => { if (boot()) clearInterval(iv); }, 30);
  }
  // If index.js deferred editor axes ingestion, consume now
  try {
    if (window.__EDITOR_AXES_BUFFER && window.editorIngestEditorAxes) {
      window.editorIngestEditorAxes(window.__EDITOR_AXES_BUFFER);
      window.__EDITOR_AXES_BUFFER = null;
      if (window.__EDITOR_AXES_WAIT) { clearInterval(window.__EDITOR_AXES_WAIT); window.__EDITOR_AXES_WAIT = null; }
    }
  } catch {}
});

// ---- Editor XODR export/import helpers ----
function __ed_toLocalXY(lng, lat) { try { return proj4('WGS84', 'LOCAL_TAN', [lng, lat]); } catch { return [lng, lat]; } }

function __ed_buildXodr() {
  const segs = [];
  for (const f of roadsById.values()) {
    const smooth = smoothAxisCoords(f);
    const parts = splitAxisByIntersections(f, smooth);
    for (const p of parts) { if (p && p.length>=2) segs.push({ parent:f.id, coords:p }); }
  }
  let lat0 = 0, lon0 = 0; try { const c = map.getCenter(); lon0 = c.lng; lat0 = c.lat; } catch {}
  const geoRef = `+proj=tmerc +lat_0=${lat0} +lon_0=${lon0} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m +no_defs`;
  const header = `<header revMajor="1" revMinor="6" name="editor_export" version="1.6">\n  <geoReference>${geoRef}</geoReference>\n</header>`;
  const roads = [];
  let rid = 0;
  for (const seg of segs) {
    const xy = seg.coords.map(([lng,lat]) => __ed_toLocalXY(lng,lat));
    let sCum = 0; const geoms = [];
    for (let i=0;i<xy.length-1;i++) {
      const [x0,y0] = xy[i]; const [x1,y1] = xy[i+1];
      const dx = x1-x0, dy=y1-y0; const L = Math.hypot(dx,dy); if (!(L>0)) continue;
      const hdg = Math.atan2(dy,dx);
      geoms.push(`<geometry s="${sCum.toFixed(3)}" x="${x0.toFixed(3)}" y="${y0.toFixed(3)}" hdg="${hdg.toFixed(6)}" length="${L.toFixed(3)}"><line/></geometry>`);
      sCum += L;
    }
    const planView = `<planView>\n${geoms.join('\n')}\n</planView>`;
    const laneWidth = 3.50;
    const center = `<center>\n  <lane id=\"0\" type=\"none\"><roadMark sOffset=\"0\" type=\"broken\" width=\"1.5\"/></lane>\n</center>`;
    const left = `<left>\n  <lane id=\"1\" type=\"driving\"><width sOffset=\"0\" a=\"${laneWidth}\" b=\"0\" c=\"0\" d=\"0\"/></lane>\n</left>`;
    const right = `<right>\n  <lane id=\"-1\" type=\"driving\"><width sOffset=\"0\" a=\"${laneWidth}\" b=\"0\" c=\"0\" d=\"0\"/></lane>\n</right>`;
    const lanes = `<lanes>\n  <laneSection s=\"0\">\n    ${left}\n    ${center}\n    ${right}\n  </laneSection>\n</lanes>`;
    const lengthAttr = sCum.toFixed(3);
    const name = `${seg.parent}`;
    roads.push(`<road id=\"${++rid}\" name=\"${name}\" length=\"${lengthAttr}\">\n${planView}\n${lanes}\n</road>`);
  }
  // Embed editable axes in userData for round-trip
  const axesBlob = [];
  for (const [id, f] of roadsById.entries()) {
    const coords = (f.geometry?.coordinates||[]).map(c=>[c[0],c[1]]);
    const rounding = roundingByAxis.get(id) || {};
    axesBlob.push({ id, coords, rounding });
  }
  const userData = `<userData>\n  <editorAxes><![CDATA[${JSON.stringify(axesBlob)}]]></editorAxes>\n</userData>`;
  const xml = `<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<OpenDRIVE>\n${header}\n${userData}\n${roads.join('\n')}\n</OpenDRIVE>`;
  return xml;
}

window.EditorExportXodr = function EditorExportXodr(){ try { return __ed_buildXodr(); } catch(e){ console.warn('EditorExportXodr failed', e); return ''; } }

window.editorIngestFromCenterlines = function editorIngestFromCenterlines(centerFC){
  try {
    console.log('[editor] ingest from centerlines');
    try { ensureSources(); } catch {}
    roadsById.clear(); importedAxisIds.clear();
    const importedNames = [];
    let n=0;
    for (const f of (centerFC?.features||[])) {
      if (!f || f.geometry?.type!=='LineString') continue;
      const id = `axis_${++n}`;
      let coords = (f.geometry.coordinates||[]).map(c=>[c[0],c[1]]);
      coords = simplifyAxisForEditor(coords, 2.5); // degrees threshold to merge tiny bends
      roadsById.set(id, { type:'Feature', id, properties:{ id }, geometry:{ type:'LineString', coordinates: coords } });
      // default rounding = 1 for all internal vertices
      const kv = {}; for (let i=1;i<coords.length-1;i++) kv[i]=1; roundingByAxis.set(id, kv);
      importedAxisIds.add(id); importedNames.push(id);
    }
    rebuildIndex();
    recomputeIntersectionsAll();
    refreshSources();
    setActiveHandles([]);
    try { if (mode!=='draw') { activeId=null; selectedVertexIdx=-1; setHoverVisible(true); } } catch {}
    try { rebuildAndRenderEditorRoads(); } catch {}
    console.log('[editor] ingest from centerlines: axes=', roadsById.size);
    try { if (window.filterBaseXodrForEditor) window.filterBaseXodrForEditor(importedNames); } catch {}
    // focus map on editable axes
    try {
      const feats = Array.from(roadsById.values());
      if (feats.length) {
        const bb = turf.bbox({ type:'FeatureCollection', features: feats });
        const sw = { lng: bb[0], lat: bb[1] }, ne = { lng: bb[2], lat: bb[3] };
        map.fitBounds([sw, ne], { padding: 40, duration: 0 });
      }
    } catch {}
  } catch(e){ console.warn('editorIngestFromCenterlines failed', e); }
}

// Ingest exact editor axes from embedded userData
window.editorIngestEditorAxes = function editorIngestEditorAxes(data){
  try {
    console.log('[editor] ingest editorAxes payload');
    try { ensureSources(); } catch {}
    roadsById.clear(); roundingByAxis.clear(); importedAxisIds.clear();
    const importedNames = [];
    for (const rec of (data||[])) {
      if (!rec || !Array.isArray(rec.coords)) continue;
      const id = rec.id || nextId();
      const coords = rec.coords.map(c=>[c[0],c[1]]);
      roadsById.set(id, { type:'Feature', id, properties:{ id }, geometry:{ type:'LineString', coordinates: coords } });
      if (rec.rounding && typeof rec.rounding==='object') roundingByAxis.set(id, rec.rounding);
      importedAxisIds.add(id); importedNames.push(id);
    }
    rebuildIndex();
    recomputeIntersectionsAll();
    refreshSources();
    setActiveHandles([]);
    try { if (mode!=='draw') { activeId=null; selectedVertexIdx=-1; setHoverVisible(true); } } catch {}
    try { rebuildAndRenderEditorRoads(); } catch {}
    try { enterSelectMode(); } catch {}
    console.log('[editor] ingest editorAxes: axes=', roadsById.size);
    try { if (window.filterBaseXodrForEditor) window.filterBaseXodrForEditor(importedNames); } catch {}
    // focus map on editable axes
    try {
      const feats = Array.from(roadsById.values());
      if (feats.length) {
        const bb = turf.bbox({ type:'FeatureCollection', features: feats });
        const sw = { lng: bb[0], lat: bb[1] }, ne = { lng: bb[2], lat: bb[3] };
        map.fitBounds([sw, ne], { padding: 40, duration: 0 });
      }
    } catch {}
  } catch(e){ console.warn('editorIngestEditorAxes failed', e); }
}

function simplifyAxisForEditor(coords, angleDeg=2.0) {
  try {
    if (!Array.isArray(coords) || coords.length<=2) return coords;
    const th = Math.max(0.5, angleDeg) * Math.PI/180;
    const out = [coords[0]];
    function ang(a,b,c){
      const ax=b[0]-a[0], ay=b[1]-a[1]; const bx=c[0]-b[0], by=c[1]-b[1];
      const la=Math.hypot(ax,ay), lb=Math.hypot(bx,by); if(la<1e-9||lb<1e-9) return 0;
      const cos=(ax*bx+ay*by)/(la*lb); return Math.acos(Math.max(-1,Math.min(1,cos)));
    }
    for (let i=1;i<coords.length-1;i++){
      const a=out[out.length-1], b=coords[i], c=coords[i+1];
      const an=ang(a,b,c);
      if (an > th) out.push(b); // keep corner
    }
    out.push(coords[coords.length-1]);
    // also dedupe identical neighbors
    const ded=[out[0]]; for(let i=1;i<out.length;i++){ const p=out[i], q=ded[ded.length-1]; if (Math.hypot(p[0]-q[0],p[1]-q[1])>1e-12) ded.push(p); }
    return ded.length>=2?ded:coords;
  } catch { return coords; }
}

