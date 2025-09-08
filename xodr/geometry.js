// Lightweight geometry utilities to sample OpenDRIVE planView segments
// Supports: line, arc, spiral (numeric), with helpers to offset polylines.

export function sampleGeometrySequence(geoms, opts = {}) {
  const baseStep = opts.step || 0.7; // target max chord length (m)
  const maxAngle = opts.maxAngle || 0.03; // rad per segment
  const out = [];
  for (const g of geoms) {
    const baseS = Number(g.s) || 0;
    const pts = sampleSegmentAdaptive(g, { baseStep, maxAngle });
    // convert local s -> absolute s along road
    for (const p of pts) p[3] = baseS + (p[3] || 0);
    if (out.length && pts.length) {
      // drop first to avoid duplicate vertex at joints
      pts.shift();
    }
    out.push(...pts);
  }
  return out;
}

export function sampleSegment(geom, step = 1.0) {
  const { x, y, hdg, length, type } = geom;
  const pts = [];
  if (!isFinite(length) || length <= 0) return pts;

  const n = Math.max(1, Math.ceil(length / step));
  const ds = length / n;

  if (type === 'line') {
    for (let i = 0; i <= n; i++) {
      const s = i * ds;
      const px = x + s * Math.cos(hdg);
      const py = y + s * Math.sin(hdg);
      const th = hdg;
      pts.push([px, py, th, s]);
    }
  } else if (type === 'arc') {
    const k = Number(geom.curvature) || 0; // 1/R
    if (Math.abs(k) < 1e-12) {
      // fallback to line
      for (let i = 0; i <= n; i++) {
        const s = i * ds;
        const px = x + s * Math.cos(hdg);
        const py = y + s * Math.sin(hdg);
        const th = hdg;
        pts.push([px, py, th, s]);
      }
    } else {
      const invk = 1 / k;
      for (let i = 0; i <= n; i++) {
        const s = i * ds;
        const th = hdg + k * s;
        const px = x + (Math.sin(th) - Math.sin(hdg)) * invk;
        const py = y - (Math.cos(th) - Math.cos(hdg)) * invk;
        pts.push([px, py, th, s]);
      }
    }
  } else if (type === 'spiral') {
    // Numeric integration for clothoid with curvature varying linearly from k0 to k1
    const k0 = Number(geom.curvStart) || 0;
    const k1 = Number(geom.curvEnd) || 0;
    const L = length;
    const dk = (k1 - k0) / L;
    let px = x, py = y;
    let th = hdg;
    pts.push([px, py, th, 0]);
    for (let i = 1; i <= n; i++) {
      const s1 = (i - 1) * ds;
      const s2 = i * ds;
      // integrate heading over [s1, s2]: th(s) = hdg + k0*s + 0.5*dk*s^2
      const th1 = hdg + k0 * s1 + 0.5 * dk * s1 * s1;
      const th2 = hdg + k0 * s2 + 0.5 * dk * s2 * s2;
      // 2-point midpoint for cos/sin path increment
      const thm = 0.5 * (th1 + th2);
      const dx = ds * Math.cos(thm);
      const dy = ds * Math.sin(thm);
      px += dx;
      py += dy;
      th = th2;
      pts.push([px, py, th, s2]);
    }
  } else if (type === 'poly3') {
    // ParamPoly3: x(s) = aU + bU*s + cU*s^2 + dU*s^3; y(s) similar, in local heading frame
    const { aU, bU, cU, dU, aV, bV, cV, dV } = geom;
    const cosH = Math.cos(hdg), sinH = Math.sin(hdg);
    for (let i = 0; i <= n; i++) {
      const s = i * ds;
      const u = aU + bU * s + cU * s * s + dU * s * s * s;
      const v = aV + bV * s + cV * s * s + dV * s * s * s;
      const lx = u * cosH - v * sinH;
      const ly = u * sinH + v * cosH;
      const px = x + lx;
      const py = y + ly;
      // approximate tangent using derivative
      const du = bU + 2 * cU * s + 3 * dU * s * s;
      const dv = bV + 2 * cV * s + 3 * dV * s * s;
      const tx = du * cosH - dv * sinH;
      const ty = du * sinH + dv * cosH;
      const th = Math.atan2(ty, tx);
      pts.push([px, py, th, s]);
    }
  } else {
    // Unknown segment, fall back to straight line sampling
    for (let i = 0; i <= n; i++) {
      const s = i * ds;
      const px = x + s * Math.cos(hdg);
      const py = y + s * Math.sin(hdg);
      const th = hdg;
      pts.push([px, py, th, s]);
    }
  }
  return pts;
}

export function sampleSegmentAdaptive(geom, opts = {}) {
  const { x, y, hdg, length, type } = geom;
  const L = Number(length) || 0;
  if (!(L > 0)) return [];
  const baseStep = Math.max(0.2, opts.baseStep || 0.7);
  const maxAngle = Math.max(0.005, opts.maxAngle || 0.03);

  if (type === 'line') return sampleSegment({ ...geom, type: 'line' }, baseStep);

  if (type === 'arc') {
    const k = Number(geom.curvature) || 0;
    const dsAngle = Math.abs(k) > 1e-12 ? (maxAngle / Math.abs(k)) : L;
    const ds = Math.min(baseStep, dsAngle);
    return sampleSegment({ ...geom, type: 'arc' }, ds);
  }

  if (type === 'spiral') {
    // Integrate state [x,y,theta] with RK4, adapt step so delta theta <= maxAngle
    const k0 = Number(geom.curvStart) || 0;
    const k1 = Number(geom.curvEnd) || 0;
    const dk = (k1 - k0) / L;
    let s = 0;
    let px = x, py = y, th = hdg;
    const pts = [[px, py, th, 0]];
    while (s < L - 1e-9) {
      // choose step by angle change bound: |k0*h + 0.5*dk*h^2| <= maxAngle
      const a = 0.5 * Math.abs(dk);
      const b = Math.abs(k0 + dk * s);
      let h = baseStep;
      if (a > 1e-12) {
        // conservative bound via solving a*h^2 + b*h - maxAngle = 0
        const disc = Math.max(0, b*b + 4*a*maxAngle);
        h = Math.min(h, (-b + Math.sqrt(disc)) / (2*a));
      } else if (b > 1e-12) {
        h = Math.min(h, maxAngle / b);
      }
      h = Math.max(0.05, Math.min(h, L - s));

      // RK4 step for state
      const kfun = (ss) => (k0 + dk * ss);
      const f = (ss, st) => {
        const theta = st[2];
        return [Math.cos(theta), Math.sin(theta), kfun(ss)];
      };
      const st = [px, py, th];
      const k1v = f(s, st);
      const k2v = f(s + 0.5*h, [st[0]+0.5*h*k1v[0], st[1]+0.5*h*k1v[1], st[2]+0.5*h*k1v[2]]);
      const k3v = f(s + 0.5*h, [st[0]+0.5*h*k2v[0], st[1]+0.5*h*k2v[1], st[2]+0.5*h*k2v[2]]);
      const k4v = f(s + h, [st[0]+h*k3v[0], st[1]+h*k3v[1], st[2]+h*k3v[2]]);
      px = st[0] + (h/6)*(k1v[0] + 2*k2v[0] + 2*k3v[0] + k4v[0]);
      py = st[1] + (h/6)*(k1v[1] + 2*k2v[1] + 2*k3v[1] + k4v[1]);
      th = st[2] + (h/6)*(k1v[2] + 2*k2v[2] + 2*k3v[2] + k4v[2]);
      s += h;
      pts.push([px, py, th, s]);
    }
    return pts;
  }

  if (type === 'poly3') {
    // Estimate curvature from derivatives and limit angle per step
    const { aU, bU, cU, dU, aV, bV, cV, dV } = geom;
    const cosH = Math.cos(hdg), sinH = Math.sin(hdg);
    let s = 0;
    const pts = [];
    while (s < L + 1e-9) {
      const u = aU + bU*s + cU*s*s + dU*s*s*s;
      const v = aV + bV*s + cV*s*s + dV*s*s*s;
      const du = bU + 2*cU*s + 3*dU*s*s;
      const dv = bV + 2*cV*s + 3*dV*s*s;
      const d2u = 2*cU + 6*dU*s;
      const d2v = 2*cV + 6*dV*s;
      const tx = du * cosH - dv * sinH;
      const ty = du * sinH + dv * cosH;
      const th = Math.atan2(ty, tx);
      const denom = Math.pow(tx*tx + ty*ty, 1.5);
      const ax = d2u * cosH - d2v * sinH;
      const ay = d2u * sinH + d2v * cosH;
      const curvature = denom > 1e-9 ? Math.abs((tx*ay - ty*ax) / denom) : 0;
      const dsAngle = curvature > 1e-9 ? maxAngle / curvature : L;
      const h = Math.min(Math.max(0.2, baseStep), dsAngle, L - s);

      const lx = u * cosH - v * sinH;
      const ly = u * sinH + v * cosH;
      pts.push([x + lx, y + ly, th, s]);
      if (s >= L) break;
      s += h;
      if (s > L) s = L;
    }
    if (pts.length === 0 || pts[pts.length-1][3] < L) {
      // ensure last sample is at end
      const u = aU + bU*L + cU*L*L + dU*L*L*L;
      const v = aV + bV*L + cV*L*L + dV*L*L*L;
      const du = bU + 2*cU*L + 3*dU*L*L;
      const dv = bV + 2*cV*L + 3*dV*L*L;
      const tx = du * cosH - dv * sinH;
      const ty = du * sinH + dv * cosH;
      const th = Math.atan2(ty, tx);
      const lx = u * cosH - v * sinH;
      const ly = u * sinH + v * cosH;
      pts.push([x + lx, y + ly, th, L]);
    }
    return pts;
  }

  return sampleSegment(geom, baseStep);
}

export function offsetPolyline(samples, offset) {
  // samples: [x,y,theta,s]
  const out = [];
  for (const p of samples) {
    const [x, y, th] = p;
    const nx = -Math.sin(th), ny = Math.cos(th);
    out.push([x + nx * offset, y + ny * offset, th, p[3]]);
  }
  return out;
}

export function toLineString(samples, projector) {
  const coords = samples.map(([x, y]) => projector([x, y]));
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates: coords },
  };
}

export function toPolygon(leftSamples, rightSamples, projector, properties = {}) {
  const left = leftSamples.map(([x, y]) => projector([x, y]));
  const right = rightSamples.map(([x, y]) => projector([x, y])).reverse();
  const ring = [...left, ...right, left[0]];
  return {
    type: 'Feature',
    properties,
    geometry: { type: 'Polygon', coordinates: [ring] },
  };
}

export function fc(features = []) {
  return { type: 'FeatureCollection', features };
}
