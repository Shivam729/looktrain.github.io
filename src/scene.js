import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { STATIONS, DEPOT_POS, LINE_COLORS, toWorld } from './geo.js';
import { LINES } from './timetable.js';

const TRACK_Y = 0.55;
const OFF_COLOR = 0xffb100;
const MAJOR = new Set(['JUR', 'CTH', 'RFP', 'TLK', 'PSR', 'CGA', 'MSP', 'WDL', 'AMK', 'BSH', 'TNM', 'OTP', 'DBG', 'YIS', 'KRJ']);
const INTERCHANGE = new Set(['JUR', 'CTH', 'RFP']);
const ease = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

function glowTexture(){
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'), r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(.25, 'rgba(255,255,255,.55)');
  r.addColorStop(.6, 'rgba(255,255,255,.12)'); r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

export class NetworkScene {
  constructor(host, { onPick, onHover } = {}){
    this.host = host; this.onPick = onPick; this.onHover = onHover;
    this.trains = new Map();           // id -> {group, body, halo, hit, line, state}
    this.selected = null; this.follow = true; this.fly = null;
    this.visibleLines = { EW: true, NS: true };
    this.clock = new THREE.Timer();
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

    const r = this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(devicePixelRatio, 1.75));
    r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 1.05;
    r.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(r.domElement);
    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = 'labels';
    host.appendChild(this.labels.domElement);

    const s = this.scene = new THREE.Scene();
    s.background = new THREE.Color(0x03070d);
    s.fog = new THREE.FogExp2(0x03070d, 0.0105);
    const cam = this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 600);
    cam.position.set(0, 120, 95);

    s.add(new THREE.HemisphereLight(0x9fc4ff, 0x0a0f18, 0.7));
    const key = new THREE.DirectionalLight(0xffffff, 1.4); key.position.set(-20, 40, 25); s.add(key);

    this.controls = new OrbitControls(cam, r.domElement);
    Object.assign(this.controls, { enableDamping: true, dampingFactor: 0.07, maxPolarAngle: 1.32, minDistance: 3.5, maxDistance: 140, screenSpacePanning: false, rotateSpeed: 0.6, zoomSpeed: 0.9 });
    this.controls.target.set(2, 0, 0);
    this.controls.addEventListener('start', () => { if(this.fly) this.fly = null; this.userMoved = true; });

    this.glowTex = glowTexture();
    this.buildGround();
    this.buildNetwork();
    this.buildSelection();

    this.composer = new EffectComposer(r);
    this.composer.addPass(new RenderPass(s, cam));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.7, 0.45, 0.32);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.useBloom = true;

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.bindPointer();
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();

    // intro sweep
    const [ot, op] = this.overviewPose(); this.flyTo(ot, op, 2.6);
    this.frames = 0; this.fpsT = 0;
    const loop = () => { this.raf = requestAnimationFrame(loop); this.tick(); };
    loop();
  }

  // ---------- world ----------
  buildGround(){
    const mat = new THREE.ShaderMaterial({
      transparent: false,
      uniforms: { uTime: { value: 0 } },
      vertexShader: `varying vec2 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.); vW = w.xz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: `
        varying vec2 vW; uniform float uTime;
        float grid(vec2 p, float s, float w){ vec2 g = abs(fract(p / s - .5) - .5) * s; vec2 fw = fwidth(p); vec2 l = smoothstep(fw * w, vec2(0.), g); return max(l.x, l.y); }
        void main(){
          float d = length(vW * vec2(.8, 1.35));
          vec3 base = mix(vec3(.018,.04,.07), vec3(.004,.01,.02), smoothstep(8., 42., d));
          float g1 = grid(vW, 1., 1.) * .022, g5 = grid(vW, 5., 1.3) * .055;
          float fade = 1. - smoothstep(18., 60., d);
          vec3 col = base + vec3(.3,.6,1.) * (g1 + g5) * fade;
          float scan = smoothstep(.0, .02, abs(fract(d * .08 - uTime * .03) - .5) - .47);
          col += vec3(.1,.3,.6) * (1. - scan) * .015 * fade;
          gl_FragColor = vec4(col, 1.);
          #include <colorspace_fragment>
        }`,
    });
    mat.extensions = { derivatives: true };
    this.groundMat = mat;
    const g = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), mat);
    g.rotation.x = -Math.PI / 2; this.scene.add(g);
  }

  stationVec(code, y = TRACK_Y){ const w = toWorld(STATIONS[code]); return new THREE.Vector3(w.x, y, w.z); }
  depotVec(code, y = TRACK_Y){ const w = toWorld(DEPOT_POS[code]); return new THREE.Vector3(w.x, y, w.z); }

  buildNetwork(){
    this.curves = {};          // line -> [{curve, codes:[..]}]
    this.lineGroups = {};
    const pillarGeo = new THREE.CylinderGeometry(0.05, 0.08, 1, 6); pillarGeo.translate(0, 0.5, 0);
    const pillarMat = new THREE.MeshStandardMaterial({ color: 0x1d2a38, roughness: .6, metalness: .3 });
    const pillars = [];
    for(const line of ['EW', 'NS']){
      const grp = this.lineGroups[line] = new THREE.Group(); this.scene.add(grp);
      const col = LINE_COLORS[line];
      const paths = [LINES[line].main.map(s => s[0])];
      if(LINES[line].branch) paths.push([LINES[line].branch.from, ...LINES[line].branch.stations.map(s => s[0])]);
      this.curves[line] = paths.map(codes => {
        const curve = new THREE.CatmullRomCurve3(codes.map(c => this.stationVec(c)), false, 'centripetal', 0.5);
        const segs = codes.length * 16;
        const core = new THREE.Mesh(new THREE.TubeGeometry(curve, segs, 0.07, 8, false),
          new THREE.MeshStandardMaterial({ color: col.base, emissive: col.glow, emissiveIntensity: 1.15, roughness: .3, metalness: .2 }));
        const halo = new THREE.Mesh(new THREE.TubeGeometry(curve, segs, 0.14, 10, false),
          new THREE.MeshBasicMaterial({ color: col.glow, transparent: true, opacity: 0.06, blending: THREE.AdditiveBlending, depthWrite: false }));
        const deck = new THREE.Mesh(new THREE.TubeGeometry(curve, segs, 0.16, 4, false),
          new THREE.MeshStandardMaterial({ color: 0x0d1620, roughness: .8, metalness: .2 }));
        deck.position.y = -0.14; deck.scale.y = 0.35;
        grp.add(deck, core, halo);
        const len = curve.getLength();
        for(let d = 0.6; d < len; d += 1.1){ pillars.push(curve.getPointAt(d / len)); }
        return { curve, codes };
      });
      // stations
      for(const [code, name] of [...LINES[line].main, ...(LINES[line].branch ? LINES[line].branch.stations : [])]){
        if(line === 'NS' && INTERCHANGE.has(code)) continue;       // drawn once, by EW
        const p = this.stationVec(code);
        const inter = INTERCHANGE.has(code);
        const plat = new THREE.Mesh(new THREE.CylinderGeometry(inter ? .34 : .22, inter ? .34 : .22, .14, 24),
          new THREE.MeshStandardMaterial({ color: 0xe8f1ff, emissive: 0xffffff, emissiveIntensity: inter ? .25 : .06, roughness: .15, metalness: .1 }));
        plat.position.copy(p); grp.add(plat);
        const ring = new THREE.Mesh(new THREE.TorusGeometry(inter ? .42 : .3, .035, 8, 40),
          new THREE.MeshBasicMaterial({ color: inter ? 0xffffff : col.glow }));
        ring.rotation.x = Math.PI / 2; ring.position.copy(p); grp.add(ring);
        const el = document.createElement('div');
        el.className = 'st-label' + (MAJOR.has(code) ? ' major' : '') + (inter ? ' inter' : '');
        el.innerHTML = `<b>${code}</b><span>${name}</span>`;
        el.style.setProperty('--c', inter ? '#fff' : col.cssGlow);
        const lab = new CSS2DObject(el); lab.position.copy(p).add(new THREE.Vector3(0, .55, 0)); grp.add(lab);
      }
    }
    // depots
    for(const [code, name] of Object.entries({ ECID: 'East Coast Integrated', TWD: 'Tuas West', UPD: 'Ulu Pandan', BSD: 'Bishan' })){
      const p = this.depotVec(code, 0.02);
      const hex = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, .08, 6),
        new THREE.MeshStandardMaterial({ color: 0x0f1d2b, emissive: 0x1a3550, emissiveIntensity: .6, roughness: .5, transparent: true, opacity: .9 }));
      hex.position.copy(p); this.scene.add(hex);
      const edge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.CylinderGeometry(1.1, 1.1, .08, 6)),
        new THREE.LineBasicMaterial({ color: 0x7fb6ff, transparent: true, opacity: .7 }));
      edge.position.copy(p); this.scene.add(edge);
      const el = document.createElement('div'); el.className = 'st-label depot major';
      el.innerHTML = `<b>${code}</b><span>${name} Depot</span>`;
      const lab = new CSS2DObject(el); lab.position.copy(p).add(new THREE.Vector3(0, .6, 0)); this.scene.add(lab);
    }
    const inst = new THREE.InstancedMesh(pillarGeo, pillarMat, pillars.length);
    const m = new THREE.Matrix4();
    pillars.forEach((p, i) => { m.makeScale(1, p.y - 0.12, 1); m.setPosition(p.x, 0, p.z); inst.setMatrixAt(i, m); });
    this.scene.add(inst);
  }

  buildSelection(){
    const beamMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uColor: { value: new THREE.Color(0xffffff) }, uTime: { value: 0 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }`,
      fragmentShader: `varying vec2 vUv; uniform vec3 uColor; uniform float uTime;
        void main(){ float a = pow(1. - vUv.y, 2.2) * (.26 + .08 * sin(uTime * 3. + vUv.y * 12.)); gl_FragColor = vec4(uColor * a, a); }`,
    });
    const beamGeo = new THREE.CylinderGeometry(.03, .16, 9, 24, 1, true); beamGeo.translate(0, 4.5, 0);
    this.beam = new THREE.Mesh(beamGeo, beamMat); this.beam.visible = false; this.scene.add(this.beam);
    this.rings = [0, 1, 2].map(i => {
      const ring = new THREE.Mesh(new THREE.RingGeometry(.5, .54, 64),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: .8, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
      ring.rotation.x = -Math.PI / 2; ring.visible = false; ring.userData.phase = i / 3; this.scene.add(ring); return ring;
    });
    this.routeMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(0xffffff) }, uLen: { value: 10 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }`,
      fragmentShader: `varying vec2 vUv; uniform float uTime, uLen; uniform vec3 uColor;
        void main(){ float s = fract(vUv.x * uLen * .9 - uTime * 1.4); float dash = smoothstep(0., .15, s) * (1. - smoothstep(.35, .6, s));
          float fade = 1. - smoothstep(.75, 1., vUv.x);
          float a = (.1 + .45 * dash) * fade; gl_FragColor = vec4(uColor * a, a); }`,
    });
    this.route = null;
    const el = document.createElement('div'); el.className = 'train-tag';
    this.tag = new CSS2DObject(el); this.tag.visible = false; this.scene.add(this.tag);
    const hv = document.createElement('div'); hv.className = 'train-tag hover';
    this.hoverTag = new CSS2DObject(hv); this.hoverTag.visible = false; this.scene.add(this.hoverTag);
  }

  // ---------- geometry helpers used by the app ----------
  rowPoint(line, row){
    if(row.kind === 'depot' && DEPOT_POS[row.code]) return this.depotVec(row.code);
    if(STATIONS[row.code]) return this.stationVec(row.code);
    return null;
  }
  // Position/heading of a train moving from row a to row b, fraction f.
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
    const col = LINE_COLORS[line];
    const group = new THREE.Group();
    const bodyGeo = new THREE.CapsuleGeometry(.15, .75, 4, 12); bodyGeo.rotateX(Math.PI / 2);
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0xf4f8ff, emissive: col.glow, emissiveIntensity: .8, roughness: .25, metalness: .35 });
    const body = new THREE.Mesh(bodyGeo, bodyMat); group.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(.07, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    head.position.z = .52; group.add(head);
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTex, color: col.glow, transparent: true, opacity: .45, blending: THREE.AdditiveBlending, depthWrite: false }));
    halo.scale.setScalar(1.1); group.add(halo);
    const hit = new THREE.Mesh(new THREE.SphereGeometry(.75, 8, 6), new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
    hit.userData.trainId = id; group.add(hit);
    group.position.y = TRACK_Y + .12;
    this.scene.add(group);
    const t = { id, line, group, body, bodyMat, halo, hit, head, state: null, pos: new THREE.Vector3(), dir: new THREE.Vector3(0, 0, 1), seen: false };
    this.trains.set(id, t);
    return t;
  }

  // list: [{id, line, pos, dir, state: 'svc'|'off'|'idle'|'hidden'}]
  syncTrains(list){
    const alive = new Set();
    for(const it of list){
      alive.add(it.id);
      const t = this.trains.get(it.id) || this.makeTrain(it.id, it.line);
      const show = it.state !== 'hidden' && this.visibleLines[it.line];
      t.group.visible = show || it.id === this.selected;
      if(!it.pos){ t.group.visible = false; continue; }
      // snap on first sight / big jumps (time scrub), glide otherwise
      if(!t.seen || t.pos.distanceTo(it.pos) > 3){ t.pos.copy(it.pos); t.seen = true; }
      else t.pos.lerp(it.pos, .35);
      if(it.dir && it.dir.lengthSq() > 1e-6) t.dir.lerp(it.dir, .3).normalize();
      t.group.position.set(t.pos.x, TRACK_Y + .12, t.pos.z);
      t.group.lookAt(t.pos.x + t.dir.x, TRACK_Y + .12, t.pos.z + t.dir.z);
      if(t.state !== it.state){
        t.state = it.state;
        const c = it.state === 'off' ? OFF_COLOR : LINE_COLORS[t.line].glow;
        t.bodyMat.emissive.setHex(c); t.halo.material.color.setHex(c);
        const dim = it.state === 'idle' || it.state === 'hidden';
        t.bodyMat.emissiveIntensity = t.id === this.selected ? 2.2 : dim ? .3 : .8; t.halo.material.opacity = dim ? .15 : .45;
      }
    }
    for(const [id, t] of this.trains){ if(!alive.has(id)){ t.group.visible = false; } }
  }

  setLineVisible(line, v){
    this.visibleLines[line] = v;
    this.lineGroups[line].visible = v;
  }

  select(id, { fly = true } = {}){
    const prev = this.trains.get(this.selected);
    if(prev){ prev.group.scale.setScalar(1); prev.bodyMat.emissiveIntensity = prev.state === 'idle' ? .3 : .8; prev.halo.scale.setScalar(1.1); }
    this.selected = id;
    const t = this.trains.get(id);
    this.beam.visible = !!t; this.rings.forEach(r => r.visible = !!t); this.tag.visible = !!t;
    if(!t){ this.setRoute(null); return; }
    t.group.scale.setScalar(1.35);
    t.bodyMat.emissiveIntensity = 2.2; t.halo.scale.setScalar(1.9);
    const col = t.state === 'off' ? OFF_COLOR : LINE_COLORS[t.line].glow;
    this.beam.material.uniforms.uColor.value.setHex(col);
    this.rings.forEach(r => r.material.color.setHex(col));
    this.routeMat.uniforms.uColor.value.setHex(col).lerp(new THREE.Color(0xffffff), .35);
    this.tag.element.textContent = id;
    this.tag.element.style.setProperty('--c', LINE_COLORS[t.line].cssGlow);
    this.follow = true;
    if(fly){
      const off = this.camera.position.clone().sub(this.controls.target);
      off.setLength(Math.min(Math.max(off.length(), 7), 11)); if(off.y < 3.5) off.y = 5;
      this.flyTo(t.pos.clone(), t.pos.clone().add(off), 1.5);
    }
  }

  setRoute(points){
    if(this.route){ this.scene.remove(this.route); this.route.geometry.dispose(); this.route = null; }
    if(!points || points.length < 2) return;
    const curve = new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(p.x, TRACK_Y + .02, p.z)), false, 'centripetal');
    const len = curve.getLength();
    this.routeMat.uniforms.uLen.value = len;
    this.route = new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(16, Math.round(len * 10)), .1, 8, false), this.routeMat);
    this.scene.add(this.route);
  }

  flyTo(target, position, dur = 1.4){
    if(this.reduced) dur = 0.01;
    this.fly = { t0: performance.now(), dur: dur * 1000, fromT: this.controls.target.clone(), fromP: this.camera.position.clone(), toT: target, toP: position };
  }
  overviewPose(){
    const wide = this.host.clientWidth > 860;
    return [new THREE.Vector3(2, 0, 2), new THREE.Vector3(2, wide ? 40 : 62, wide ? 38 : 50)];
  }
  // Keep the interesting part of the map in the area not covered by UI panels.
  setInsets(ins){ this.insets = ins; this.applyInsets(); }
  applyInsets(){
    const w = this.host.clientWidth, h = this.host.clientHeight, i = this.insets || {};
    if(!w || !h) return;
    const dx = ((i.right || 0) - (i.left || 0)) / 2, dy = ((i.bottom || 0) - (i.top || 0)) / 2;
    if(dx || dy) this.camera.setViewOffset(w, h, dx, dy, w, h); else this.camera.clearViewOffset();
  }
  overview(){ this.follow = false; const [t, p] = this.overviewPose(); this.flyTo(t, p, 1.6); }

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
        this.hovered = id;
        const t = id && this.trains.get(id);
        this.hoverTag.visible = !!t && id !== this.selected;
        if(t){ this.hoverTag.element.textContent = id; this.hoverTag.element.style.setProperty('--c', LINE_COLORS[t.line].cssGlow); }
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
    this.composer.setSize(w, h);
    this.bloom.resolution.set(w / 2, h / 2);
  }

  // ---------- frame ----------
  tick(){
    this.clock.update(); const dt = Math.min(this.clock.getDelta(), .1), time = this.clock.getElapsed();
    if(this.beforeRender) this.beforeRender(dt);
    this.groundMat.uniforms.uTime.value = time;
    this.routeMat.uniforms.uTime.value = time;
    this.beam.material.uniforms.uTime.value = time;

    const sel = this.trains.get(this.selected);
    if(sel){
      const p = sel.group.position;
      this.beam.position.set(p.x, TRACK_Y, p.z);
      this.rings.forEach(r => {
        const k = (time * .55 + r.userData.phase) % 1;
        r.position.set(p.x, TRACK_Y - .1, p.z); r.scale.setScalar(1 + k * 2.6); r.material.opacity = .45 * (1 - k) * (1 - k);
      });
      this.tag.position.set(p.x, TRACK_Y + 1.5, p.z);
      if(this.follow && !this.fly){
        const delta = p.clone().setY(0).sub(this.controls.target);
        this.controls.target.add(delta.multiplyScalar(.08));
        this.camera.position.add(delta);
      }
    }
    const camD = this.camera.position.distanceTo(this.controls.target);
    const k = Math.min(2.4, Math.max(1, camD / 24));
    for(const t of this.trains.values()){
      if(!t.group.visible) continue;
      const base = t.id === this.selected ? 1.35 : 1;
      t.group.scale.setScalar(base * k);
    }
    const hv = this.trains.get(this.hovered);
    if(hv) this.hoverTag.position.set(hv.group.position.x, TRACK_Y + 1.3, hv.group.position.z);

    if(this.fly){
      const k = Math.min(1, (performance.now() - this.fly.t0) / this.fly.dur), e = ease(k);
      this.controls.target.lerpVectors(this.fly.fromT, this.fly.toT, e);
      this.camera.position.lerpVectors(this.fly.fromP, this.fly.toP, e);
      if(k >= 1) this.fly = null;
    }
    this.controls.update();
    // labels: show all station names when zoomed in
    const dist = this.camera.position.distanceTo(this.controls.target);
    this.labels.domElement.dataset.zoom = dist < 16 ? 'near' : dist < 45 ? 'mid' : 'far';

    if(this.useBloom) this.composer.render(); else this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);

    // drop bloom on slow devices
    this.frames++; this.fpsT += dt;
    if(this.fpsT > 3){
      const fps = this.frames / this.fpsT; this.frames = 0; this.fpsT = 0;
      if(fps < 28 && this.useBloom){ this.useBloom = false; this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.25)); this.resize(); }
    }
  }
}
