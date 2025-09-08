// Minimal Poly3 and CubicSpline implementation inspired by libOpenDRIVE

export class Poly3 {
  constructor(a = 0, b = 0, c = 0, d = 0) {
    this.a = a; this.b = b; this.c = c; this.d = d;
  }
  value(ds) { return this.a + this.b*ds + this.c*ds*ds + this.d*ds*ds*ds; }
  deriv(ds) { return this.b + 2*this.c*ds + 3*this.d*ds*ds; }
  deriv2(ds) { return 2*this.c + 6*this.d*ds; }
  deriv3() { return 6*this.d; }
  rebase(delta) {
    const f0 = this.value(delta);
    const f1 = this.deriv(delta);
    const f2 = this.deriv2(delta);
    const f3 = this.deriv3();
    return new Poly3(f0, f1, f2/2, f3/6);
  }
  add(other) { return new Poly3(this.a+other.a, this.b+other.b, this.c+other.c, this.d+other.d); }
  negate() { return new Poly3(-this.a, -this.b, -this.c, -this.d); }
}

export class CubicSpline {
  constructor() { this.seg = []; } // segments: [{s0, poly: Poly3}]
  static fromSegments(segments) {
    const cs = new CubicSpline();
    cs.seg = (segments || []).map(s=>({ s0: s.s0, poly: new Poly3(s.a, s.b, s.c, s.d) }))
      .sort((a,b)=>a.s0-b.s0);
    return cs;
  }
  addSegment(s0, a, b, c, d) {
    this.seg.push({ s0, poly: new Poly3(a,b,c,d) });
    this.seg.sort((a,b)=>a.s0-b.s0);
    return this;
  }
  empty() { return this.seg.length === 0; }
  get_poly(s, extendStart = true) {
    if (this.seg.length === 0) return { s0: s, poly: new Poly3() };
    let candidate = this.seg[0];
    for (const sg of this.seg) {
      if (s + 1e-12 >= sg.s0) candidate = sg; else break;
    }
    if (s + 1e-12 >= candidate.s0) return candidate;
    return extendStart ? this.seg[0] : candidate;
  }
  get(s, def = 0) {
    if (this.seg.length === 0) return def;
    const { s0, poly } = this.get_poly(s, true);
    return poly.value(s - s0);
  }
  negate() {
    const out = new CubicSpline();
    out.seg = this.seg.map(({s0, poly}) => ({ s0, poly: poly.negate() }));
    return out;
  }
  add(other) {
    const out = new CubicSpline();
    const ticksSet = new Set();
    for (const s of this.seg) ticksSet.add(s.s0);
    for (const s of other.seg) ticksSet.add(s.s0);
    const ticks = Array.from(ticksSet).sort((a,b)=>a-b);
    if (ticks.length === 0) return out;
    for (let i=0;i<ticks.length;i++) {
      const s0 = ticks[i];
      const aP = this.get_poly(s0, true);
      const bP = other.get_poly(s0, true);
      const deltaA = s0 - aP.s0;
      const deltaB = s0 - bP.s0;
      const pA = aP.poly.rebase(deltaA);
      const pB = bP.poly.rebase(deltaB);
      const p = pA.add(pB);
      out.addSegment(s0, p.a, p.b, p.c, p.d);
    }
    return out;
  }
}

