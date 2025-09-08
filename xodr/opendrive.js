// Minimal OpenDRIVE (.xodr) parser: header (geoReference), roads (planView + lanes)
// Focus: planView geometries (line, arc, spiral, paramPoly3) and lane widths per section.

function textOf(el) {
  return el && (el.textContent || '').trim();
}

export function parseOpenDrive(xmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'application/xml');
  const err = doc.querySelector('parsererror');
  if (err) throw new Error('XML parse error');

  const header = doc.querySelector('OpenDRIVE > header');
  const geoRefNode = header && header.querySelector('geoReference');
  const geoRef = geoRefNode ? textOf(geoRefNode) : '';
  const lat0 = findNumberInCrs(geoRef, 'lat_0');
  const lon0 = findNumberInCrs(geoRef, 'lon_0');

  const roads = [];
  doc.querySelectorAll('OpenDRIVE > road').forEach((r) => {
    const id = r.getAttribute('id');
    const name = r.getAttribute('name') || '';
    const length = num(r.getAttribute('length'));
    const planView = [];
    r.querySelectorAll(':scope > planView > geometry').forEach((g) => {
      const base = {
        s: num(g.getAttribute('s')),
        x: num(g.getAttribute('x')),
        y: num(g.getAttribute('y')),
        hdg: num(g.getAttribute('hdg')),
        length: num(g.getAttribute('length')),
      };
      if (g.querySelector(':scope > line')) {
        planView.push({ ...base, type: 'line' });
      } else if (g.querySelector(':scope > arc')) {
        const arc = g.querySelector(':scope > arc');
        planView.push({ ...base, type: 'arc', curvature: num(arc.getAttribute('curvature')) });
      } else if (g.querySelector(':scope > spiral')) {
        const sp = g.querySelector(':scope > spiral');
        // attributes vary by spec; try common names
        const curvStart = num(sp.getAttribute('curvStart') || sp.getAttribute('curvatureStart'));
        const curvEnd = num(sp.getAttribute('curvEnd') || sp.getAttribute('curvatureEnd'));
        planView.push({ ...base, type: 'spiral', curvStart, curvEnd });
      } else if (g.querySelector(':scope > paramPoly3')) {
        const p = g.querySelector(':scope > paramPoly3');
        planView.push({
          ...base,
          type: 'poly3',
          aU: num(p.getAttribute('aU')),
          bU: num(p.getAttribute('bU')),
          cU: num(p.getAttribute('cU')),
          dU: num(p.getAttribute('dU')),
          aV: num(p.getAttribute('aV')),
          bV: num(p.getAttribute('bV')),
          cV: num(p.getAttribute('cV')),
          dV: num(p.getAttribute('dV')),
        });
      }
    });

    // laneOffset entries (can appear multiple times with different s)
    const laneOffsets = [];
    r.querySelectorAll(':scope > lanes > laneOffset').forEach((lo) => {
      laneOffsets.push({
        s: num(lo.getAttribute('s')) || 0,
        a: num(lo.getAttribute('a')) || 0,
        b: num(lo.getAttribute('b')) || 0,
        c: num(lo.getAttribute('c')) || 0,
        d: num(lo.getAttribute('d')) || 0,
      });
    });
    laneOffsets.sort((a,b) => (a.s||0) - (b.s||0));

    const laneSections = [];
    r.querySelectorAll(':scope > lanes > laneSection').forEach((ls) => {
      const s = num(ls.getAttribute('s'));
      const left = readLanes(ls.querySelector(':scope > left'));
      const center = readLanes(ls.querySelector(':scope > center'));
      const right = readLanes(ls.querySelector(':scope > right'));
      laneSections.push({ s, left, center, right });
    });

    roads.push({ id, name, length, planView, laneSections, laneOffsets });
  });

  return { header: { lat0, lon0, geoRef }, roads };
}

// no-op: laneOffsets parsed as array on road

function readLanes(container) {
  const lanes = [];
  if (!container) return lanes;
  container.querySelectorAll(':scope > lane').forEach((lane) => {
    const id = num(lane.getAttribute('id'));
    const type = lane.getAttribute('type') || 'none';
    const link = lane.querySelector(':scope > link');
    const predecessor = link && link.querySelector(':scope > predecessor') ? num(link.querySelector(':scope > predecessor').getAttribute('id')) : undefined;
    const successor = link && link.querySelector(':scope > successor') ? num(link.querySelector(':scope > successor').getAttribute('id')) : undefined;
    // collect widths segments
    const widths = [];
    lane.querySelectorAll(':scope > width').forEach((w) => {
      widths.push({
        sOffset: num(w.getAttribute('sOffset')),
        a: num(w.getAttribute('a')),
        b: num(w.getAttribute('b')),
        c: num(w.getAttribute('c')),
        d: num(w.getAttribute('d')),
      });
    });
    // collect roadMark segments (e.g., type, color, width, material, laneChange)
    const roadMarks = [];
    lane.querySelectorAll(':scope > roadMark').forEach((rm) => {
      roadMarks.push({
        sOffset: num(rm.getAttribute('sOffset')) || 0,
        type: rm.getAttribute('type') || 'none',
        color: rm.getAttribute('color') || undefined,
        width: num(rm.getAttribute('width')),
        material: rm.getAttribute('material') || undefined,
        laneChange: rm.getAttribute('laneChange') || undefined,
        weight: rm.getAttribute('weight') || undefined,
        height: num(rm.getAttribute('height')),
        rule: rm.getAttribute('rule') || undefined,
      });
    });
    roadMarks.sort((a,b) => (a.sOffset||0) - (b.sOffset||0));
    lanes.push({ id, type, widths, roadMarks, predecessor, successor });
  });
  // sort by id descending on left (positive), ascending on right (negative)
  return lanes.sort((a, b) => b.id - a.id);
}

export function laneWidthAt(widths, sInSection) {
  if (!widths || widths.length === 0) return 0;
  // pick last segment with sOffset <= sInSection
  let seg = widths[0];
  for (const w of widths) {
    if (sInSection + 1e-9 >= w.sOffset) seg = w;
  }
  const ds = sInSection - seg.sOffset;
  return seg.a + seg.b * ds + seg.c * ds * ds + seg.d * ds * ds * ds;
}

function findNumberInCrs(crsText, key) {
  if (!crsText) return undefined;
  const m = new RegExp(`${key}=([0-9eE+\-.]+)`).exec(crsText);
  if (m) return Number(m[1]);
  return undefined;
}

function num(v) {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
