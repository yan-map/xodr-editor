import { parseOpenDrive, laneWidthAt } from './xodr/opendrive.js';
import {
  sampleGeometrySequence,
  offsetPolyline,
  toLineString,
  toPolygon,
  fc,
} from './xodr/geometry.js';

const DEBUG = false; // set true to enable verbose logging & debug layers

mapboxgl.accessToken =
  "pk.eyJ1IjoieWFucG9ndXRzYSIsImEiOiJjajBhMzJydzIwZmtmMndvY3ozejFicTdqIn0.T6DCFk1BSoEkdG-2agIoQQ";
const CENTER_LONLAT = [76.9373962233488, 43.23986449911439];

var map = new mapboxgl.Map({
  container: "map",
  style: {
    version: 8,
    name: "Empty",
    metadata: {
      "mapbox:autocomposite": true,
    },
    glyphs: "mapbox://fonts/mapbox/{fontstack}/{range}.pbf",
    sources: {},
    layers: [
      {
        id: "background",
        type: "background",
        paint: {
          "background-color": "rgba(0, 0, 0, 0)",
        },
      },
    ],
  }, //"mapbox://styles/mapbox/satellite-v9" ,
  hash: true,
  attributionControl: false,
  center: CENTER_LONLAT,
  minZoom: 2,
  zoom: 15,
  bearingSnap: 30,
  antialias: true,
});

// --- Projection helpers (local tangent plane using tmerc centered at map center) ---
const centerLat = CENTER_LONLAT[1];
const centerLon = CENTER_LONLAT[0];
const localProj = `+proj=tmerc +lat_0=${centerLat} +lon_0=${centerLon} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m +no_defs`;
proj4.defs("LOCAL_TAN", localProj);
const WGS84 = proj4("WGS84");
const LOCAL = proj4("LOCAL_TAN");

// Build a projector for OpenDRIVE local coordinates using header lat_0/lon_0 if provided
function makeProjector(lat0, lon0) {
  const projDef = `+proj=tmerc +lat_0=${lat0 ?? centerLat} +lon_0=${lon0 ?? centerLon} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m +no_defs`;
  const LOCAL_ODR = proj4(projDef);
  return function odrXYtoLngLat([x, y]) {
    return proj4(LOCAL_ODR, WGS84, [x, y]);
  };
}

// Global state
let currentModel = null;
let currentGeo = null;
let mapLoaded = false;
let lastXodrText = '';

map.on('load', () => {
  mapLoaded = true;
  ensureLayers();
  if (currentGeo) updateSources(currentGeo);
});

// Wire UI
window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('importXodr').addEventListener('click', () => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.xodr,.xml,text/xml,application/xml';
    inp.onchange = async () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      const text = await f.text();
      clearSources();
      lastXodrText = text;
      loadXodr(text);
    };
    inp.click();
  });
  document.getElementById('exportXodr').addEventListener('click', () => {
    const text = lastXodrText || '';
    const blob = new Blob([text], { type: 'application/xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'export.xodr';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  // Drag & drop on the panel
  const panel = document.getElementById('panel');
  const dropHint = document.getElementById('dropHint');
  const setPanelDrop = (on) => {
    if (!dropHint) return;
    dropHint.style.background = on ? '#eef7ff' : '#fafafa';
    dropHint.style.borderColor = on ? '#7fb3ff' : '#bbb';
    dropHint.textContent = on ? 'Drop to load .xodr' : 'Drop .xodr here to load';
  };
  ;['dragenter','dragover'].forEach(ev => panel.addEventListener(ev, (e)=>{ e.preventDefault(); e.stopPropagation(); setPanelDrop(true);}));
  ;['dragleave','dragend'].forEach(ev => panel.addEventListener(ev, (e)=>{ e.preventDefault(); e.stopPropagation(); setPanelDrop(false);}));
  panel.addEventListener('drop', async (e) => {
    e.preventDefault(); e.stopPropagation(); setPanelDrop(false);
    const f = (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) || null;
    if (!f) return;
    const text = await f.text();
    clearSources();
    lastXodrText = text;
    loadXodr(text);
  });

  // Try to load bundled test.xodr automatically
  fetch('test.xodr').then(r => r.text()).then(t => { lastXodrText = t; loadXodr(t); }).catch(() => {});
});

function loadXodr(xmlText) {
  try {
    const model = parseOpenDrive(xmlText);
    currentModel = model;
    const projector = makeProjector(model.header.lat0, model.header.lon0);
    const geo = buildGeometry(model, projector);
    currentGeo = geo;
    if (mapLoaded) {
      ensureLayers();
      updateSources(geo);
    }
    if (geo.bounds) {
      map.fitBounds(geo.bounds, { padding: 40, duration: 0 });
    }
  } catch (e) {
    alert('Failed to parse OpenDRIVE: ' + e.message);
    console.error(e);
  }
}

function buildGeometry(model, projector) {
  const centerFeatures = [];
  const laneFeatures = [];
  const markingFeatures = [];
  const sidewalkFeatures = [];
  const edgeFeatures = [];
  let __uid = 0;
  const nextId = (prefix) => `${prefix}_${++__uid}`;

  let minx = +Infinity, miny = +Infinity, maxx = -Infinity, maxy = -Infinity;

  for (const road of model.roads) {
    if (!road.planView || road.planView.length === 0) continue;
    let samples = sampleGeometrySequence(road.planView, { step: 0.6, maxAngle: 0.03 });
    if (samples.length < 2) continue;

    // bounds in local xy
    for (const [x, y] of samples) {
      if (x < minx) minx = x; if (y < miny) miny = y; if (x > maxx) maxx = x; if (y > maxy) maxy = y;
    }

    centerFeatures.push(toLineString(samples, projector));

    // lanes: compute per-s sample offsets for each lane id on both sides
    // enrich samples: enforce points at laneSection boundaries and width sOffsets to preserve exact joins
    const enforceS = new Set();
    for (const ls of road.laneSections) {
      enforceS.add(ls.s || 0);
      const pushWidths = (arr) => {
        for (const ln of (arr || [])) {
          for (const w of (ln.widths || [])) enforceS.add((ls.s || 0) + (w.sOffset || 0));
        }
      };
      pushWidths(ls.left); pushWidths(ls.right);
    }
    // ensure sorted and unique
    const ticks = Array.from(enforceS).filter(Number.isFinite).sort((a,b)=>a-b);
    if (ticks.length) {
      const sIdx = samples.map(p=>p[3]);
      const out = [samples[0]];
      for (let i=1;i<samples.length;i++){
        const s0 = sIdx[i-1], s1 = sIdx[i];
        const p0 = samples[i-1], p1 = samples[i];
        // insert any ticks strictly between s0 and s1
        for (const t of ticks) {
          if (t > s0 + 1e-9 && t < s1 - 1e-9) {
            const tt = (t - s0) / (s1 - s0);
            out.push(interpPoint(p0, p1, tt));
          }
        }
        out.push(p1);
      }
      samples = out.sort((a,b)=>a[3]-b[3]);
    }

    const sIndex = samples.map((p) => p[3]);

    function sectionAt(s) {
      // choose last laneSection with s <= s
      let sec = road.laneSections[0] || null;
      for (const ls of road.laneSections) {
        if (s + 1e-9 >= (ls.s || 0)) sec = ls;
      }
      return sec;
    }

    function laneOffsetAt(s) {
      const arr = road.laneOffsets || [];
      if (!arr.length) return 0;
      let rec = arr[0];
      for (const r of arr) { if (s + 1e-9 >= (r.s||0)) rec = r; }
      const ds = s - (rec.s || 0);
      return rec.a + rec.b * ds + rec.c * ds * ds + rec.d * ds * ds * ds;
    }

    // Build offsets using CubicSpline sums and lane tracks

    const EPS = 0.005; // meters; threshold where lane is considered vanished (smaller to avoid visible wedges)
    const sectionBounds = (road.laneSections || []).map(ls => ls.s || 0).filter(s => s>0).sort((a,b)=>a-b);

    function interpPoint(p1, p2, t) {
      const x = p1[0] + (p2[0] - p1[0]) * t;
      const y = p1[1] + (p2[1] - p1[1]) * t;
      const th = p1[2] + (p2[2] - p1[2]) * t;
      const s = p1[3] + (p2[3] - p1[3]) * t;
      return [x, y, th, s];
    }

  function laneTypeAt(side, laneId, s) {
    const sec = sectionAt(s);
    const ln = (sec?.[side] || []).find(l => l.id === laneId);
    return ln ? (ln.type || 'none') : 'none';
  }

    // Find active roadMark for a lane at absolute s along road
    function roadMarkAt(side, laneId, s) {
      const sec = sectionAt(s);
      if (!sec) return null;
      const ln = (sec?.[side] || []).find(l => l.id === laneId);
      if (!ln || !ln.roadMarks || ln.roadMarks.length === 0) return null;
      const sIn = s - (sec?.s || 0);
      let rec = null;
      for (const rm of ln.roadMarks) {
        if (sIn + 1e-9 >= (rm.sOffset || 0)) rec = rm;
      }
      return rec;
    }

    function computeOffsets(side, laneId, s, secOverride) {
      const sec = secOverride || sectionAt(s);
      const widths = (sec?.[side] || []).map((ln) => ({ id: ln.id, widths: ln.widths }));
      const thisLane = widths.find(w => w.id === laneId);
      const wCur = laneWidthAt(thisLane?.widths || [], s - (sec?.s || 0));
      let outer = laneOffsetAt(s);
      if (side === 'left') {
        for (const ln of widths) {
          const w = laneWidthAt(ln.widths, s - (sec?.s || 0));
          if (ln.id <= laneId) outer += w;
        }
        return { wCur, outer, inner: outer - wCur };
      } else {
        const sorted = widths.slice().sort((a,b)=>a.id-b.id);
        for (const ln of sorted) {
          const w = laneWidthAt(ln.widths, s - (sec?.s || 0));
          if (ln.id >= laneId) outer -= w;
        }
        return { wCur, outer, inner: outer + wCur };
      }
    }

    function buildLaneRuns(side, laneId) {
      const features = [];
      let runOuter = [];
      let runInner = [];
      let active = false;
      let prevWidth = 0;
      let runType = null;
      for (let i = 0; i < samples.length; i++) {
        const s = sIndex[i];
        const { wCur, outer, inner } = computeOffsets(side, laneId, s);
        const pOuter = offsetPoint(samples[i], outer);
        const pInner = offsetPoint(samples[i], inner);
        const typeNow = laneTypeAt(side, laneId, s);

        const widthOk = wCur > EPS;
        if (widthOk) {
          if (!active) {
            runType = typeNow;
            // starting a run: add boundary point at EPS if crossing
            if (i > 0 && prevWidth <= EPS) {
              const s0 = sIndex[i-1];
              const s1 = sIndex[i];
              const sec0 = sectionAt(s0);
              const widths0 = (sec0?.[side] || []).map((ln) => ({ id: ln.id, widths: ln.widths }));
              const this0 = widths0.find(w => w.id === laneId);
              const w0 = laneWidthAt(this0?.widths || [], s0 - (sec0?.s || 0));
              const w1 = wCur;
              const t = (w1 - w0) !== 0 ? (EPS - w0) / (w1 - w0) : 0;
              const sp = interpPoint(samples[i-1], samples[i], t);
              // Use linear interp of already computed outer offsets
              const offPrevOuter = (side==='left' ? (function(){
                let sum = laneOffsetAt(s0);
                for (const ln of widths0) { const w = laneWidthAt(ln.widths, s0 - (sec0?.s||0)); if (ln.id <= laneId) sum += w; }
                return sum; })() : (function(){
                let sum = laneOffsetAt(s0);
                const sorted0 = widths0.slice().sort((a,b)=>a.id-b.id);
                for (const ln of sorted0) { const w = laneWidthAt(ln.widths, s0 - (sec0?.s||0)); if (ln.id >= laneId) sum -= w; }
                return sum; })());
              const offStart = offPrevOuter + ( ( (side==='left') ? -1 : +1) * (w0 - EPS) ); // inner will use EPS
              const offEnd = outer + ( ( (side==='left') ? -1 : +1) * (w1 - EPS) );
              const offOuterInterp = offPrevOuter + (outer - offPrevOuter) * t;
              const spOuter = offsetPoint(sp, offOuterInterp);
              const spInner = offsetPoint(sp, side==='left' ? (offOuterInterp - EPS) : (offOuterInterp + EPS));
              runOuter.push(spOuter);
              runInner.push(spInner);
            }
            active = true;
          }
          // laneSection boundary with potential type change
          if (i > 0) {
            const s0 = sIndex[i-1];
            const s1 = sIndex[i];
            for (const sb of sectionBounds) {
              if (s0 < sb && sb <= s1 + 1e-9) {
                const typeBefore = laneTypeAt(side, laneId, sb - 1e-6);
                const typeAfter = laneTypeAt(side, laneId, sb + 1e-6);
                // Always insert exact boundary point using next section offsets to start slope immediately
                const tB = (sb - s0) / (s1 - s0);
                const spB = interpPoint(samples[i-1], samples[i], tB);
                const offAfter = computeOffsets(side, laneId, sb + 1e-6, sectionAt(sb + 1e-6));
                if (offAfter.wCur > EPS) {
                  const pO = offsetPoint(spB, offAfter.outer);
                  const pI = offsetPoint(spB, offAfter.inner);
                  runOuter.push(pO);
                  runInner.push(pI);
                }
                if (typeBefore !== typeAfter) {
                  const t = (sb - s0) / (s1 - s0);
                  const sp = interpPoint(samples[i-1], samples[i], t);
                  const offB = computeOffsets(side, laneId, sb - 1e-6, sectionAt(sb - 1e-6));
                  const pOB = offsetPoint(sp, offB.outer);
                  const pIB = offsetPoint(sp, offB.inner);
                  runOuter.push(pOB);
                  runInner.push(pIB);
                  if (runOuter.length >= 2 && runInner.length >= 2) {
                    const props = { side, laneId, laneType: runType || typeBefore, roadId: road.id, roadName: road.name || '', roadLength: road.length };
                    const feat = side==='left' ? toPolygon(runOuter, runInner, projector, props) : toPolygon(runInner, runOuter, projector, props);
                    feat.id = `r${road.id}_l${laneId}_${runOuter[0][3].toFixed(2)}`;
                    feat.properties.fid = feat.id;
                    features.push(feat);
                    const innerLine = toLineString(runInner, projector);
                    innerLine.properties = { kind: 'lane_inner', side, laneId, roadId: road.id };
                    markingFeatures.push(innerLine);
                  }
                  runOuter = [];
                  runInner = [];
                  active = false;
                  runType = null;

                  // start new run immediately on the next section if width there is > EPS
                  const offA = computeOffsets(side, laneId, sb + 1e-6, sectionAt(sb + 1e-6));
                  if (offA.wCur > EPS) {
                    const pOA = offsetPoint(sp, offA.outer);
                    const pIA = offsetPoint(sp, offA.inner);
                    runOuter.push(pOA);
                    runInner.push(pIA);
                    active = true;
                    runType = typeAfter;
                  }
                }
              }
            }
          }
          runOuter.push(pOuter);
          runInner.push(pInner);
        } else if (active) {
          // finishing a run: add boundary point at EPS if crossing
          if (i > 0) {
            const s0 = sIndex[i-1];
            const s1 = sIndex[i];
            const sec0 = sectionAt(s0);
            const widths0 = (sec0?.[side] || []).map((ln) => ({ id: ln.id, widths: ln.widths }));
            const this0 = widths0.find(w => w.id === laneId);
            const w0 = laneWidthAt(this0?.widths || [], s0 - (sec0?.s || 0));
            const w1 = wCur;
            const t = (w1 - w0) !== 0 ? (EPS - w0) / (w1 - w0) : 0;
            const sp = interpPoint(samples[i-1], samples[i], t);
            // outer offset interpolation
            const offPrevOuter = (side==='left' ? (function(){
              let sum = laneOffsetAt(s0);
              for (const ln of widths0) { const w = laneWidthAt(ln.widths, s0 - (sec0?.s||0)); if (ln.id <= laneId) sum += w; }
              return sum; })() : (function(){
              let sum = laneOffsetAt(s0);
              const sorted0 = widths0.slice().sort((a,b)=>a.id-b.id);
              for (const ln of sorted0) { const w = laneWidthAt(ln.widths, s0 - (sec0?.s||0)); if (ln.id >= laneId) sum -= w; }
              return sum; })());
            const offOuterInterp = offPrevOuter + (outer - offPrevOuter) * t;
            const spOuter = offsetPoint(sp, offOuterInterp);
            const spInner = offsetPoint(sp, side==='left' ? (offOuterInterp - EPS) : (offOuterInterp + EPS));
            runOuter.push(spOuter);
            runInner.push(spInner);
          }
          // finish feature
          if (runOuter.length >= 2 && runInner.length >= 2) {
            const props = { side, laneId, laneType: laneTypeFor(road, side, laneId), roadId: road.id, roadName: road.name || '', roadLength: road.length };
            const feat = side==='left' ? toPolygon(runOuter, runInner, projector, props) : toPolygon(runInner, runOuter, projector, props);
            feat.id = `r${road.id}_l${laneId}_${runOuter[0][3].toFixed(2)}`;
            feat.properties.fid = feat.id;
            features.push(feat);
            // Add inner boundary as marking line
            const innerLine = toLineString(runInner, projector);
            innerLine.properties = { kind: 'lane_inner', side, laneId, roadId: road.id };
            markingFeatures.push(innerLine);
          }
          runOuter = [];
          runInner = [];
          active = false;
        }
        prevWidth = wCur;
      }
      // finalize last run
      if (active && runOuter.length >= 2 && runInner.length >= 2) {
        const props = { side, laneId, laneType: laneTypeFor(road, side, laneId), roadId: road.id, roadName: road.name || '', roadLength: road.length };
        const feat = side==='left' ? toPolygon(runOuter, runInner, projector, props) : toPolygon(runInner, runOuter, projector, props);
        feat.id = `r${road.id}_l${laneId}_${runOuter[0][3].toFixed(2)}`;
        feat.properties.fid = feat.id;
        features.push(feat);
        const innerLine = toLineString(runInner, projector);
        const s0 = runInner[0][3], s1 = runInner[runInner.length-1][3];
        const rm0 = roadMarkAt(side, laneId, s0) || {};
        innerLine.properties = {
          kind: 'lane_inner', side, laneId, roadId: road.id,
          s0, s1,
          roadmark: rm0.type || undefined,
          roadmarkColor: rm0.color || undefined,
          roadmarkWidth: rm0.width,
          roadmarkMaterial: rm0.material || undefined,
          roadmarkLaneChange: rm0.laneChange || undefined
        };
        markingFeatures.push(innerLine);
      }
      return features;
    }

    // Build and render using lane tracks across sections
    function buildTracks(side) {
      const tracks = [];
      const nodes = new Map();
      for (let si=0; si<road.laneSections.length; si++){
        const ls = road.laneSections[si];
        for (const ln of (ls[side]||[])) {
          nodes.set(`${si}:${ln.id}`, { si, id: ln.id, pred: ln.predecessor, succ: ln.successor, type: ln.type });
        }
      }
      const starts = [];
      for (let si=0; si<road.laneSections.length; si++){
        const ls = road.laneSections[si];
        for (const ln of (ls[side]||[])) {
          const key = `${si}:${ln.id}`;
          const prevKey = si>0 ? `${si-1}:${ln.predecessor}` : null;
          if (!prevKey || !nodes.has(prevKey)) starts.push(nodes.get(key));
        }
      }
      for (const st of starts){
        const track = []; let cur = st;
        while (cur){ track.push(cur); const nsi = cur.si+1; const nls = road.laneSections[nsi]; if (!nls) break; let nextKey = null; if (cur.succ!=null && nodes.has(`${nsi}:${cur.succ}`)) nextKey = `${nsi}:${cur.succ}`; if (!nextKey){ for (const ln of (nls[side]||[])) { if (ln.predecessor === cur.id) { nextKey = `${nsi}:${ln.id}`; break; } }} cur = nextKey ? nodes.get(nextKey) : null; }
        tracks.push({ side, nodes: track });
      }
      return tracks;
    }
    const tracksLeft = buildTracks('left');
    const tracksRight = buildTracks('right');

    function buildLaneRunsTrack(track) {
      const features = [];
      let runOuter = [];
      let runInner = [];
      let active = false;
      let prevWidth = 0;
      let runType = null;
      for (let i=0;i<samples.length;i++){
        const s = sIndex[i];
        const sec = sectionAt(s);
        const si = road.laneSections.indexOf(sec);
        const node = track.nodes.find(n=>n.si===si);
        if (!node){
          if (active){
            if (runOuter.length>=2 && runInner.length>=2){
            const s0 = runOuter[0][3];
            const s1 = runOuter[runOuter.length-1][3];
            const props = { side: track.side, laneId: 'track', laneType: runType||'', roadId: road.id, roadName: road.name||'', roadLength: road.length, s0, s1, secStartS: sectionAt(s0)?.s || 0, secEndS: sectionAt(s1)?.s || 0 };
            // attach representative roadmark to lane polygon as well (mid-run)
            const rmMid = roadMarkAt(track.side, 'track', 0.5*(s0+s1));
            if (rmMid) {
              props.roadmark = rmMid.type || undefined;
              props.roadmarkColor = rmMid.color || undefined;
              props.roadmarkWidth = rmMid.width;
              props.roadmarkMaterial = rmMid.material || undefined;
              props.roadmarkLaneChange = rmMid.laneChange || undefined;
            }
            const feat = track.side==='left' ? toPolygon(runOuter, runInner, projector, props) : toPolygon(runInner, runOuter, projector, props);
            const laneIdUniq = nextId('lane');
            feat.id = laneIdUniq; feat.properties.fid = laneIdUniq; features.push(feat);
            const innerLine = toLineString(runInner, projector); 
            const rm0 = roadMarkAt(track.side, (typeof props.laneId==='number'?props.laneId:node?.id), s0) || {};
            innerLine.properties = { kind:'lane_inner', side: track.side, roadId: road.id, s0, s1, secStartS: props.secStartS, secEndS: props.secEndS, roadmark: rm0.type || undefined, roadmarkColor: rm0.color || undefined, roadmarkWidth: rm0.width, roadmarkMaterial: rm0.material || undefined, roadmarkLaneChange: rm0.laneChange || undefined };
            const mid = nextId('mark'); innerLine.id = mid; innerLine.properties.mid = mid; markingFeatures.push(innerLine);
            }
            runOuter=[]; runInner=[]; active=false; prevWidth=0;
          }
          continue;
        }
        // compute offsets using node.id in this section
        const side = track.side;
        const widths = (sec?.[side] || []).map(ln=>({ id: ln.id, widths: ln.widths, type: ln.type }));
        const thisLane = widths.find(w=>w.id===node.id);
        const wCur = laneWidthAt(thisLane?.widths||[], s-(sec?.s||0));
        let outer = laneOffsetAt(s);
        if (side==='left'){
          for (const ln of widths){ const w = laneWidthAt(ln.widths, s-(sec?.s||0)); if (ln.id<=node.id) outer += w; }
        } else {
          const sorted = widths.slice().sort((a,b)=>a.id-b.id);
          for (const ln of sorted){ const w = laneWidthAt(ln.widths, s-(sec?.s||0)); if (ln.id>=node.id) outer -= w; }
        }
        const inner = side==='left' ? (outer - wCur) : (outer + wCur);
        const pOuter = offsetPoint(samples[i], outer);
        const pInner = offsetPoint(samples[i], inner);
        const typeNow = (thisLane && (thisLane.type||'none')) || 'none';
        const widthOk = wCur > EPS;
        if (widthOk){
          if (!active){
            runType = typeNow; active = true;
            if (i>0 && prevWidth<=EPS){
              const s0=sIndex[i-1], s1=sIndex[i];
              const sec0 = sectionAt(s0);
              const si0 = road.laneSections.indexOf(sec0);
              const node0 = track.nodes.find(n=>n.si===si0) || node;
              const widths0 = (sec0?.[side] || []).map(ln=>({id:ln.id, widths: ln.widths}));
              const this0 = widths0.find(w=>w.id===node0.id);
              const w0 = laneWidthAt(this0?.widths||[], s0-(sec0?.s||0));
              const t = (wCur - w0)!==0 ? (EPS - w0)/(wCur - w0) : 0;
              const sp = interpPoint(samples[i-1], samples[i], t);
              let offPrevOuter = laneOffsetAt(s0);
              if (side==='left'){ for (const ln of widths0){ const w=laneWidthAt(ln.widths, s0-(sec0?.s||0)); if (ln.id<=node0.id) offPrevOuter+=w; } }
              else { const sorted=widths0.slice().sort((a,b)=>a.id-b.id); for (const ln of sorted){ const w=laneWidthAt(ln.widths, s0-(sec0?.s||0)); if (ln.id>=node0.id) offPrevOuter-=w; } }
              const offOuterInterp = offPrevOuter + (outer - offPrevOuter)*t;
              runOuter.push(offsetPoint(sp, offOuterInterp));
              runInner.push(offsetPoint(sp, side==='left'? (offOuterInterp - EPS):(offOuterInterp + EPS)));
            }
          }
          runOuter.push(pOuter); runInner.push(pInner);
        } else if (active){
          // close
          if (i>0){
            const s0=sIndex[i-1];
            const sec0=sectionAt(s0);
            const si0=road.laneSections.indexOf(sec0);
            const node0=track.nodes.find(n=>n.si===si0) || node;
            const widths0=(sec0?.[side]||[]).map(ln=>({id:ln.id, widths:ln.widths}));
            const this0=widths0.find(w=>w.id===node0.id);
            const w0=laneWidthAt(this0?.widths||[], s0-(sec0?.s||0));
            const t=(wCur - w0)!==0 ? (EPS - w0)/(wCur - w0) : 0;
            const sp=interpPoint(samples[i-1], samples[i], t);
            let offPrevOuter = laneOffsetAt(s0);
            if (side==='left'){ for (const ln of widths0){ const w=laneWidthAt(ln.widths, s0-(sec0?.s||0)); if (ln.id<=node0.id) offPrevOuter+=w; } }
            else { const sorted=widths0.slice().sort((a,b)=>a.id-b.id); for (const ln of sorted){ const w=laneWidthAt(ln.widths, s0-(sec0?.s||0)); if (ln.id>=node0.id) offPrevOuter-=w; } }
            const offOuterInterp = offPrevOuter + (outer - offPrevOuter)*t;
            runOuter.push(offsetPoint(sp, offOuterInterp));
            runInner.push(offsetPoint(sp, side==='left'? (offOuterInterp - EPS):(offOuterInterp + EPS)));
          }
          if (runOuter.length>=2 && runInner.length>=2){
            const s0 = runOuter[0][3];
            const s1 = runOuter[runOuter.length-1][3];
            const props = { side, laneId: node.id, laneType: runType||typeNow, roadId: road.id, roadName: road.name||'', roadLength: road.length, s0, s1, secStartS: sectionAt(s0)?.s || 0, secEndS: sectionAt(s1)?.s || 0 };
            const rmMidLane = roadMarkAt(side, node.id, 0.5*(s0+s1));
            if (rmMidLane){ props.roadmark = rmMidLane.type || undefined; props.roadmarkColor = rmMidLane.color || undefined; props.roadmarkWidth = rmMidLane.width; props.roadmarkMaterial = rmMidLane.material || undefined; props.roadmarkLaneChange = rmMidLane.laneChange || undefined; }
            const feat = side==='left' ? toPolygon(runOuter, runInner, projector, props) : toPolygon(runInner, runOuter, projector, props);
            const laneIdUniq = nextId('lane');
            feat.id = laneIdUniq; feat.properties.fid = laneIdUniq; features.push(feat);
            const innerLine = toLineString(runInner, projector);
            const rm0 = roadMarkAt(side, node.id, s0) || {};
            innerLine.properties = {
              kind:'lane_inner', side, laneId: node.id, roadId: road.id,
              s0, s1, secStartS: props.secStartS, secEndS: props.secEndS,
              roadmark: rm0.type || undefined,
              roadmarkColor: rm0.color || undefined,
              roadmarkWidth: rm0.width,
              roadmarkMaterial: rm0.material || undefined,
              roadmarkLaneChange: rm0.laneChange || undefined
            };
            const mid = nextId('mark'); innerLine.id = mid; innerLine.properties.mid = mid; markingFeatures.push(innerLine);
          }
          runOuter=[]; runInner=[]; active=false;
        }
        prevWidth = wCur;
      }
      if (active && runOuter.length>=2 && runInner.length>=2){
        const side = track.side; const nodeLast = track.nodes[track.nodes.length-1];
        const s0 = runOuter[0][3]; const s1 = runOuter[runOuter.length-1][3];
        const props = { side, laneId: nodeLast?.id, laneType: runType||'', roadId: road.id, roadName: road.name||'', roadLength: road.length, s0, s1, secStartS: sectionAt(s0)?.s || 0, secEndS: sectionAt(s1)?.s || 0 };
        const rmMidLane = roadMarkAt(side, nodeLast?.id, 0.5*(s0+s1));
        if (rmMidLane){ props.roadmark = rmMidLane.type || undefined; props.roadmarkColor = rmMidLane.color || undefined; props.roadmarkWidth = rmMidLane.width; props.roadmarkMaterial = rmMidLane.material || undefined; props.roadmarkLaneChange = rmMidLane.laneChange || undefined; }
        const feat = side==='left' ? toPolygon(runOuter, runInner, projector, props) : toPolygon(runInner, runOuter, projector, props);
        const laneIdUniq = nextId('lane');
        feat.id = laneIdUniq; feat.properties.fid = laneIdUniq; features.push(feat);
        const innerLine = toLineString(runInner, projector);
        const rm0 = roadMarkAt(side, nodeLast?.id, s0) || {};
        innerLine.properties = {
          kind:'lane_inner', side, laneId: nodeLast?.id, roadId: road.id,
          s0, s1, secStartS: props.secStartS, secEndS: props.secEndS,
          roadmark: rm0.type || undefined,
          roadmarkColor: rm0.color || undefined,
          roadmarkWidth: rm0.width,
          roadmarkMaterial: rm0.material || undefined,
          roadmarkLaneChange: rm0.laneChange || undefined
        };
        const mid = nextId('mark'); innerLine.id = mid; innerLine.properties.mid = mid; markingFeatures.push(innerLine);
      }
      return features;
    }

    for (const tr of tracksLeft) laneFeatures.push(...buildLaneRunsTrack(tr));
    for (const tr of tracksRight) laneFeatures.push(...buildLaneRunsTrack(tr));

    // Carriageway outer edges (exclude sidewalks)
    const leftEdge = [];
    const rightEdge = [];
    for (let i = 0; i < samples.length; i++) {
      const s = sIndex[i];
      const sec = sectionAt(s);
      const lo = laneOffsetAt(s);
      let sumLeft = 0;
      for (const ln of (sec?.left || [])) {
        if ((ln.type || 'none') === 'sidewalk') continue;
        const w = laneWidthAt(ln.widths, s - (sec?.s || 0));
        sumLeft += w;
      }
      let sumRight = 0;
      // right: sum absolute widths of considered lanes
      const sortedRight = (sec?.right || []).slice().sort((a,b)=>a.id-b.id);
      for (const ln of sortedRight) {
        if ((ln.type || 'none') === 'sidewalk') continue;
        const w = laneWidthAt(ln.widths, s - (sec?.s || 0));
        sumRight += w;
      }
      const pL = offsetPoint(samples[i], lo + sumLeft);
      const pR = offsetPoint(samples[i], lo - sumRight);
      leftEdge.push(pL);
      rightEdge.push(pR);
    }
    const leftEdgeLine = toLineString(leftEdge, projector); leftEdgeLine.properties = { kind: 'edge', side: 'left', roadId: road.id };
    const rightEdgeLine = toLineString(rightEdge, projector); rightEdgeLine.properties = { kind: 'edge', side: 'right', roadId: road.id };
    edgeFeatures.push(leftEdgeLine, rightEdgeLine);
  }

  const bounds = (isFinite(minx) ? new mapboxgl.LngLatBounds(
    projector([minx, miny]), projector([maxx, maxy])
  ) : null);

  const centerlines = fc(centerFeatures);
  const lanes = fc(laneFeatures);
  const markings = fc(markingFeatures);
  const sidewalks = fc(sidewalkFeatures);
  const edges = fc(edgeFeatures);
  const intersection = fc([]);
  return { centerlines, lanes, markings, sidewalks, edges, intersection, bounds };
}

function polyEval(coeff, ds) {
  if (!coeff) return 0;
  return coeff.a + coeff.b * ds + coeff.c * ds * ds + coeff.d * ds * ds * ds;
}

function collectLaneIds(laneSections, side) {
  const set = new Set();
  for (const ls of laneSections || []) {
    for (const ln of (ls?.[side] || [])) set.add(ln.id);
  }
  const ids = Array.from(set);
  // sort left desc (2,1), right asc (-2,-1)
  ids.sort((a,b) => a===b ? 0 : (a>0 && b>0 ? b-a : (a<0 && b<0 ? a-b : a-b)));
  return ids;
}

function laneTypeFor(road, side, laneId) {
  for (const ls of road.laneSections || []) {
    for (const ln of (ls?.[side] || [])) {
      if (ln.id === laneId) return ln.type || 'none';
    }
  }
  return 'none';
}

function offsetPoint(sample, offset) {
  const [x, y, th, s] = sample;
  const nx = -Math.sin(th), ny = Math.cos(th);
  return [x + nx * offset, y + ny * offset, th, s];
}

function ensureLayers() {
  if (!map.getSource('xodr-center')) {
    map.addSource('xodr-center', { type: 'geojson', data: fc() });
    map.addLayer({ id: 'xodr-center', type: 'line', source: 'xodr-center', paint: { 'line-color': 'transparent'/*'#111'*/, 'line-width': 1.5 } });
  }
  if (!map.getSource('xodr-lanes')) {
    map.addSource('xodr-lanes', { type: 'geojson', data: fc() });
    // color lanes by laneType
    map.addLayer({
      id: 'xodr-lanes',
      type: 'fill',
      source: 'xodr-lanes',
      paint: {
        'fill-color': [
          'match', ['get','laneType'],
          'driving', '#3887be',
          'shoulder', '#9e9e9e',
          'sidewalk', '#6fcf97',
          'biking', '#ff6f61',
          'parking', '#f2c94c',
          /* other */ '#cfcfcf'
        ],
        'fill-opacity': 0.4
      }
    });
    map.addLayer({ id: 'xodr-lane-outline', type: 'line', source: 'xodr-lanes', paint: { 'line-color': '#fff', 'line-width': 0.5, 'line-opacity': 0.5 } });
    // markings source/layer
    map.addSource('xodr-markings', { type: 'geojson', data: fc() });
    map.addLayer({ id: 'xodr-markings', type: 'line', source: 'xodr-markings', paint: { 'line-color': '#ffffff', 'line-width': 0.8, 'line-dasharray': [2, 2], 'line-opacity': 0.9 } });
    // outer edges of carriageway
    map.addSource('xodr-edges', { type: 'geojson', data: fc() });
    map.addLayer({ id: 'xodr-edges', type: 'line', source: 'xodr-edges', paint: { 'line-color': '#111', 'line-width': 2.0, 'line-opacity': 0.17 } });
    // Simple hover layers: filter by feature id (exact match)
    map.addLayer({ id: 'xodr-lane-hover', type: 'line', source: 'xodr-lanes', paint: { 'line-color': '#ff0', 'line-width': 2.0 }, filter: ['==', ['id'], ''] });
    map.addLayer({ id: 'xodr-marking-hover', type: 'line', source: 'xodr-markings', paint: { 'line-color': '#ff0', 'line-width': 2.0 }, filter: ['==', ['id'], ''] });
    attachHoverHandlers();
  }
}

function updateSources(geo) {
  map.getSource('xodr-center').setData(geo.centerlines);
  map.getSource('xodr-lanes').setData(geo.lanes);
  if (map.getSource('xodr-markings')) map.getSource('xodr-markings').setData(geo.markings || fc());
  if (map.getSource('xodr-edges')) map.getSource('xodr-edges').setData(geo.edges || fc());
}

// Export for download button
window.buildGeo = function buildGeo() {
  try {
    // Export exactly what is on the map (no modification)
    const bundle = {};
    const ids = [
      ['centerlines','xodr-center'],
      ['lanes','xodr-lanes'],
      ['markings','xodr-markings'],
      ['edges','xodr-edges'],
    ];
    for (const [key, id] of ids) {
      const src = map.getSource(id);
      if (src && (src.getData ? src.getData() : src._data)) {
        bundle[key] = (src.getData ? src.getData() : src._data);
      }
    }
    // Provide fallbacks for absent sources
    return Object.assign({
      centerlines: fc(), lanes: fc(), markings: fc(), edges: fc(), sidewalks: fc(), intersection: fc()
    }, currentGeo || {}, bundle);
  } catch (e) {
    return currentGeo || { centerlines: fc(), lanes: fc(), sidewalks: fc(), markings: fc(), edges: fc(), intersection: fc() };
  }
}

function clearSources() {
  try {
    ensureLayers();
    const empty = fc();
    if (map.getSource('xodr-center')) map.getSource('xodr-center').setData(empty);
    if (map.getSource('xodr-lanes')) map.getSource('xodr-lanes').setData(empty);
    if (map.getSource('xodr-markings')) map.getSource('xodr-markings').setData(empty);
    if (map.getSource('xodr-edges')) map.getSource('xodr-edges').setData(empty);
    currentGeo = null;
    currentModel = null;
  } catch {}
}

let hoverPopup = null;
let hoverId = null;
let hoverMarkId = null;
let hoverHandlersAttached = false;

function attachHoverHandlers() {
  if (hoverHandlersAttached) return;
  hoverHandlersAttached = true;
  hoverPopup = new mapboxgl.Popup({ closeButton: false, closeOnClick: false });

  map.on('mousemove', 'xodr-lanes', (e) => {
    // Если над markings - сбрасываю
    const pad = 3;
    const box = [[e.point.x-pad, e.point.y-pad],[e.point.x+pad, e.point.y+pad]];
    const markingsCount = map.queryRenderedFeatures(box, { layers: ['xodr-markings'] }).length;
    if (markingsCount>0) return;

    const f = (e.features && e.features[0]) || null;
    if (!f) return;
    const fid = f.id || (f.properties && f.properties.fid) || null;
    if (!fid) return;
    if (hoverId !== fid) {
      hoverId = fid;
      map.setFilter('xodr-lane-hover', ['==', 'fid', fid]); 
      map.setFilter('xodr-marking-hover', ['==', 'fid', '']); 
      hoverMarkId = null;
      if (DEBUG) {
        try {
          const pad = 3;
          const box = [[e.point.x-pad, e.point.y-pad],[e.point.x+pad, e.point.y+pad]];
          const hits = map.queryRenderedFeatures(box, { layers: ['xodr-lanes'] }) || [];
          console.log('hover lane id=', fid, 'hits=', hits.length);
        } catch{}
      }
    }
    const p = f.properties || {};
    const html = `
      <div style="font:12px/1.3 system-ui,Segoe UI,Roboto,Arial">
        <div><b>Road:</b> ${escapeHtml(p.roadName || '')} <span style="opacity:.6">(#${p.roadId})</span></div>
        <div><b>Lane:</b> ${p.side} ${p.laneId} <span style="opacity:.6">(${p.laneType||'n/a'})</span></div>
        <div><b>Run s:</b> ${Number(p.s0||0).toFixed(2)} → ${Number(p.s1||0).toFixed(2)} m</div>
        <div><b>Sections:</b> ${Number(p.secStartS||0).toFixed(2)} → ${Number(p.secEndS||0).toFixed(2)} m</div>
      </div>`;
    try {
      hoverPopup.setLngLat(e.lngLat).setHTML(buildLaneHtml(p)).addTo(map);
    } catch {
      hoverPopup.setLngLat(e.lngLat).setHTML(html).addTo(map);
    }
  });
  map.on('mouseleave', 'xodr-lanes', () => {
    hoverId = null;
    map.setFilter('xodr-lane-hover', ['==', 'id', '']);
    if (hoverPopup) hoverPopup.remove();
  });

  // markings hover
  map.on('mousemove', 'xodr-markings', (e) => {
    const pad = 10;
    const box = [[e.point.x-pad, e.point.y-pad],[e.point.x+pad, e.point.y+pad]];
    const markingsArray = map.queryRenderedFeatures(box, { layers: ['xodr-markings'] });
   if (markingsArray.length==0) return;

   const f = markingsArray[0];
    //const f = (e.features && e.features[0]) || null;
    
    const mid = f.id || (f.properties && f.properties.mid) || null;
    if (!mid) return;
    if (hoverMarkId !== mid) {
      hoverMarkId = mid;
      try { map.setFilter('xodr-marking-hover', ['==', 'mid', mid]); } catch {}
      try { map.setFilter('xodr-lane-hover', ['==', 'mid', '']); } catch {}
      hoverId = null;
    }
    const p = f.properties || {};
    const html = `
      <div style="font:12px/1.3 system-ui,Segoe UI,Roboto,Arial">
        <div><b>Marking:</b> ${escapeHtml(p.kind || 'mark')}</div>
        <div><b>Side/Lane:</b> ${p.side||'n/a'} ${p.laneId ?? ''}</div>
        <div><b>Road:</b> #${p.roadId}</div>
        <div><b>Run s:</b> ${Number(p.s0||0).toFixed(2)} → ${Number(p.s1||0).toFixed(2)} m</div>
        <div><b>Sections:</b> ${Number(p.secStartS||0).toFixed(2)} → ${Number(p.secEndS||0).toFixed(2)} m</div>
      </div>`;
    try {
      hoverPopup.setLngLat(e.lngLat).setHTML(buildMarkingHtml(p)).addTo(map);
    } catch {
      hoverPopup.setLngLat(e.lngLat).setHTML(html).addTo(map);
    }
  });
  
  map.on('mouseleave', 'xodr-markings', () => {
    hoverMarkId = null;
    try { map.setFilter('xodr-marking-hover', ['==', 'mid', '']); } catch {}
    if (hoverPopup) hoverPopup.remove();
  });
  
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[c]));
}

// Build HTML for marking popup, including roadMark attributes if present
function buildMarkingHtml(p) {
  const rmType = p.roadmark ? String(p.roadmark) : '';
  const rmColor = p.roadmarkColor ? `, ${p.roadmarkColor}` : '';
  const rmWidth = (p.roadmarkWidth!=null && isFinite(p.roadmarkWidth)) ? `, ${Number(p.roadmarkWidth).toFixed(3)} m` : '';
  const rmMat = p.roadmarkMaterial ? `<div><b>Material:</b> ${escapeHtml(p.roadmarkMaterial)}</div>` : '';
  const rmLC = p.roadmarkLaneChange ? `<div><b>Lane change:</b> ${escapeHtml(p.roadmarkLaneChange)}</div>` : '';
  const rmLine = rmType ? `<div><b>RoadMark:</b> ${escapeHtml(rmType)}${escapeHtml(rmColor)}${escapeHtml(rmWidth)}</div>` : '';
  return `
      <div style="font:12px/1.3 system-ui,Segoe UI,Roboto,Arial">
        <div><b>Marking:</b> ${escapeHtml(p.kind || 'mark')}</div>
        <div><b>Side/Lane:</b> ${p.side||'n/a'} ${p.laneId ?? ''}</div>
        <div><b>Road:</b> #${p.roadId}</div>
        ${rmLine}
        ${rmMat}
        ${rmLC}
        <div><b>Run s:</b> ${Number(p.s0||0).toFixed(2)} → ${Number(p.s1||0).toFixed(2)} m</div>
        <div><b>Sections:</b> ${Number(p.secStartS||0).toFixed(2)} → ${Number(p.secEndS||0).toFixed(2)} m</div>
      </div>`;
}

// Build HTML for lane popup; include roadmark if present in props
function buildLaneHtml(p) {
  const rmType = p.roadmark ? `<div><b>RoadMark:</b> ${escapeHtml(String(p.roadmark))}</div>` : '';
  const rmColor = p.roadmarkColor ? `<div><b>RoadMark color:</b> ${escapeHtml(String(p.roadmarkColor))}</div>` : '';
  const rmWidth = (p.roadmarkWidth!=null && isFinite(p.roadmarkWidth)) ? `<div><b>RoadMark width:</b> ${Number(p.roadmarkWidth).toFixed(3)} m</div>` : '';
  const rmMat = p.roadmarkMaterial ? `<div><b>Material:</b> ${escapeHtml(String(p.roadmarkMaterial))}</div>` : '';
  const rmLC = p.roadmarkLaneChange ? `<div><b>Lane change:</b> ${escapeHtml(String(p.roadmarkLaneChange))}</div>` : '';
  return `
      <div style="font:12px/1.3 system-ui,Segoe UI,Roboto,Arial">
        <div><b>Road:</b> ${escapeHtml(p.roadName || '')} <span style="opacity:.6">(#${p.roadId})</span></div>
        <div><b>Lane:</b> ${p.side} ${p.laneId} <span style="opacity:.6">(${p.laneType||'n/a'})</span></div>`+
        //${rmType}${rmColor}${rmWidth}${rmMat}${rmLC}
        `<div><b>Run s:</b> ${Number(p.s0||0).toFixed(2)} → ${Number(p.s1||0).toFixed(2)} m</div>
        <div><b>Sections:</b> ${Number(p.secStartS||0).toFixed(2)} → ${Number(p.secEndS||0).toFixed(2)} m</div>
      </div>`;
}
