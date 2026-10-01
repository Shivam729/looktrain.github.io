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
const LANE = 0.24;          // each direction runs on its own track, this far either side of the centreline
const OFF_COLOR = 0xffb100;
const IDLE_COLOR = 0x8a96a8;
const MAJOR = new Set(['JUR', 'CTH', 'RFP', 'TLK', 'PSR', 'CGA', 'MSP', 'WDL', 'AMK', 'BSH', 'TNM', 'OTP', 'DBG', 'YIS', 'KRJ', 'CLE', 'BNL', 'PYL', 'NEW']);
const INTERCHANGE = new Set(['JUR', 'CTH', 'RFP']);
const TRAIN_COLORS = { EW: 0x2fd46f, NS: 0xff4d33 };
const ease = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const _v = new THREE.Vector3(), _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);

// All labels are painted onto one 2D canvas over the WebGL view (no DOM elements to lay out or
// composite). Repainted only when the 3D view is re-rendered.
const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
class LabelLayer {
  constructor(host){
    // two layers: stations/depots (redrawn only when the camera moves) and trains (every frame)
    this.canvasS = document.createElement('canvas'); this.canvasS.className = 'labels';
    this.canvas = document.createElement('canvas'); this.canvas.className = 'labels';
    host.appendChild(this.canvasS); host.appendChild(this.canvas);
    this.el = this.canvas;                                  // dataset.zoom is set on it by the scene
    this.ctxS = this.canvasS.getContext('2d');
    this.ctxD = this.canvas.getContext('2d');
    this.ctx = this.ctxD;
    this.camKey = '';
    this.items = [];
    this.w = 1; this.h = 1; this.dpr = 1;
    this.widths = new Map();
  }
  // spec: {kind: 'station'|'inter'|'depot'|'train'|'tag', text, sub, color}
  add(spec, pos, { dy = 0 } = {}){
    const it = { ...spec, pos, dy, want: true, state: null, hover: false, showSub: false };
    this.items.push(it); return it;
  }
  setSize(w, h, dpr){
    this.w = w; this.h = h; this.dpr = dpr;
    for(const cv of [this.canvas, this.canvasS]){
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
      cv.style.width = w + 'px'; cv.style.height = h + 'px';
    }
    this.camKey = '';
  }
  textW(font, text){
    const k = font + '|' + text;
    let v = this.widths.get(k);
    if(v === undefined){ this.ctx.font = font; v = this.ctx.measureText(text).width; this.widths.set(k, v); }
    return v;
  }
  pill(x, y, w, h, r, fill, stroke, lw){
    const c = this.ctx;
    c.beginPath();
    c.moveTo(x + r, y); c.lineTo(x + w - r, y); c.arcTo(x + w, y, x + w, y + r, r); c.lineTo(x + w, y + h - r);
    c.arcTo(x + w, y + h, x + w - r, y + h, r); c.lineTo(x + r, y + h); c.arcTo(x, y + h, x, y + h - r, r);
    c.lineTo(x, y + r); c.arcTo(x, y, x + r, y, r); c.closePath();
    c.fillStyle = fill; c.fill();
    if(stroke){ c.lineWidth = lw; c.strokeStyle = stroke; c.stroke(); }
  }
  // force: station labels changed (zoom level / line toggle) even if the camera didn't move
  update(camera, force = false){
    const W = this.w, H = this.h;
    const e = camera.matrixWorld.elements, pm = camera.projectionMatrix.elements;
    const key = e.map(v => v.toFixed(4)).join(',') + pm[8].toFixed(4) + pm[9].toFixed(4) + W + 'x' + H;
    const passes = ['train', 'tag'];
    if(force || key !== this.camKey){ this.camKey = key; passes.unshift('station'); }
    for(const pass of passes){
      const c = this.ctx = pass === 'station' ? this.ctxS : this.ctxD;
      if(pass !== 'tag'){
        c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        c.clearRect(0, 0, W, H);
        c.textBaseline = 'middle'; c.textAlign = 'center';
      }
      for(const it of this.items){
        if(!it.want) continue;
        const kind = it.kind === 'inter' || it.kind === 'depot' ? 'station' : it.kind;
        if(kind !== pass) continue;
        _v.copy(it.pos).project(camera);
        if(_v.z > 1 || _v.x < -1.05 || _v.x > 1.05 || _v.y < -1.05 || _v.y > 1.05) continue;
        const x = (_v.x + 1) / 2 * W, y = (1 - _v.y) / 2 * H + it.dy;
        if(pass === 'station'){
          const font = `750 10px ${FONT}`, tw = this.textW(font, it.text), w = tw + 12, h = 17;
          const inter = it.kind === 'inter', depot = it.kind === 'depot';
          this.pill(x - w / 2, y, w, h, 5, inter ? '#fff' : 'rgba(5,9,16,.9)', inter ? null : (depot ? '#8fb4e8' : it.color), 1.5);
          c.font = font; c.fillStyle = inter ? '#05090f' : depot ? '#cfe0ff' : '#fff';
          c.fillText(it.text, x, y + h / 2 + .5);
          if(it.showSub && it.sub){
            const f2 = `600 10.5px ${FONT}`; c.font = f2;
            c.lineWidth = 3; c.strokeStyle = 'rgba(0,0,0,.85)'; c.lineJoin = 'round';
            c.strokeText(it.sub, x, y + h + 8); c.fillStyle = '#e8eef8'; c.fillText(it.sub, x, y + h + 8);
          }
        } else if(pass === 'train'){
          const font = `800 11px ${FONT}`, tw = this.textW(font, it.text), w = tw + 12, h = 16;
          const border = it.state === 'off' ? '#ffb100' : it.state === 'idle' ? '#8a96a8' : it.color;
          this.pill(x - w / 2, y - h, w, h, h / 2, it.hover ? '#fff' : 'rgba(5,9,16,.9)', border, 1.5);
          c.font = font; c.fillStyle = it.hover ? '#05090f' : it.state === 'off' ? '#ffe2a6' : it.state === 'idle' ? '#c9d2de' : '#fff';
          c.fillText(it.text, x, y - h / 2 + .5);
        } else {
          const font = `800 14px ${FONT}`, tw = this.textW(font, it.text), w = tw + 22, h = 24;
          this.pill(x - w / 2, y - h, w, h, h / 2, '#fff', it.color, 2.5);
          c.font = font; c.fillStyle = '#05090f'; c.fillText(it.text, x, y - h / 2 + .5);
        }
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
    this.fx = !this.reduced;          // pulses / trails / flowing route (off for reduced-motion users)

    const r = this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(devicePixelRatio, 2));
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
        const casing = new THREE.Mesh(new THREE.TubeGeometry(curve, segs, LANE + .1, 6, false), casingMat);
        casing.scale.y = .35; casing.position.y = TRACK_Y * .65;      // flattened bed under both tracks
        const railMat = new THREE.MeshBasicMaterial({ color: col.base });
        for(const side of [1, -1]){
          const rail = new THREE.Mesh(new THREE.TubeGeometry(this.offsetCurve(curve, side * LANE, segs), segs, 0.045, 5, false), railMat);
          rail.position.y = 0.09;     // rails sit just above the bed
          grp.add(rail);
        }
        grp.add(casing);
        const len = curve.getLength();
        for(let d = 0.6; d < len; d += 1.2){ pillars.push(curve.getPointAt(d / len)); }
        return { curve, codes, idx: new Map(codes.map((c, i) => [c, i])), n: codes.length - 1 };
      });
      for(const [code, name] of [...LINES[line].main, ...(LINES[line].branch ? LINES[line].branch.stations : [])]){
        if(line === 'NS' && INTERCHANGE.has(code)) continue;
        const p = this.stationVec(code);
        const inter = INTERCHANGE.has(code);
        dots.push({ p, inter, line });
        const it = this.labels.add({ kind: inter ? 'inter' : 'station', text: code, sub: name, color: col.css }, p.clone().setY(TRACK_Y + .1), { dy: 7 });
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
      const it = this.labels.add({ kind: 'depot', text: code, sub: name + ' Depot' }, p.clone(), { dy: 12 }); it.major = true;
      this.depotLabels.push(it);
    }
    const inst = new THREE.InstancedMesh(pillarGeo, pillarMat, pillars.length);
    pillars.forEach((p, i) => { _m.makeScale(1, p.y - 0.14, 1); _m.setPosition(p.x, 0, p.z); inst.setMatrixAt(i, _m); });
    this.scene.add(inst);
  }

  // Curve shifted sideways by `d` (positive = left of the direction the curve runs).
  offsetCurve(curve, d, n){
    const pts = [];
    for(let i = 0; i <= n; i++){
      const t = i / n, p = curve.getPoint(t), tg = curve.getTangent(t);
      pts.push(new THREE.Vector3(p.x + tg.z * d, p.y, p.z - tg.x * d));
    }
    return new THREE.CatmullRomCurve3(pts, false, 'centripetal');
  }

  layoutDots(){
    this.dots.forEach(({ p, inter, line }, i) => {
      const on = this.visibleLines[line] || inter;
      _m.compose(_v.set(p.x, TRACK_Y + .1, p.z), _q.identity(), _s.setScalar(on ? (inter ? .48 : .36) : 0).setY(on ? 1 : 0));
      this.ringIM.setMatrixAt(i, _m);
      _m.compose(_v.set(p.x, TRACK_Y + .13, p.z), _q.identity(), _s.setScalar(on ? (inter ? .4 : .28) : 0).setY(on ? 1 : 0));
      this.dotIM.setMatrixAt(i, _m);
    });
    this.ringIM.instanceMatrix.needsUpdate = this.dotIM.instanceMatrix.needsUpdate = true;
  }

  buildTrains(){
    // Top-down silhouette (x = width, y = length forward), extruded upward: a long car body with
    // a pointed nose, so it reads as a train and shows its direction like an arrow.
    const silhouette = (w, len, nose) => {
      const sh = new THREE.Shape();
      sh.moveTo(-w, -len / 2); sh.lineTo(w, -len / 2); sh.lineTo(w, len / 2 - nose);
      sh.lineTo(w * .35, len / 2); sh.lineTo(-w * .35, len / 2); sh.lineTo(-w, len / 2 - nose); sh.closePath();
      return sh;
    };
    const extrude = (sh, depth) => {
      const g = new THREE.ExtrudeGeometry(sh, { depth, bevelEnabled: false });
      g.rotateX(-Math.PI / 2);                  // shape y -> world -z, extrusion -> +y
      g.rotateY(Math.PI);                       // nose towards +z (direction of travel)
      return g;
    };
    const body = extrude(silhouette(.17, 1.3, .32), .2);
    const outline = extrude(silhouette(.235, 1.46, .38), .14); outline.translate(0, -.03, 0);
    // dark windscreen across the nose + a window band along the side
    const ws = new THREE.Shape();
    ws.moveTo(-.13, .3); ws.lineTo(.13, .3); ws.lineTo(.07, .54); ws.lineTo(-.07, .54); ws.closePath();
    const windscreen = extrude(ws, .01); windscreen.translate(0, .205, 0);
    this.trainGeo = { body, outline, arrow: windscreen };
    this.allocTrains(256);
  }
  allocTrains(cap){
    for(const k of ['outlineIM', 'bodyIM', 'arrowIM', 'trailIM']) if(this[k]){ this.scene.remove(this[k]); this[k].dispose(); }
    const mk = (geo, mat) => { const m = new THREE.InstancedMesh(geo, mat, cap); m.count = 0; m.frustumCulled = false; this.scene.add(m); return m; };
    this.outlineIM = mk(this.trainGeo.outline, new THREE.MeshBasicMaterial({ color: 0xffffff }));
    this.bodyIM = mk(this.trainGeo.body, new THREE.MeshBasicMaterial({ color: 0xffffff }));
    this.arrowIM = mk(this.trainGeo.arrow, new THREE.MeshBasicMaterial({ color: 0x07101c }));   // windscreen
    this.bodyIM.setColorAt(0, new THREE.Color(0xffffff));   // allocates instanceColor
    // FX: a pulsing halo under every running train and a light trail behind moving ones.
    const trailGeo = new THREE.PlaneGeometry(1, 1); trailGeo.rotateX(-Math.PI / 2); trailGeo.translate(0, 0, -.5);
    trailGeo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(new Float32Array(cap), 1));
    this.trailIM = mk(trailGeo, this.fxMat('trail'));
    this.trailIM.setColorAt(0, new THREE.Color(0xffffff));
    this.trailIM.renderOrder = -1;    // under the train bodies
    this.cap = cap;
    this.instancesDirty = true;
  }

  fxMat(kind){
    if(!this.fxUniforms) this.fxUniforms = { uTime: { value: 0 } };
    const frag = kind === 'halo'
      ? `float d = length(vUv - .5) * 2.; float t = fract(uTime * .5 + vPh);
         float ring = smoothstep(.13, 0., abs(d - t)) * (1. - t);
         float glow = smoothstep(1., .0, d) * .22;
         float a = (ring * .85 + glow) * step(d, 1.);`
      : `float side = 1. - abs(vUv.x - .5) * 2.;
         float tail = pow(1. - vUv.y, 1.6);
         float a = side * side * tail * .55;`;
    return new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: this.fxUniforms,
      vertexShader: `attribute float aPhase; varying vec2 vUv; varying vec3 vCol; varying float vPh;
        void main(){ vUv = uv; vCol = instanceColor; vPh = aPhase; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.); }`,
      fragmentShader: `uniform float uTime; varying vec2 vUv; varying vec3 vCol; varying float vPh;
        void main(){ ${frag} if(a < .004) discard; gl_FragColor = vec4(vCol * a, a); }`,
    });
  }

  buildSelection(){
    const ring = new THREE.Mesh(new THREE.RingGeometry(.62, .74, 48), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: .95, depthWrite: false, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2; ring.visible = false; this.scene.add(ring); this.selRing = ring;
    const halo = new THREE.Mesh(new THREE.RingGeometry(.74, 1.25, 48), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: .16, depthWrite: false, side: THREE.DoubleSide }));
    halo.rotation.x = -Math.PI / 2; halo.visible = false; this.scene.add(halo); this.selHalo = halo;
    const halo2 = halo.clone(); halo2.material = halo.material.clone(); this.scene.add(halo2); this.selHalo2 = halo2;
    const beamGeo = new THREE.CylinderGeometry(.04, .2, 6, 20, 1, true); beamGeo.translate(0, 3, 0);
    this.beam = new THREE.Mesh(beamGeo, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { uColor: { value: new THREE.Color(0xffffff) } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }`,
      fragmentShader: `varying vec2 vUv; uniform vec3 uColor; void main(){ float a = pow(1. - vUv.y, 2.) * .3; gl_FragColor = vec4(uColor * a, a); }`,
    }));
    this.beam.visible = false; this.scene.add(this.beam);
    const pinGeo = new THREE.CylinderGeometry(.025, .025, 1.6, 6); pinGeo.translate(0, .8, 0);
    this.pin = new THREE.Mesh(pinGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: .75 }));
    this.pin.visible = false; this.scene.add(this.pin);
    this.routeMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { uLen: { value: 10 }, uTime: this.fxUniforms ? this.fxUniforms.uTime : { value: 0 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }`,
      fragmentShader: `varying vec2 vUv; uniform float uLen, uTime;
        void main(){ float s = fract(vUv.x * uLen * 1.6 - uTime * 1.4); if(s > .55) discard; gl_FragColor = vec4(vec3(1.), .95); }`,
    });
    this.route = null;
    this.tagPos = new THREE.Vector3();
    this.tag = this.labels.add({ kind: 'tag', text: '', color: '#fff' }, this.tagPos, { dy: -10 }); this.tag.want = false;
  }

  // ---------- geometry helpers used by the app ----------
  rowPoint(line, row){
    if(row.kind === 'depot' && DEPOT_POS[row.code]) return this.depotVec(row.code);
    if(STATIONS[row.code]) return this.stationVec(row.code);
    return null;
  }
  poseBetween(line, a, b, f){
    if(a.kind !== 'depot' && b.kind !== 'depot') for(const { curve, idx, n } of this.curves[line]){
      const ia = idx.get(a.code), ib = idx.get(b.code);
      if(ia !== undefined && ib !== undefined && Math.abs(ia - ib) === 1){
        const t = (ia + (ib - ia) * f) / n;
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
    const pos = new THREE.Vector3();
    const label = this.labels.add({ kind: 'train', text: id, color: LINE_COLORS[line].css }, pos, { dy: -9 });
    label.want = false;
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
      if(it.dir && it.dir.lengthSq() > 1e-6){
        _v.copy(it.dir).setY(0).normalize();
        if(t.dir.distanceToSquared(_v) > 1e-8){ t.dir.copy(_v); if(vis) this.instancesDirty = true; }
      }
      // place the train on its direction's track: offset to the left of its heading
      const x = it.pos.x + t.dir.z * LANE, z = it.pos.z - t.dir.x * LANE;
      const dx = t.pos.x - x, dz = t.pos.z - z;                    // compare on the ground plane (y is fixed)
      if(!t.seen || dx * dx + dz * dz > 1e-8){ t.pos.set(x, TRACK_Y + .2, z); t.seen = true; if(vis) this.instancesDirty = true; }
      if(t.state !== it.state){ t.state = it.state; t.label.state = it.state; this.instancesDirty = true; }
      if(t.moving !== !!it.moving){ t.moving = !!it.moving; this.instancesDirty = true; }
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
      _m.compose(t.pos, _q, _s.set(Math.min(s, .62), s, s));   // slim enough that the two directions stay apart
      this.outlineIM.setMatrixAt(i, _m);
      this.bodyIM.setMatrixAt(i, _m);
      this.arrowIM.setMatrixAt(i, _m);
      col.setHex(t.state === 'off' ? OFF_COLOR : t.state === 'idle' || t.state === 'hidden' ? IDLE_COLOR : TRAIN_COLORS[t.line]);
      this.bodyIM.setColorAt(i, col);
      // halo: running trains only; trail: only while actually moving between stations
      const running = t.state === 'svc' || t.state === 'off';
      _m.compose(_v.set(t.pos.x, TRACK_Y + .1, t.pos.z), _q, _s.set(s * .34, 1, s * 3.4));
      this.trailIM.setMatrixAt(i, running && t.moving ? _m : _zero);
      this.trailIM.setColorAt(i, col);
      if(t.phase === undefined){ let h = 0; for(const ch of t.id) h = (h * 31 + ch.charCodeAt(0)) % 997; t.phase = h / 997; }
      this.trailIM.geometry.attributes.aPhase.array[i] = t.phase;
    });
    for(const m of [this.outlineIM, this.bodyIM, this.arrowIM, this.trailIM]){ m.count = vis.length; m.instanceMatrix.needsUpdate = true; }
    this.bodyIM.instanceColor.needsUpdate = this.trailIM.instanceColor.needsUpdate = true;
    this.trailIM.geometry.attributes.aPhase.needsUpdate = true;
    this.visibleList = vis;
    this.instancesDirty = false;
  }

  setLineVisible(line, v){
    this.visibleLines[line] = v; this.lineGroups[line].visible = v;
    this.layoutDots(); this.dirty = this.instancesDirty = true;
  }

  select(id, { fly = true } = {}){
    const prev = this.trains.get(this.selected);
    this.selected = id;
    const t = this.trains.get(id);
    [this.selRing, this.pin, this.beam].forEach(m => m.visible = !!t);
    this.tag.want = !!t;
    this.dirty = this.instancesDirty = true;
    if(!t){ this.setRoute(null); return; }
    this.tag.text = id; this.tag.color = LINE_COLORS[t.line].css;
    this.beam.material.uniforms.uColor.value.setHex(TRAIN_COLORS[t.line]);
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
    const shifted = points.map((p, i) => {
      const a = points[Math.max(0, i - 1)], b = points[Math.min(points.length - 1, i + 1)];
      _v.set(b.x - a.x, 0, b.z - a.z); if(_v.lengthSq() < 1e-10) _v.set(0, 0, 1); _v.normalize();
      return new THREE.Vector3(p.x + _v.z * LANE, TRACK_Y + .12, p.z - _v.x * LANE);
    });
    const curve = new THREE.CatmullRomCurve3(shifted, false, 'centripetal');
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
          const old = this.trains.get(this.hovered); if(old) old.label.hover = false;
          this.hovered = id;
          const t = this.trains.get(id); if(t) t.label.hover = true;
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
    this.renderer.setSize(w, h); this.labels.setSize(w, h, this.renderer.getPixelRatio());
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
    const now = performance.now() / 1000;
    if(this.fx){ this.fxUniforms.uTime.value = now; this.dirty = true; }   // pulses, trails and flowing route animate
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
      this.beam.position.set(p.x, TRACK_Y, p.z); this.beam.scale.set(k, 1, k);
      this.pin.position.set(p.x, TRACK_Y + .2, p.z); this.pin.scale.set(k, k * 1.6, k);
      this.tagPos.set(p.x, TRACK_Y + .2 + 2.6 * k, p.z);
    }
    // label visibility by zoom: far = major stations only, mid/near = everything + train numbers
    const zoom = camD < 18 ? 'near' : camD < 48 ? 'mid' : 'far';
    if(zoom !== this.zoom){
      this.zoom = zoom; this.labels.el.dataset.zoom = zoom; this.labelsForce = true;
      for(const line of ['EW', 'NS']) for(const it of this.stationLabels[line]) it.want = this.visibleLines[line] && (zoom !== 'far' || it.major);
      for(const it of [...this.stationLabels.EW, ...this.stationLabels.NS, ...this.depotLabels]) it.showSub = zoom === 'near' || (zoom === 'mid' && it.major);
    }
    for(const line of ['EW', 'NS']) if(this.lineLabelState !== JSON.stringify(this.visibleLines)){
      for(const it of this.stationLabels[line]) it.want = this.visibleLines[line] && (zoom !== 'far' || it.major);
    }
    if(this.lineLabelState !== JSON.stringify(this.visibleLines)) this.labelsForce = true;
    this.lineLabelState = JSON.stringify(this.visibleLines);
    for(const t of this.trains.values()){
      t.label.want = t.group.visible && t.id !== this.selected && t.state !== 'hidden' && (zoom !== 'far' || t.id === this.hovered);
    }
    this.renderer.render(this.scene, this.camera);
    this.labels.update(this.camera, this.labelsForce); this.labelsForce = false;
  }
}
