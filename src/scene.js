import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { STATIONS, DEPOT_POS, LINE_COLORS, toWorld } from './geo.js';
import { LINES } from './timetable.js';

// Clarity-first rendering: flat, unlit colours (no bloom or additive glow), map-style casing
// under the tracks, outlined train markers with direction arrows and number chips.
const TRACK_Y = 0.5;
const OFF_COLOR = 0xffb100;
const IDLE_COLOR = 0x8a96a8;
const MAJOR = new Set(['JUR', 'CTH', 'RFP', 'TLK', 'PSR', 'CGA', 'MSP', 'WDL', 'AMK', 'BSH', 'TNM', 'OTP', 'DBG', 'YIS', 'KRJ', 'CLE', 'BNL', 'PYL', 'NEW']);
const INTERCHANGE = new Set(['JUR', 'CTH', 'RFP']);
const TRAIN_COLORS = { EW: 0x2fd46f, NS: 0xff4d33 };
const ease = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

export class NetworkScene {
  constructor(host, { onPick, onHover } = {}){
    this.host = host; this.onPick = onPick; this.onHover = onHover;
    this.trains = new Map();
    this.selected = null; this.follow = true; this.fly = null; this.top = false;
    this.visibleLines = { EW: true, NS: true };
    this.clock = new THREE.Timer();
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.useBloom = false;              // kept for compatibility; bloom was removed for legibility

    const r = this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(devicePixelRatio, 2));
    r.toneMapping = THREE.NoToneMapping;
    r.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(r.domElement);
    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = 'labels';
    host.appendChild(this.labels.domElement);

    const s = this.scene = new THREE.Scene();
    s.background = new THREE.Color(0x0a1220);
    s.fog = new THREE.Fog(0x0a1220, 70, 190);
    const cam = this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 600);
    cam.position.set(0, 110, 90);
    s.add(new THREE.HemisphereLight(0xcfe0ff, 0x1a2230, 1.1));

    this.controls = new OrbitControls(cam, r.domElement);
    Object.assign(this.controls, { enableDamping: true, dampingFactor: 0.08, maxPolarAngle: 1.25, minDistance: 5, maxDistance: 140, screenSpacePanning: false, rotateSpeed: 0.6, zoomSpeed: 0.9 });
    this.controls.target.set(2, 0, 2);
    this.controls.addEventListener('start', () => { if(this.fly) this.fly = null; });

    this.buildGround();
    this.buildNetwork();
    this.buildSelection();

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
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
    const pillarGeo = new THREE.CylinderGeometry(0.04, 0.06, 1, 6); pillarGeo.translate(0, 0.5, 0);
    const pillarMat = new THREE.MeshLambertMaterial({ color: 0x2a3950 });
    const pillars = [];
    const casingMat = new THREE.MeshBasicMaterial({ color: 0x03060b });
    for(const line of ['EW', 'NS']){
      const grp = this.lineGroups[line] = new THREE.Group(); this.scene.add(grp);
      const col = LINE_COLORS[line];
      const paths = [LINES[line].main.map(s => s[0])];
      if(LINES[line].branch) paths.push([LINES[line].branch.from, ...LINES[line].branch.stations.map(s => s[0])]);
      this.curves[line] = paths.map(codes => {
        const curve = new THREE.CatmullRomCurve3(codes.map(c => this.stationVec(c)), false, 'centripetal', 0.5);
        const segs = codes.length * 16;
        const casing = new THREE.Mesh(new THREE.TubeGeometry(curve, segs, 0.095, 8, false), casingMat);
        const core = new THREE.Mesh(new THREE.TubeGeometry(curve, segs, 0.06, 8, false), new THREE.MeshBasicMaterial({ color: col.base }));
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
        const ring = new THREE.Mesh(new THREE.CylinderGeometry(inter ? .3 : .19, inter ? .3 : .19, .1, 28), new THREE.MeshBasicMaterial({ color: 0x03060b }));
        ring.position.copy(p).setY(TRACK_Y + .1); grp.add(ring);
        const dot = new THREE.Mesh(new THREE.CylinderGeometry(inter ? .23 : .13, inter ? .23 : .13, .12, 28), new THREE.MeshBasicMaterial({ color: 0xffffff }));
        dot.position.copy(p).setY(TRACK_Y + .13); grp.add(dot);
        const el = document.createElement('div');
        el.className = 'st-label' + (MAJOR.has(code) ? ' major' : '') + (inter ? ' inter' : '');
        el.innerHTML = `<b>${code}</b><span>${name}</span>`;
        el.style.setProperty('--c', inter ? '#fff' : col.css);
        const lab = new CSS2DObject(el); lab.position.copy(p).add(new THREE.Vector3(0, .1, 0)); lab.center.set(0.5, -0.35); grp.add(lab);
      }
    }
    for(const [code, name] of Object.entries({ ECID: 'East Coast Integrated', TWD: 'Tuas West', UPD: 'Ulu Pandan', BSD: 'Bishan' })){
      const p = this.depotVec(code, 0.03);
      const hex = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, .04, 6), new THREE.MeshBasicMaterial({ color: 0x16243a }));
      hex.position.copy(p); this.scene.add(hex);
      const edge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.CylinderGeometry(1.1, 1.1, .04, 6)), new THREE.LineBasicMaterial({ color: 0x8fb4e8 }));
      edge.position.copy(p); this.scene.add(edge);
      const el = document.createElement('div'); el.className = 'st-label depot major';
      el.innerHTML = `<b>${code}</b><span>${name} Depot</span>`;
      const lab = new CSS2DObject(el); lab.position.copy(p); lab.center.set(0.5, -0.6); this.scene.add(lab);
    }
    const inst = new THREE.InstancedMesh(pillarGeo, pillarMat, pillars.length);
    const m = new THREE.Matrix4();
    pillars.forEach((p, i) => { m.makeScale(1, p.y - 0.14, 1); m.setPosition(p.x, 0, p.z); inst.setMatrixAt(i, m); });
    this.scene.add(inst);
  }

  buildSelection(){
    const mk = (r1, r2, op) => {
      const m = new THREE.Mesh(new THREE.RingGeometry(r1, r2, 64), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: op, depthWrite: false, side: THREE.DoubleSide }));
      m.rotation.x = -Math.PI / 2; m.visible = false; this.scene.add(m); return m;
    };
    this.selRing = mk(.62, .72, .95);
    this.pulse = mk(.62, .68, .6);
    const pinGeo = new THREE.CylinderGeometry(.025, .025, 1.6, 8); pinGeo.translate(0, .8, 0);
    this.pin = new THREE.Mesh(pinGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: .75 }));
    this.pin.visible = false; this.scene.add(this.pin);
    this.routeMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { uTime: { value: 0 }, uLen: { value: 10 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }`,
      fragmentShader: `varying vec2 vUv; uniform float uTime, uLen;
        void main(){ float s = fract(vUv.x * uLen * 1.6 - uTime * .8); float a = step(s, .55) * .95; if(a < .01) discard; gl_FragColor = vec4(vec3(1.), a); }`,
    });
    this.route = null;
    const el = document.createElement('div'); el.className = 'train-tag';
    this.tag = new CSS2DObject(el); this.tag.center.set(0.5, 1.6); this.tag.visible = false; this.scene.add(this.tag);
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
    if(!this.trainGeo){
      const g = new THREE.CapsuleGeometry(.17, .78, 4, 14); g.rotateX(Math.PI / 2);
      const o = new THREE.CapsuleGeometry(.24, .82, 4, 14); o.rotateX(Math.PI / 2);
      const a = new THREE.ConeGeometry(.13, .3, 12); a.rotateX(Math.PI / 2); a.translate(0, 0, .72);
      this.trainGeo = { body: g, outline: o, arrow: a };
    }
    const group = new THREE.Group();
    const bodyMat = new THREE.MeshBasicMaterial({ color: TRAIN_COLORS[line] });
    const outline = new THREE.Mesh(this.trainGeo.outline, new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.BackSide }));
    const body = new THREE.Mesh(this.trainGeo.body, bodyMat);
    const arrow = new THREE.Mesh(this.trainGeo.arrow, new THREE.MeshBasicMaterial({ color: 0xffffff }));
    group.add(outline, body, arrow);
    const hit = new THREE.Mesh(new THREE.SphereGeometry(.8, 8, 6), new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
    hit.userData.trainId = id; group.add(hit);
    const el = document.createElement('div'); el.className = 'tr-label'; el.textContent = id;
    el.style.setProperty('--c', LINE_COLORS[line].css);
    const label = new CSS2DObject(el); label.center.set(0.5, 1.35); group.add(label);
    this.scene.add(group);
    const t = { id, line, group, body, bodyMat, outline, arrow, hit, label, state: null, pos: new THREE.Vector3(), dir: new THREE.Vector3(0, 0, 1), seen: false };
    this.trains.set(id, t);
    return t;
  }

  syncTrains(list){
    const alive = new Set();
    for(const it of list){
      alive.add(it.id);
      const t = this.trains.get(it.id) || this.makeTrain(it.id, it.line);
      const show = it.state !== 'hidden' && this.visibleLines[it.line];
      t.group.visible = show || it.id === this.selected;
      if(!it.pos){ t.group.visible = false; continue; }
      if(!t.seen || t.pos.distanceTo(it.pos) > 3){ t.pos.copy(it.pos); t.seen = true; }
      else t.pos.lerp(it.pos, .35);
      if(it.dir && it.dir.lengthSq() > 1e-6) t.dir.lerp(it.dir, .3).normalize();
      t.group.position.set(t.pos.x, TRACK_Y + .2, t.pos.z);
      t.group.lookAt(t.pos.x + t.dir.x, TRACK_Y + .2, t.pos.z + t.dir.z);
      if(t.state !== it.state){
        t.state = it.state;
        const c = it.state === 'off' ? OFF_COLOR : it.state === 'idle' || it.state === 'hidden' ? IDLE_COLOR : TRAIN_COLORS[t.line];
        t.bodyMat.color.setHex(c);
        t.arrow.visible = it.state === 'svc' || it.state === 'off';
        t.label.element.dataset.state = it.state;
      }
    }
    for(const [id, t] of this.trains){ if(!alive.has(id)) t.group.visible = false; }
  }

  setLineVisible(line, v){ this.visibleLines[line] = v; this.lineGroups[line].visible = v; }

  select(id, { fly = true } = {}){
    const prev = this.trains.get(this.selected);
    if(prev) prev.label.element.classList.remove('sel');
    this.selected = id;
    const t = this.trains.get(id);
    [this.selRing, this.pulse, this.pin].forEach(m => m.visible = !!t);
    this.tag.visible = !!t;
    if(!t){ this.setRoute(null); return; }
    t.label.element.classList.add('sel');
    this.tag.element.textContent = id;
    this.tag.element.style.setProperty('--c', LINE_COLORS[t.line].css);
    this.follow = true;
    if(fly){
      const off = this.camera.position.clone().sub(this.controls.target);
      off.setLength(Math.min(Math.max(off.length(), 11), 16)); if(!this.top && off.y < 4) off.y = 6;
      this.flyTo(t.pos.clone().setY(0), t.pos.clone().setY(0).add(off), 1.4);
    }
  }

  setRoute(points){
    if(this.route){ this.scene.remove(this.route); this.route.geometry.dispose(); this.route = null; }
    if(!points || points.length < 2) return;
    const curve = new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(p.x, TRACK_Y + .12, p.z)), false, 'centripetal');
    const len = curve.getLength();
    this.routeMat.uniforms.uLen.value = len;
    this.route = new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(16, Math.round(len * 12)), .045, 6, false), this.routeMat);
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
  overview(){ this.follow = false; const [t, p] = this.overviewPose(); this.flyTo(t, p, 1.4); }

  // Flat top-down map view (no tilt) vs the 3D perspective.
  setTopView(on){
    this.top = on;
    this.controls.enableRotate = !on;
    this.controls.maxPolarAngle = on ? 0.001 : 1.25;
    const t = this.controls.target.clone();
    const d = this.camera.position.distanceTo(t);
    const pos = on ? t.clone().add(new THREE.Vector3(0, d, 0.001)) : t.clone().add(new THREE.Vector3(0, d * .7, d * .7));
    this.flyTo(t, pos, 0.9);
  }

  setInsets(ins){ this.insets = ins; this.applyInsets(); }
  applyInsets(){
    const w = this.host.clientWidth, h = this.host.clientHeight, i = this.insets || {};
    if(!w || !h) return;
    const dx = ((i.right || 0) - (i.left || 0)) / 2, dy = ((i.bottom || 0) - (i.top || 0)) / 2;
    if(dx || dy) this.camera.setViewOffset(w, h, dx, dy, w, h); else this.camera.clearViewOffset();
  }

  screenPos(id){
    const t = this.trains.get(id); if(!t) return null;
    const v = t.group.position.clone().project(this.camera);
    const r = this.renderer.domElement.getBoundingClientRect();
    return { x: (v.x + 1) / 2 * r.width, y: (1 - v.y) / 2 * r.height, behind: v.z > 1 };
  }

  // ---------- input ----------
  bindPointer(){
    const el = this.renderer.domElement;
    let down = null;
    el.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY }; });
    el.addEventListener('pointerup', e => {
      if(!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) return;
      const id = this.pick(e);
      if(id && this.onPick) this.onPick(id);
    });
    el.addEventListener('pointermove', e => {
      if(e.pointerType !== 'mouse') return;
      const id = this.pick(e);
      el.style.cursor = id ? 'pointer' : '';
      if(id !== this.hovered){
        const old = this.trains.get(this.hovered); if(old) old.label.element.classList.remove('hover');
        this.hovered = id;
        const t = this.trains.get(id); if(t) t.label.element.classList.add('hover');
        if(this.onHover) this.onHover(id);
      }
    });
  }
  pick(e){
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects([...this.trains.values()].filter(t => t.group.visible).map(t => t.hit), false);
    return hits.length ? hits[0].object.userData.trainId : null;
  }

  resize(){
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if(!w || !h) return;
    this.camera.aspect = w / h; this.applyInsets(); this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h); this.labels.setSize(w, h);
  }

  // ---------- frame ----------
  tick(){
    this.clock.update();
    const time = this.clock.getElapsed();
    if(this.beforeRender) this.beforeRender();
    this.routeMat.uniforms.uTime.value = time;

    const camD = this.camera.position.distanceTo(this.controls.target);
    // Size markers in screen space (~16px long) so they stay distinct at every zoom level,
    // never smaller than a readable minimum up close.
    const px = 2 * camD * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) / Math.max(1, this.host.clientHeight);
    const k = THREE.MathUtils.clamp(px * 17 / 1.1, 0.45, 1.4);
    for(const t of this.trains.values()){
      if(t.group.visible) t.group.scale.setScalar(k * (t.id === this.selected ? 1.3 : 1));
    }
    const sel = this.trains.get(this.selected);
    if(sel){
      const p = sel.group.position;
      this.selRing.position.set(p.x, TRACK_Y + .05, p.z); this.selRing.scale.setScalar(k * 1.3);
      const q = (time * .7) % 1;
      this.pulse.position.set(p.x, TRACK_Y + .05, p.z); this.pulse.scale.setScalar(k * 1.3 * (1 + q * 1.6)); this.pulse.material.opacity = .6 * (1 - q);
      this.pin.position.set(p.x, TRACK_Y + .2, p.z); this.pin.scale.set(k, k * 1.6, k);
      this.tag.position.set(p.x, TRACK_Y + .2 + 2.6 * k, p.z);
      if(this.follow && !this.fly){
        const delta = p.clone().setY(0).sub(this.controls.target);
        this.controls.target.add(delta.multiplyScalar(.08));
        this.camera.position.add(delta);
      }
    }
    if(this.fly){
      const f = Math.min(1, (performance.now() - this.fly.t0) / this.fly.dur), e = ease(f);
      this.controls.target.lerpVectors(this.fly.fromT, this.fly.toT, e);
      this.camera.position.lerpVectors(this.fly.fromP, this.fly.toP, e);
      if(f >= 1) this.fly = null;
    }
    this.controls.update();
    this.labels.domElement.dataset.zoom = camD < 18 ? 'near' : camD < 48 ? 'mid' : 'far';
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  }
}
