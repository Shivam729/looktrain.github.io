import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { STATIONS, DEPOT_POS, LINE_COLORS, toWorld } from './geo.js';
import { LINES } from './timetable.js';

// Clarity-first rendering: flat, unlit colours, map-style casing under the tracks, outlined
// train markers with direction arrows and number chips.
//
// Performance notes (target: 60fps on a laptop iGPU):
//  - every train is one instance of three InstancedMeshes (outline / body / arrow), stations are
//    instanced too, so a frame is ~30 draw calls whatever the number of trains;
//  - labels are plain DOM elements positioned with transform only, touched only when they move;
//  - frames are rendered on demand: when the camera moves, a fly-to runs, or train positions change.
const TRACK_Y = 0.5;
const OFF_COLOR = 0xffb100;
const IDLE_COLOR = 0x8a96a8;
const MAJOR = new Set(['JUR', 'CTH', 'RFP', 'TLK', 'PSR', 'CGA', 'MSP', 'WDL', 'AMK', 'BSH', 'TNM', 'OTP', 'DBG', 'YIS', 'KRJ', 'CLE', 'BNL', 'PYL', 'NEW']);
const INTERCHANGE = new Set(['JUR', 'CTH', 'RFP']);
const TRAIN_COLORS = { EW: 0x2fd46f, NS: 0xff4d33 };
const ease = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const _v = new THREE.Vector3(), _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);

// Minimal DOM label layer: one absolutely positioned element per label, moved with translate3d.
class LabelLayer {
  constructor(host){
    this.el = document.createElement('div'); this.el.className = 'labels'; host.appendChild(this.el);
    this.items = [];
    this.w = 1; this.h = 1;
  }
  add(el, pos, { dy = 0, anchor = 'below' } = {}){
    const it = { el, pos, dy, anchor, want: true, shown: true, x: -1e9, y: -1e9 };
    el.classList.add('lbl', anchor === 'above' ? 'lbl-above' : 'lbl-below');
    this.el.appendChild(el); this.items.push(it); return it;
  }
  setSize(w, h){ this.w = w; this.h = h; }
  update(camera){
    for(const it of this.items){
      let show = it.want;
      if(show){
        _v.copy(it.pos).project(camera);
        if(_v.z > 1 || _v.x < -1.1 || _v.x > 1.1 || _v.y < -1.1 || _v.y > 1.1) show = false;
      }
      if(show !== it.shown){ it.el.style.display = show ? '' : 'none'; it.shown = show; if(show){ it.x = it.y = -1e9; } }
      if(!show) continue;
      const x = (_v.x + 1) / 2 * this.w, y = (1 - _v.y) / 2 * this.h + it.dy;
      if(Math.abs(x - it.x) > .25 || Math.abs(y - it.y) > .25){
        it.x = x; it.y = y;
        it.el.style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0)`;
      }
    }
  }
}

export class NetworkScene {
  constructor(host, { onPick, onHover } = {}){
    this.host = host; this.onPick = onPick; this.onHover = onHover;
    this.trains = new Map();
    this.selected = null; this.follow = true; this.fly = null; this.top = false; this.focusOnly = true;
    this.visibleLines = { EW: true, NS: true };
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.useBloom = false;              // kept for compatibility; bloom was removed for legibility
    this.dirty = true;
    this.stats = { frames: 0, rendered: 0 };

    const r = this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    // Retina laptops at 2x push 4x the pixels for no visible gain on a flat map; labels are DOM and stay crisp.
    r.setPixelRatio(Math.min(devicePixelRatio, innerWidth > 860 ? 1.5 : 2));
    r.toneMapping = THREE.NoToneMapping;
    r.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(r.domElement);
    this.labels = new LabelLayer(host);

    const s = this.scene = new THREE.Scene();
    s.background = new THREE.Color(0x0a1220);
    s.fog = new THREE.Fog(0x0a1220, 70, 190);
    const cam = this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 600);
    cam.position.set(0, 110, 90);
    s.add(new THREE.HemisphereLight(0xcfe0ff, 0x1a2230, 1.1));

    this.controls = new OrbitControls(cam, r.domElement);
    Object.assign(this.controls, { enableDamping: true, dampingFactor: 0.12, maxPolarAngle: 1.25, minDistance: 5, maxDistance: 140, screenSpacePanning: false, rotateSpeed: 0.6, zoomSpeed: 0.9 });
    this.controls.target.set(2, 0, 2);
    this.controls.addEventListener('start', () => { if(this.fly) this.fly = null; });
    this.controls.addEventListener('change', () => { this.dirty = true; });

    this.buildGround();
    this.buildNetwork();
    this.buildTrains();
    this.buildSelection();

    this.bindPointer();
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();

    const [ot, op] = this.overviewPose(); this.flyTo(ot, op, 2.2);
    const loop = () => { this.raf = requestAnimationFrame(loop); this.tick(); };
    loop();
  }

  // ---------- world ----------
  buildGround(){
    const mat = new THREE.ShaderMaterial({
      vertexShader: `varying vec2 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.); vW = w.xz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: `
        varying vec2 vW;
        float grid(vec2 p, float s){ vec2 g = abs(fract(p / s - .5) - .5) * s; vec2 fw = fwidth(p); vec2 l = smoothstep(fw * 1.2, vec2(0.), g); return max(l.x, l.y); }
        void main(){
          float d = length(vW * vec2(.8, 1.35));
          vec3 col = mix(vec3(.055,.085,.13), vec3(.04,.065,.105), smoothstep(10., 45., d));
          float fade = 1. - smoothstep(25., 70., d);
          col += vec3(.35,.5,.7) * (grid(vW, 1.) * .03 + grid(vW, 5.) * .07) * fade;
          gl_FragColor = vec4(col, 1.);
          #include <colorspace_fragment>
        }`,
    });
    const g = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), mat);
    g.rotation.x = -Math.PI / 2; this.scene.add(g);
  }

  stationVec(code, y = TRACK_Y){ const w = toWorld(STATIONS[code]); return new THREE.Vector3(w.x, y, w.z); }
  depotVec(code, y = TRACK_Y){ const w = toWorld(DEPOT_POS[code]); return new THREE.Vector3(w.x, y, w.z); }

  buildNetwork(){
    this.curves = {};
    this.lineGroups = {};
    this.stationLabels = { EW: [], NS: [] };
    const pillarGeo = new THREE.CylinderGeometry(0.04, 0.06, 1, 6); pillarGeo.translate(0, 0.5, 0);
    const pillarMat = new THREE.MeshLambertMaterial({ color: 0x2a3950 });
    const pillars = [];
    const casingMat = new THREE.MeshBasicMaterial({ color: 0x03060b });
    const dots = [];                      // [{p, inter, line}]
    for(const line of ['EW', 'NS']){
      const grp = this.lineGroups[line] = new THREE.Group(); this.scene.add(grp);
      const col = LINE_COLORS[line];
      const paths = [LINES[line].main.map(s => s[0])];
      if(LINES[line].branch) paths.push([LINES[line].branch.from, ...LINES[line].branch.stations.map(s => s[0])]);
      this.curves[line] = paths.map(codes => {
        const curve = new THREE.CatmullRomCurve3(codes.map(c => this.stationVec(c)), false, 'centripetal', 0.5);
        const segs = codes.length * 12;
        const casing = new THREE.Mesh(new THREE.TubeGeometry(curve, segs, 0.095, 6, false), casingMat);
        const core = new THREE.Mesh(new THREE.TubeGeometry(curve, segs, 0.06, 6, false), new THREE.MeshBasicMaterial({ color: col.base }));
        core.position.y = 0.06;       // sits above the casing so the line colour shows from above
        grp.add(casing, core);
        const len = curve.getLength();
        for(let d = 0.6; d < len; d += 1.2){ pillars.push(curve.getPointAt(d / len)); }
        return { curve, codes };
      });
      for(const [code, name] of [...LINES[line].main, ...(LINES[line].branch ? LINES[line].branch.stations : [])]){
        if(line === 'NS' && INTERCHANGE.has(code)) continue;
        const p = this.stationVec(code);
        const inter = INTERCHANGE.has(code);
        dots.push({ p, inter, line });
        const el = document.createElement('div');
        el.className = 'st-label' + (MAJOR.has(code) ? ' major' : '') + (inter ? ' inter' : '');
        el.innerHTML = `<b>${code}</b><span>${name}</span>`;
        el.style.setProperty('--c', inter ? '#fff' : col.css);
        const it = this.labels.add(el, p.clone().setY(TRACK_Y + .1), { dy: 7, anchor: 'below' });
        it.major = MAJOR.has(code); it.kind = 'station'; it.line = line;
        this.stationLabels[line].push(it);
      }
    }
    // station dots: two instanced meshes (dark ring + white dot) for all stations
    const ringGeo = new THREE.CylinderGeometry(1, 1, .1, 24), dotGeo = new THREE.CylinderGeometry(1, 1, .12, 24);
    this.ringIM = new THREE.InstancedMesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0x03060b }), dots.length);
    this.dotIM = new THREE.InstancedMesh(dotGeo, new THREE.MeshBasicMaterial({ color: 0xffffff }), dots.length);
    this.dots = dots;
    this.layoutDots();
    this.scene.add(this.ringIM, this.dotIM);

    this.depotLabels = [];
    for(const [code, name] of Object.entries({ ECID: 'East Coast Integrated', TWD: 'Tuas West', UPD: 'Ulu Pandan', BSD: 'Bishan' })){
      const p = this.depotVec(code, 0.03);
      const hex = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, .04, 6), new THREE.MeshBasicMaterial({ color: 0x16243a }));
      hex.position.copy(p); this.scene.add(hex);
      const edge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.CylinderGeometry(1.1, 1.1, .04, 6)), new THREE.LineBasicMaterial({ color: 0x8fb4e8 }));
      edge.position.copy(p); this.scene.add(edge);
      const el = document.createElement('div'); el.className = 'st-label depot major';
      el.innerHTML = `<b>${code}</b><span>${name} Depot</span>`;
      const it = this.labels.add(el, p.clone(), { dy: 12, anchor: 'below' }); it.major = true; it.kind = 'depot';
      this.depotLabels.push(it);
    }
    const inst = new THREE.InstancedMesh(pillarGeo, pillarMat, pillars.length);
    pillars.forEach((p, i) => { _m.makeScale(1, p.y - 0.14, 1); _m.setPosition(p.x, 0, p.z); inst.setMatrixAt(i, _m); });
    this.scene.add(inst);
  }

  layoutDots(){
    this.dots.forEach(({ p, inter, line }, i) => {
      const on = this.visibleLines[line] || inter;
      _m.compose(_v.set(p.x, TRACK_Y + .1, p.z), _q.identity(), _s.setScalar(on ? (inter ? .3 : .19) : 0).setY(on ? 1 : 0));
      this.ringIM.setMatrixAt(i, _m);
      _m.compose(_v.set(p.x, TRACK_Y + .13, p.z), _q.identity(), _s.setScalar(on ? (inter ? .23 : .13) : 0).setY(on ? 1 : 0));
      this.dotIM.setMatrixAt(i, _m);
    });
    this.ringIM.instanceMatrix.needsUpdate = this.dotIM.instanceMatrix.needsUpdate = true;
  }

  buildTrains(){
    const g = new THREE.CapsuleGeometry(.17, .78, 3, 10); g.rotateX(Math.PI / 2);
    const o = new THREE.CapsuleGeometry(.24, .82, 3, 10); o.rotateX(Math.PI / 2);
    const a = new THREE.ConeGeometry(.13, .3, 10); a.rotateX(Math.PI / 2); a.translate(0, 0, .72);
    this.trainGeo = { body: g, outline: o, arrow: a };
    this.allocTrains(256);
  }
  allocTrains(cap){
    for(const k of ['outlineIM', 'bodyIM', 'arrowIM']) if(this[k]){ this.scene.remove(this[k]); this[k].dispose(); }
    const mk = (geo, mat) => { const m = new THREE.InstancedMesh(geo, mat, cap); m.count = 0; m.frustumCulled = false; this.scene.add(m); return m; };
    this.outlineIM = mk(this.trainGeo.outline, new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.BackSide }));
    this.bodyIM = mk(this.trainGeo.body, new THREE.MeshBasicMaterial({ color: 0xffffff }));
    this.arrowIM = mk(this.trainGeo.arrow, new THREE.MeshBasicMaterial({ color: 0xffffff }));
    this.bodyIM.setColorAt(0, new THREE.Color(0xffffff));   // allocates instanceColor
    this.cap = cap;
    this.instancesDirty = true;
  }

  buildSelection(){
    const ring = new THREE.Mesh(new THREE.RingGeometry(.62, .74, 48), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: .95, depthWrite: false, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2; ring.visible = false; this.scene.add(ring); this.selRing = ring;
    const halo = new THREE.Mesh(new THREE.RingGeometry(.74, 1.25, 48), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: .16, depthWrite: false, side: THREE.DoubleSide }));
    halo.rotation.x = -Math.PI / 2; halo.visible = false; this.scene.add(halo); this.selHalo = halo;
    const pinGeo = new THREE.CylinderGeometry(.025, .025, 1.6, 6); pinGeo.translate(0, .8, 0);
    this.pin = new THREE.Mesh(pinGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: .75 }));
    this.pin.visible = false; this.scene.add(this.pin);
    this.routeMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { uLen: { value: 10 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }`,
      fragmentShader: `varying vec2 vUv; uniform float uLen;
        void main(){ float s = fract(vUv.x * uLen * 1.6); if(s > .55) discard; gl_FragColor = vec4(vec3(1.), .95); }`,
    });
    this.route = null;
    const el = document.createElement('div'); el.className = 'train-tag';
    this.tagPos = new THREE.Vector3();
    this.tag = this.labels.add(el, this.tagPos, { dy: -10, anchor: 'above' }); this.tag.want = false;
  }

  // ---------- geometry helpers used by the app ----------
  rowPoint(line, row){
    if(row.kind === 'depot' && DEPOT_POS[row.code]) return this.depotVec(row.code);
    if(STATIONS[row.code]) return this.stationVec(row.code);
    return null;
  }
  poseBetween(line, a, b, f){
    for(const { curve, codes } of this.curves[line]){
      const ia = codes.indexOf(a.code), ib = codes.indexOf(b.code);
      if(a.kind !== 'depot' && b.kind !== 'depot' && ia >= 0 && ib >= 0 && Math.abs(ia - ib) === 1){
        const n = codes.length - 1, t = (ia + (ib - ia) * f) / n;
        const pos = curve.getPoint(t);
        const tan = curve.getTangent(Math.min(1, Math.max(0, t))).multiplyScalar(Math.sign(ib - ia));
        return { pos, dir: tan };
      }
    }
    const pa = this.rowPoint(line, a), pb = this.rowPoint(line, b);
    if(!pa || !pb) return pa ? { pos: pa, dir: new THREE.Vector3(1, 0, 0) } : null;
    return { pos: pa.clone().lerp(pb, f), dir: pb.clone().sub(pa).normalize() };
  }

  // ---------- trains ----------
  makeTrain(id, line){
    const el = document.createElement('div'); el.className = 'tr-label'; el.textContent = id;
    el.style.setProperty('--c', LINE_COLORS[line].css);
    const pos = new THREE.Vector3();
    const label = this.labels.add(el, pos, { dy: -9, anchor: 'above' });
    label.want = false; label.kind = 'train';
    const t = { id, line, pos, dir: new THREE.Vector3(0, 0, 1), state: null, seen: false, label,
                group: { visible: false, position: pos } };     // `group` keeps the old shape for callers
    this.trains.set(id, t);
    return t;
  }

  // list: [{id, line, pos, dir, state: 'svc'|'off'|'idle'|'hidden'}]
  syncTrains(list){
    const alive = new Set();
    for(const it of list){
      alive.add(it.id);
      const t = this.trains.get(it.id) || this.makeTrain(it.id, it.line);
      const others = !(this.focusOnly && this.selected && it.id !== this.selected);   // focus mode
      let vis = (it.state !== 'hidden' && this.visibleLines[it.line] && others) || it.id === this.selected;
      if(!it.pos) vis = false;
      if(vis !== t.group.visible){ t.group.visible = vis; this.instancesDirty = true; }
      if(!it.pos) continue;
      const dx = t.pos.x - it.pos.x, dz = t.pos.z - it.pos.z;      // compare on the ground plane (y is fixed)
      if(!t.seen || dx * dx + dz * dz > 1e-8){ t.pos.set(it.pos.x, TRACK_Y + .2, it.pos.z); t.seen = true; if(vis) this.instancesDirty = true; }
      if(it.dir && it.dir.lengthSq() > 1e-6){
        _v.copy(it.dir).setY(0).normalize();
        if(t.dir.distanceToSquared(_v) > 1e-8){ t.dir.copy(_v); if(vis) this.instancesDirty = true; }
      }
      if(t.state !== it.state){ t.state = it.state; t.label.el.dataset.state = it.state; this.instancesDirty = true; }
    }
    for(const t of this.trains.values()){ if(!alive.has(t.id) && t.group.visible){ t.group.visible = false; this.instancesDirty = true; } }
    if(this.instancesDirty) this.dirty = true;
  }

  writeInstances(k){
    const vis = [...this.trains.values()].filter(t => t.group.visible);
    if(vis.length > this.cap) this.allocTrains(Math.ceil(vis.length * 1.5));
    const col = new THREE.Color();
    vis.forEach((t, i) => {
      const s = k * (t.id === this.selected ? 1.3 : 1);
      _q.setFromUnitVectors(_v.set(0, 0, 1), t.dir.lengthSq() ? t.dir : _v);
      _m.compose(t.pos, _q, _s.setScalar(s));
      this.outlineIM.setMatrixAt(i, _m);
      this.bodyIM.setMatrixAt(i, _m);
      this.arrowIM.setMatrixAt(i, t.state === 'svc' || t.state === 'off' ? _m : _zero);
      col.setHex(t.state === 'off' ? OFF_COLOR : t.state === 'idle' || t.state === 'hidden' ? IDLE_COLOR : TRAIN_COLORS[t.line]);
      this.bodyIM.setColorAt(i, col);
    });
    for(const m of [this.outlineIM, this.bodyIM, this.arrowIM]){ m.count = vis.length; m.instanceMatrix.needsUpdate = true; }
    this.bodyIM.instanceColor.needsUpdate = true;
    this.visibleList = vis;
    this.instancesDirty = false;
  }

  setLineVisible(line, v){
    this.visibleLines[line] = v; this.lineGroups[line].visible = v;
    this.layoutDots(); this.dirty = this.instancesDirty = true;
  }

  select(id, { fly = true } = {}){
    const prev = this.trains.get(this.selected);
    if(prev) prev.label.el.classList.remove('sel');
    this.selected = id;
    const t = this.trains.get(id);
    [this.selRing, this.selHalo, this.pin].forEach(m => m.visible = !!t);
    this.tag.want = !!t;
    this.dirty = this.instancesDirty = true;
    if(!t){ this.setRoute(null); return; }
    t.label.el.classList.add('sel');
    this.tag.el.textContent = id;
    this.tag.el.style.setProperty('--c', LINE_COLORS[t.line].css);
    this.follow = true;
    if(fly){
      const off = this.camera.position.clone().sub(this.controls.target);
      off.setLength(Math.min(Math.max(off.length(), 11), 16)); if(!this.top && off.y < 4) off.y = 6;
      this.flyTo(t.pos.clone().setY(0), t.pos.clone().setY(0).add(off), 1.2);
    }
  }

  setRoute(points){
    if(this.route){ this.scene.remove(this.route); this.route.geometry.dispose(); this.route = null; }
    this.dirty = true;
    if(!points || points.length < 2) return;
    const curve = new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(p.x, TRACK_Y + .12, p.z)), false, 'centripetal');
    const len = curve.getLength();
    this.routeMat.uniforms.uLen.value = len;
    this.route = new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(16, Math.round(len * 10)), .045, 5, false), this.routeMat);
    this.scene.add(this.route);
  }

  flyTo(target, position, dur = 1.4){
    if(this.reduced) dur = 0.01;
    this.fly = { t0: performance.now(), dur: dur * 1000, fromT: this.controls.target.clone(), fromP: this.camera.position.clone(), toT: target, toP: position };
  }
  overviewPose(){
    const wide = this.host.clientWidth > 860;
    const t = new THREE.Vector3(2, 0, 2);
    if(this.top) return [t, t.clone().add(new THREE.Vector3(0, wide ? 52 : 80, 0.01))];
    return [t, new THREE.Vector3(2, wide ? 40 : 62, wide ? 38 : 50)];
  }
  overview(){ this.follow = false; const [t, p] = this.overviewPose(); this.flyTo(t, p, 1.2); }

  // Flat top-down map view (no tilt) vs the 3D perspective.
  setTopView(on){
    this.top = on;
    this.controls.enableRotate = !on;
    this.controls.maxPolarAngle = on ? 0.001 : 1.25;
    const t = this.controls.target.clone();
    const d = this.camera.position.distanceTo(t);
    const pos = on ? t.clone().add(new THREE.Vector3(0, d, 0.001)) : t.clone().add(new THREE.Vector3(0, d * .7, d * .7));
    this.flyTo(t, pos, 0.8);
  }

  setInsets(ins){ this.insets = ins; this.applyInsets(); this.dirty = true; }
  applyInsets(){
    const w = this.host.clientWidth, h = this.host.clientHeight, i = this.insets || {};
    if(!w || !h) return;
    const dx = ((i.right || 0) - (i.left || 0)) / 2, dy = ((i.bottom || 0) - (i.top || 0)) / 2;
    if(dx || dy) this.camera.setViewOffset(w, h, dx, dy, w, h); else this.camera.clearViewOffset();
  }

  screenPos(id){
    const t = this.trains.get(id); if(!t) return null;
    const v = t.pos.clone().project(this.camera);
    const r = this.renderer.domElement.getBoundingClientRect();
    return { x: (v.x + 1) / 2 * r.width, y: (1 - v.y) / 2 * r.height, behind: v.z > 1 };
  }

  // ---------- input ----------
  bindPointer(){
    const el = this.renderer.domElement;
    let down = null, moveQueued = null;
    el.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY }; });
    el.addEventListener('pointerup', e => {
      if(!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) return;
      const id = this.pick(e.clientX, e.clientY, e.pointerType === 'mouse' ? 18 : 30);
      if(id && this.onPick) this.onPick(id);
    });
    // hover: at most once per frame
    el.addEventListener('pointermove', e => {
      if(e.pointerType !== 'mouse') return;
      if(moveQueued){ moveQueued.x = e.clientX; moveQueued.y = e.clientY; return; }
      moveQueued = { x: e.clientX, y: e.clientY };
      requestAnimationFrame(() => {
        const { x, y } = moveQueued; moveQueued = null;
        const id = this.pick(x, y, 18);
        el.style.cursor = id ? 'pointer' : '';
        if(id !== this.hovered){
          const old = this.trains.get(this.hovered); if(old) old.label.el.classList.remove('hover');
          this.hovered = id;
          const t = this.trains.get(id); if(t) t.label.el.classList.add('hover');
          this.dirty = true;
          if(this.onHover) this.onHover(id);
        }
      });
    });
  }
  // Nearest visible train within `radius` px of the pointer (screen space; no raycast meshes).
  pick(cx, cy, radius = 20){
    const r = this.renderer.domElement.getBoundingClientRect();
    let best = null, bd = radius * radius;
    for(const t of this.trains.values()){
      if(!t.group.visible) continue;
      _v.copy(t.pos).project(this.camera);
      if(_v.z > 1) continue;
      const dx = (_v.x + 1) / 2 * r.width + r.left - cx, dy = (1 - _v.y) / 2 * r.height + r.top - cy;
      const d = dx * dx + dy * dy;
      if(d < bd){ bd = d; best = t.id; }
    }
    return best;
  }

  resize(){
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if(!w || !h) return;
    this.camera.aspect = w / h; this.applyInsets(); this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h); this.labels.setSize(w, h);
    this.dirty = true;
  }

  // ---------- frame ----------
  tick(){
    this.stats.frames++;
    if(this.beforeRender) this.beforeRender();

    const sel = this.trains.get(this.selected);
    if(sel && this.follow && !this.fly){
      const delta = _v.copy(sel.pos).setY(0).sub(this.controls.target);
      if(delta.lengthSq() > 1e-6){
        delta.multiplyScalar(.08);
        this.controls.target.add(delta); this.camera.position.add(delta);
        this.dirty = true;
      }
    }
    if(this.fly){
      const f = Math.min(1, (performance.now() - this.fly.t0) / this.fly.dur), e = ease(f);
      this.controls.target.lerpVectors(this.fly.fromT, this.fly.toT, e);
      this.camera.position.lerpVectors(this.fly.fromP, this.fly.toP, e);
      if(f >= 1) this.fly = null;
      this.dirty = true;
    }
    this.controls.update();           // fires 'change' (-> dirty) while damping settles
    if(!this.dirty) return;
    this.dirty = false;
    this.stats.rendered++;

    const camD = this.camera.position.distanceTo(this.controls.target);
    // Markers are sized in screen space (~16px long) so they stay distinct at every zoom.
    const px = 2 * camD * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) / Math.max(1, this.host.clientHeight);
    const k = THREE.MathUtils.clamp(px * 17 / 1.1, 0.45, 1.4);
    if(this.instancesDirty || Math.abs(k - (this.lastK || 0)) > 1e-4){ this.writeInstances(k); this.lastK = k; }

    if(sel){
      const p = sel.pos;
      this.selRing.position.set(p.x, TRACK_Y + .05, p.z); this.selRing.scale.setScalar(k * 1.3);
      this.selHalo.position.copy(this.selRing.position); this.selHalo.scale.setScalar(k * 1.3);
      this.pin.position.set(p.x, TRACK_Y + .2, p.z); this.pin.scale.set(k, k * 1.6, k);
      this.tagPos.set(p.x, TRACK_Y + .2 + 2.6 * k, p.z);
    }
    // label visibility by zoom: far = major stations only, mid/near = everything + train numbers
    const zoom = camD < 18 ? 'near' : camD < 48 ? 'mid' : 'far';
    if(zoom !== this.zoom){
      this.zoom = zoom; this.labels.el.dataset.zoom = zoom;
      for(const line of ['EW', 'NS']) for(const it of this.stationLabels[line]) it.want = this.visibleLines[line] && (zoom !== 'far' || it.major);
    }
    for(const line of ['EW', 'NS']) if(this.lineLabelState !== JSON.stringify(this.visibleLines)){
      for(const it of this.stationLabels[line]) it.want = this.visibleLines[line] && (zoom !== 'far' || it.major);
    }
    this.lineLabelState = JSON.stringify(this.visibleLines);
    for(const t of this.trains.values()){
      t.label.want = t.group.visible && t.id !== this.selected && t.state !== 'hidden' && (zoom !== 'far' || t.id === this.hovered);
    }
    this.renderer.render(this.scene, this.camera);
    this.labels.update(this.camera);
  }
}
