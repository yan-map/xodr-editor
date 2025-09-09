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
// Expose map instance for editor.js (modules are scoped)
window.XODR_MAP = map;

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

// Editor logic moved to editor.js

// Geometry quality state (0..100, higher = finer)
const QUALITY_PRESETS = {
  poor:   { step: 2.0,  maxAngle: 0.10 },  // очень грубо, стабильно
  normal: { step: 1.0,  maxAngle: 0.05 },  // штатный базовый
  high:   { step: 0.5,  maxAngle: 0.03 },  // высокая
  ultra:  { step: 0.25, maxAngle: 0.015 }, // супер высокая
};
let qualityPreset = 'normal';
function getQualityOptions() {
  return QUALITY_PRESETS[qualityPreset] || QUALITY_PRESETS.normal;
}

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

  // Quality preset selector
  const qp = document.getElementById('qualityPreset');
  if (qp) {
    const applyQuality = () => {
      const val = (qp.value || '').toLowerCase();
      qualityPreset = QUALITY_PRESETS[val] ? val : 'normal';
      if (currentModel) {
        const projector = makeProjector(currentModel.header.lat0, currentModel.header.lon0);
        const geo = buildGeometry(currentModel, projector, getQualityOptions());
        currentGeo = geo;
        if (mapLoaded) updateSources(geo);
      }
    };
    applyQuality();
    qp.addEventListener('change', applyQuality);
  }

  // Editor UI wired in editor.js

  // Try to load bundled test.xodr automatically
  fetch('test.xodr').then(r => r.text()).then(t => { lastXodrText = t; loadXodr(t); }).catch(() => {});
});

function loadXodr(xmlText) {
  try {
    const model = parseOpenDrive(xmlText);
    currentModel = model;
    const projector = makeProjector(model.header.lat0, model.header.lon0);
    const geo = buildGeometry(model, projector, getQualityOptions());
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

function buildGeometry(model, projector, opts) {
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

    // Build required s-positions along road for straight segments
    const enforceS = new Set();
    enforceS.add(0);
    if (Number.isFinite(road.length)) enforceS.add(road.length);
    // planView boundaries
    for (const g of (road.planView || [])) {
      const s0 = Number(g.s) || 0;
      const Lg = Number(g.length) || 0;
      enforceS.add(s0);
      if (Lg > 0) enforceS.add(s0 + Lg);
    }
    // laneSections and width records
    for (const ls of (road.laneSections || [])) {
      const secS = Number(ls.s) || 0;
      enforceS.add(secS);
      const pushWidths = (arr) => {
        for (const ln of (arr || [])) {
          const widths = ln.widths || [];
          widths.forEach(w => enforceS.add(secS + (Number(w.sOffset) || 0)));
        }
      };
      pushWidths(ls.left); pushWidths(ls.right);
    }
    // laneOffsets (carriageway lateral offset polylines)
    for (const lo of (road.laneOffsets || [])) {
      enforceS.add(Number(lo.s) || 0);
    }

    // Subdivide width and laneOffset intervals using slope-aware step to capture curvature when center is straight
    const factorStep = opts?.step ?? 0.6;
    const widthDSMax = Math.max(0.5, Math.min(25, factorStep * 12));
    // Сделаем ограничение угла для кривых ширины ближе к плановым кривым, чтобы детализация была однородной
    const widthAngleBound = Math.min(0.08, Math.max(0.01, (opts?.maxAngle ?? 0.03)));
    const addSubdiv = (s0, s1, ds) => {
      if (!(s1 > s0)) return;
      let t = s0 + ds;
      while (t < s1 - 1e-6) { enforceS.add(t); t += ds; }
    };
    const maxAbs = (vals) => vals.reduce((m,v)=>Math.max(m, Math.abs(v)), 0);
    const dsFromSlope = (maxSlope) => {
      if (!(maxSlope > 1e-9)) return widthDSMax;
      const byAngle = widthAngleBound / maxSlope;
      return Math.max(0.5, Math.min(widthDSMax, byAngle));
    };
    // For each section and lane width piece
    for (const ls of (road.laneSections || [])) {
      const secS = Number(ls.s) || 0;
      const secEnd = (function(){
        // next section start or road end
        const next = (road.laneSections || []).map(x=>x.s||0).filter(s=>s>secS).sort((a,b)=>a-b)[0];
        return Number.isFinite(next) ? next : (road.length||0);
      })();
      const handleSide = (arr) => {
        for (const ln of (arr || [])) {
          const ws = (ln.widths || []).slice().sort((a,b)=>(a.sOffset||0)-(b.sOffset||0));
          for (let i=0;i<ws.length;i++){
            const a = ws[i];
            const sStart = secS + (Number(a.sOffset)||0);
            const sEnd = (i+1<ws.length) ? (secS + (Number(ws[i+1].sOffset)||0)) : secEnd;
            // slope of width poly3 over local ds in [0, D]
            const D = Math.max(0, sEnd - sStart);
            const b = Number(a.b)||0, c = Number(a.c)||0, d = Number(a.d)||0;
            // m(ds) = b + 2c*ds + 3d*ds^2; check endpoints and critical point ds* = -c/(3d)
            const candidates = [0, D];
            if (Math.abs(d) > 1e-12) {
              const dsc = -c / (3*d);
              if (dsc > 0 && dsc < D) candidates.push(dsc);
            }
            const slopes = candidates.map(ds => b + 2*c*ds + 3*d*ds*ds);
            const maxSlope = maxAbs(slopes);
            const ds = dsFromSlope(maxSlope);
            addSubdiv(sStart, sEnd, ds);
          }
        }
      };
      handleSide(ls.left); handleSide(ls.right);
    }
    // Subdivide laneOffset intervals
    const los = (road.laneOffsets || []).slice().sort((a,b)=>(a.s||0)-(b.s||0));
    for (let i=0;i<los.length;i++){
      const rec = los[i];
      const s0 = Number(rec.s)||0;
      const s1 = (i+1<los.length) ? (Number(los[i+1].s)||0) : (road.length||0);
      const D = Math.max(0, s1 - s0);
      const b = Number(rec.b)||0, c = Number(rec.c)||0, d = Number(rec.d)||0;
      const candidates = [0, D];
      if (Math.abs(d) > 1e-12) {
        const dsc = -c / (3*d);
        if (dsc > 0 && dsc < D) candidates.push(dsc);
      }
      const slopes = candidates.map(ds => b + 2*c*ds + 3*d*ds*ds);
      const maxSlope = maxAbs(slopes);
      const ds = dsFromSlope(maxSlope);
      addSubdiv(s0, s1, ds);
    }

    const ticks = Array.from(enforceS).filter(Number.isFinite).sort((a,b)=>a-b);

    let samples = sampleGeometrySequence(road.planView, { step: opts?.step ?? 0.6, maxAngle: opts?.maxAngle ?? 0.03, forceS: ticks });
    // Build simplified centerline samples: compress straight segments to endpoints
    const centerSamples = simplifyCenterlineSamples(samples, road.planView);
    if (samples.length < 2) continue;

    // bounds in local xy
    for (const [x, y] of samples) {
      if (x < minx) minx = x; if (y < miny) miny = y; if (x > maxx) maxx = x; if (y > maxy) maxy = y;
    }

    centerFeatures.push(toLineString(centerSamples, projector));

    // lanes: compute per-s sample offsets for each lane id on both sides
    // enrich samples: enforce points at laneSection boundaries and width sOffsets to preserve exact joins
    // ensure samples include exact tick points on curves too (interpolate/insert)
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

// Simplify centerline samples: for straight planView segments keep only endpoints; keep all for curved
function simplifyCenterlineSamples(samples, geoms) {
  try {
    if (!Array.isArray(samples) || !Array.isArray(geoms) || geoms.length === 0) return samples;
    const out = [];
    const eps = 1e-9;
    for (const g of geoms) {
      const s0 = Number(g.s) || 0;
      const L = Number(g.length) || 0;
      const s1 = s0 + L;
      const seg = samples.filter(p => p[3] >= s0 - eps && p[3] <= s1 + eps);
      if (!seg.length) continue;
      const isLine = (g.type === 'line');
      if (isLine) {
        // Keep all existing samples for lines (these are already only ticks/endpoints)
        for (const p of seg) {
          if (!out.length || out[out.length - 1][3] < p[3] - eps) out.push(p);
        }
      } else {
        // Keep dense samples for curved segments; avoid duplicate at joints
        for (let i = 0; i < seg.length; i++) {
          const p = seg[i];
          if (!out.length || out[out.length - 1][3] < p[3] - eps) out.push(p);
        }
      }
    }
    // Ensure strictly increasing s and at least 2 points
    const dedup = [];
    for (const p of out) {
      if (!dedup.length || p[3] > dedup[dedup.length - 1][3] + 1e-9) dedup.push(p);
    }
    return dedup.length >= 2 ? dedup : samples;
  } catch {
    return samples;
  }
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

// Editor layers (intersections)
function ensureEditorLayers() {
  if (!map.getSource('editor-intersections')) {
    map.addSource('editor-intersections', { type: 'geojson', data: fc() });
    map.addLayer({ id: 'editor-intersections', type: 'circle', source: 'editor-intersections', paint: { 'circle-radius': 3, 'circle-color': '#ff3d00', 'circle-stroke-width': 1, 'circle-stroke-color': '#ffffff' } });
  }
  if (!map.getSource('editor-roads')) {
    map.addSource('editor-roads', { type: 'geojson', data: fc() });
    map.addLayer({ id: 'editor-roads', type: 'line', source: 'editor-roads', paint: { 'line-color': '#222', 'line-width': 2, 'line-opacity': 0.6 } });
    map.addLayer({ id: 'editor-roads-hover', type: 'line', source: 'editor-roads', paint: { 'line-color': '#3b82f6', 'line-width': 12, 'line-opacity': 0.18 }, filter: ['==',['id'],''] });
    try { map.moveLayer('editor-roads'); map.moveLayer('editor-roads-hover'); } catch {}
  }
  if (!map.getSource('editor-snap')) {
    map.addSource('editor-snap', { type: 'geojson', data: fc() });
    map.addLayer({ id: 'editor-snap', type: 'circle', source: 'editor-snap', paint: { 'circle-radius': 5, 'circle-color': '#3b82f6', 'circle-stroke-width': 1, 'circle-stroke-color': '#fff', 'circle-opacity': 0.7 } });
    try { map.moveLayer('editor-snap'); } catch {}
  }
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

// ===== Editor: Draw + Intersections =====
function setIntersections(points) {
  intersections = points || [];
  try { if (map.getSource('editor-intersections')) map.getSource('editor-intersections').setData(fc(intersections)); } catch {}
}

function updateEditorRoadsSource() {
  try {
    const feats = Array.from(roadsById.values()).map(f => ({ type:'Feature', id: f.id, properties: { id: f.id }, geometry: f.geometry }));
    if (map.getSource('editor-roads')) map.getSource('editor-roads').setData(fc(feats));
  } catch {}
}

function attachDrawHandlers() {
  if (!draw || attachDrawHandlers._done) return; attachDrawHandlers._done = true;
  map.on('draw.create', (e) => { for (const f of (e.features || [])) onRoadCreateFinalize(f); });
  map.on('draw.update', (e) => { for (const f of (e.features || [])) onRoadUpdateMaybe(f); });
  map.on('draw.delete', (e) => { for (const f of (e.features || [])) onRoadDelete(f); });
  // Ctrl+Z undo
  document.addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'z' || ev.key === 'Z')) { ev.preventDefault(); undoLast(); }
  }, true);
  // hover and click behavior over editor roads (only when editing enabled)
  map.on('mousemove', (e) => {
    const mode = (draw && draw.getMode && draw.getMode()) || '';
    const drawing = mode === 'draw_line_string';
    const allowHover = editingEnabled && !drawing;
    if (allowHover) {
      const hits = map.queryRenderedFeatures(e.point, { layers: ['editor-roads'] });
      const id = (hits[0] && (hits[0].id || hits[0].properties?.id)) || '';
      try { map.setFilter('editor-roads-hover', ['==', ['id'], id || '']); } catch {}
      map.getCanvas().style.cursor = id ? 'pointer' : '';
    } else {
      try { map.setFilter('editor-roads-hover', ['==', ['id'], '']); } catch {}
      map.getCanvas().style.cursor = '';
    }
    // live snap preview while drawing or editing a vertex
    if (drawing || (editingEnabled && (mode === 'direct_select'))) {
      const snapped = snapLngLat([e.lngLat.lng, e.lngLat.lat]);
      snapPreview = snapped;
      try { map.getSource('editor-snap').setData(fc([ { type:'Feature', geometry:{ type:'Point', coordinates: snapped }, properties:{} } ])); } catch {}
      // live snap while dragging: move nearest vertex of selected feature towards snapped point
      if (mode === 'direct_select') {
        try { applySnapToSelectedNearestVertex(); } catch {}
      }
    } else {
      try { map.getSource('editor-snap').setData(fc()); } catch {}
      snapPreview = null;
    }
  });
  map.on('click', 'editor-roads', (e) => {
    if (!editingEnabled) return;
    const f = (e.features && e.features[0]) || null; if (!f) return;
    const id = f.id || f.properties?.id; if (!id) return;
    // Enter direct_select to prevent moving entire line; show Draw layers
    try {
      if (draw) {
        loadDrawFromStore();
        setDrawVisibility(true);
        draw.changeMode('direct_select', { featureId: id });
      }
    } catch {}
  });
  // keep static mode when editing disabled, except immediately after a create
  map.on('draw.selectionchange', () => {
    if (!editingEnabled) {
      const sel = (draw && draw.getSelectedIds && draw.getSelectedIds()) || [];
      if (!(sel.length === 1 && sel[0] === tempEditableId)) {
        tempEditableId = null;
        try { draw.changeMode('static'); } catch {}
      }
    }
  });
  map.on('draw.modechange', () => {
    // snap after each click while drawing: adjust last coordinate to snapPreview
    const mode = (draw && draw.getMode && draw.getMode()) || '';
    if (mode !== 'draw_line_string') return;
    setTimeout(() => applySnapToActiveLastVertex(), 0);
  });
}

function loadDrawFromStore() {
  if (!draw) return;
  try {
    const feats = Array.from(roadsById.values()).map(f => JSON.parse(JSON.stringify(f)));
    for (const f of feats) { try { draw.add(f); } catch {} }
  } catch {}
}

function persistDrawIntoStore() {
  if (!draw) return;
  try {
    const all = draw.getAll();
    const feats = (all?.features || []).filter(f=>f.geometry?.type==='LineString');
    for (const f of feats) {
      onRoadUpsert(f);
    }
  } catch {}
}

function clearDrawAll() {
  if (!draw) return;
  try {
    const all = draw.getAll();
    for (const f of (all?.features || [])) { try { draw.delete(f.id); } catch {} }
  } catch {}
}

function featureBBox(feat) { try { return turf.bbox(feat); } catch { return null; } }
function pairKey(a, b) { return a < b ? `${a}|${b}` : `${b}|${a}`; }

function onRoadUpsert(f) {
  if (!f || f.geometry?.type !== 'LineString') return;
  const id = f.id || f.properties?.id || f.properties?.fid || `road_${Math.random().toString(36).slice(2,9)}`;
  f.id = id;
  // clone to store
  const clone = JSON.parse(JSON.stringify(f));
  // Snap all vertices to nearest candidates (optional)
  clone.geometry.coordinates = (clone.geometry.coordinates || []).map(([lng, lat]) => snapLngLat([lng, lat]));
  // history
  if (!freezeHistory) {
    const prev = roadsById.get(id) ? JSON.parse(JSON.stringify(roadsById.get(id))) : null;
    editorHistory.push({ type: 'upsert', id, prev });
  }
  roadsById.set(id, clone);
  updateEditorRoadsSource();
  if (roadIndex) {
    try {
      const all = roadIndex.all();
      const prev = (all?.features || []).find(g => g.id === id);
      if (prev) roadIndex.remove(prev);
      clone.bbox = featureBBox(clone);
      roadIndex.insert(clone);
    } catch {}
  }
  updateIntersectionsFor(id);
}

function onRoadDelete(f) {
  const id = f?.id || f?.properties?.id || f?.properties?.fid; if (!id) return;
  if (!freezeHistory) {
    const prev = roadsById.get(id) ? JSON.parse(JSON.stringify(roadsById.get(id))) : null;
    editorHistory.push({ type: 'delete', id, prev });
  }
  if (roadIndex) {
    try {
      const prev = (roadIndex.all()?.features || []).find(g => g.id === id);
      if (prev) roadIndex.remove(prev);
    } catch {}
  }
  roadsById.delete(id);
  updateEditorRoadsSource();
  setIntersections(intersections.filter(p => !(p.properties && (p.properties.a===id || p.properties.b===id))));
}

function neighborsFor(id) {
  const f = roadsById.get(id); if (!f) return [];
  if (roadIndex) {
    try {
      const bb = featureBBox(f);
      const search = roadIndex.search({ type:'Feature', bbox: bb, geometry:{ type:'Polygon', coordinates: [] } });
      const feats = (search?.features || []).filter(g => g.id !== id);
      return feats.map(g => roadsById.get(g.id)).filter(Boolean);
    } catch {}
  }
  return Array.from(roadsById.values()).filter(r => r.id !== id);
}

function updateIntersectionsFor(id) {
  const a = roadsById.get(id); if (!a) return;
  const others = neighborsFor(id);
  const keep = intersections.filter(p => !(p.properties && (p.properties.a===id || p.properties.b===id)));
  const added = [];
  for (const b of others) {
    try {
      const res = turf.lineIntersect(a, b);
      for (const pt of (res?.features || [])) {
        const p = JSON.parse(JSON.stringify(pt));
        p.properties = Object.assign({}, p.properties||{}, { kind:'intersection', a:id, b:b.id, key: pairKey(id,b.id) });
        p.id = `x_${id}_${b.id}_${Math.round(p.geometry.coordinates[0]*1000)}_${Math.round(p.geometry.coordinates[1]*1000)}`;
        added.push(p);
      }
    } catch {}
  }
  setIntersections([...keep, ...added]);
}

// === Draw styling and visibility control ===
function setDrawStyling() {
  const set = (id, prop, val) => { try { map.setPaintProperty(id, prop, val); } catch {} };
  // active line more visible
  set('gl-draw-line-active', 'line-color', '#3b82f6');
  set('gl-draw-line-active', 'line-width', 4);
  set('gl-draw-line-active', 'line-opacity', 0.9);
  // inactive line thick but transparent (we keep it hidden via visibility, but style anyway)
  set('gl-draw-line-inactive', 'line-color', '#3b82f6');
  set('gl-draw-line-inactive', 'line-width', 12);
  set('gl-draw-line-inactive', 'line-opacity', 0.1);
}

function setDrawVisibility(show) {
  const setVis = (id, vis) => { try { map.setLayoutProperty(id, 'visibility', vis); } catch {} };
  // show only active + vertices when editing; keep inactive hidden to avoid selectable look
  const visActive = show ? 'visible' : 'none';
  const visInactive = show ? 'none' : 'none';
  const layers = [
    'gl-draw-line-inactive',
    'gl-draw-line-active',
    'gl-draw-polygon-and-line-vertex-halo-active',
    'gl-draw-polygon-and-line-vertex-active',
    'gl-draw-polygon-and-line-midpoint',
  ];
  for (const id of layers) {
    const vis = (id.indexOf('line-active')>=0 || id.indexOf('vertex')>=0 || id.indexOf('midpoint')>=0) ? visActive : visInactive;
    setVis(id, vis);
  }
}

// When a line is created, finalize with snapping then upsert
function onRoadCreateFinalize(f) {
  if (!f || f.geometry?.type !== 'LineString') return;
  // Snap coordinates and update Draw feature
  const coords = (f.geometry.coordinates || []).map(([lng, lat]) => snapLngLat([lng, lat]));
  try {
    // Replace feature geometry in Draw
    const fresh = draw.get(f.id) || f;
    if (fresh) {
      fresh.geometry.coordinates = coords;
      draw.add(fresh); // add updates existing by id
    }
  } catch {}
  onRoadUpsert({ ...f, geometry: { type:'LineString', coordinates: coords } });
  // allow immediate editing of this newly created feature even if editingEnabled=false
  tempEditableId = f.id;
  try {
    loadDrawFromStore();
    setDrawVisibility(true);
    draw.changeMode('direct_select', { featureId: f.id });
  } catch {}
}

// Update handler that respects editingEnabled flag; revert if editing disabled
function onRoadUpdateMaybe(f) {
  if (!editingEnabled) {
    // revert to stored version
    const id = f?.id || f?.properties?.id || f?.properties?.fid; if (!id) return;
    const prev = roadsById.get(id);
    if (prev) {
      try {
        freezeHistory = true;
        draw.add(JSON.parse(JSON.stringify(prev)));
      } finally { freezeHistory = false; }
    }
    return;
  }
  // While editing, reflect changes into store and proxy immediately
  freezeHistory = true;
  try { onRoadUpsert(f); } finally { freezeHistory = false; }
}

// Undo last editor action
function undoLast() {
  const act = editorHistory.pop();
  if (!act) return;
  if (act.type === 'upsert') {
    // revert to prev (null => delete)
    freezeHistory = true;
    try {
      if (!act.prev) {
        // delete current
        const cur = roadsById.get(act.id);
        if (cur) onRoadDelete(cur);
        if (draw) try { draw.delete(act.id); } catch {}
      } else {
        // restore prev
        const prev = JSON.parse(JSON.stringify(act.prev));
        if (draw) try { draw.add(prev); } catch {}
        onRoadUpsert(prev);
      }
    } finally { freezeHistory = false; }
  } else if (act.type === 'delete') {
    // re-add deleted feature
    if (act.prev) {
      freezeHistory = true;
      try {
        const prev = JSON.parse(JSON.stringify(act.prev));
        if (draw) try { draw.add(prev); } catch {}
        onRoadUpsert(prev);
      } finally { freezeHistory = false; }
    }
  }
}

// Snapping utility: snap lng/lat to nearest vertex of nearby roads and intersections
function snapLngLat([lng, lat]) {
  try {
    if (!(snapRangeMeters > 0)) return [lng, lat];
    const rangeM = snapRangeMeters;
    const latRad = (lat * Math.PI) / 180;
    const dLng = (rangeM / (111320 * Math.cos(latRad)));
    const dLat = (rangeM / 110540);
    const bbox = [lng - dLng, lat - dLat, lng + dLng, lat + dLat];
    const pt = turf.point([lng, lat]);
    let best = null;
    function score(candidateCoord) {
      const d = turf.distance(pt, turf.point(candidateCoord), { units: 'meters' });
      if (d <= rangeM && (!best || d < best.d)) best = { c: candidateCoord, d };
    }
    // Intersections first for strong snapping
    for (const p of intersections) score(p.geometry.coordinates);
    // Nearby roads
    let candidates = [];
    if (roadIndex) {
      try {
        const hits = roadIndex.search({ type:'Feature', bbox, geometry:{type:'Polygon', coordinates:[]} });
        candidates = (hits?.features || []).map(g => roadsById.get(g.id)).filter(Boolean);
      } catch {}
    }
    if (candidates.length === 0) candidates = Array.from(roadsById.values());
    for (const f of candidates) {
      const coords = f.geometry?.coordinates || [];
      // vertices
      for (const c of coords) score(c);
      // segments (nearest point on line)
      try {
        const line = { type:'Feature', geometry:{ type:'LineString', coordinates: coords }, properties:{} };
        const snap = turf.nearestPointOnLine(line, pt, { units: 'meters' });
        if (snap && Array.isArray(snap.geometry?.coordinates)) score(snap.geometry.coordinates);
      } catch {}
    }
    return best ? best.c : [lng, lat];
  } catch {
    return [lng, lat];
  }
}

// Adjust last coordinate of the active drawing feature to snapPreview point
function applySnapToActiveLastVertex() {
  try {
    const mode = (draw && draw.getMode && draw.getMode()) || '';
    if (mode !== 'draw_line_string') return;
    if (!snapPreview) return;
    const all = draw.getAll();
    const feats = (all && all.features) || [];
    if (!feats.length) return;
    // heuristic: the last feature is the one being drawn
    const f = feats[feats.length - 1];
    if (!f || f.geometry?.type !== 'LineString') return;
    const coords = f.geometry.coordinates || [];
    if (coords.length === 0) return;
    coords[coords.length - 1] = snapPreview.slice();
    f.geometry.coordinates = coords;
    draw.add(f);
  } catch {}
}

function applySnapToSelectedNearestVertex() {
  if (!draw || !snapPreview) return;
  try {
    const sel = draw.getSelected();
    const feats = (sel && sel.features) || [];
    if (!feats.length) return;
    const sp = turf.point(snapPreview);
    for (const f of feats) {
      if (f.geometry?.type !== 'LineString') continue;
      const coords = f.geometry.coordinates || [];
      if (coords.length === 0) continue;
      // find nearest vertex to snapPreview
      let bestI = -1, bestD = Infinity;
      for (let i=0;i<coords.length;i++) {
        const d = turf.distance(sp, turf.point(coords[i]), { units: 'meters' });
        if (d < bestD) { bestD = d; bestI = i; }
      }
      if (bestI >= 0 && bestD <= snapRangeMeters) {
        coords[bestI] = snapPreview.slice();
        f.geometry.coordinates = coords;
        freezeHistory = true;
        try {
          draw.add(f);
          onRoadUpsert(f);
        } finally { freezeHistory = false; }
      }
    }
  } catch {}
}
