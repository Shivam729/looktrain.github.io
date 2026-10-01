import * as THREE from 'three';
import { NetworkScene } from './scene.js';
import { LINE_COLORS } from './geo.js';
import {
  VERSIONS, DIR_NAMES, sgNow, hms, inText, esc, tableTime, status, buildPlans,
  unlockWith, restoreKey, forgetKey, loadVersion, SERVICE_START,
} from './timetable.js';

const $ = s => document.querySelector(s);
const DAY_START = 4.5 * 3600, DAY_END = 25.75 * 3600;   // slider range: 04:30 -> 01:45
const SPEEDS = [1, 60, 300, 600];
const LINE_SHORT = { EW: 'EWL', NS: 'NSL' };

// ---------- state ----------
const S = {
  day: sgNow().day,
  data: {},                 // line -> {ds, plans}
  clock: { mode: 'live', base: 0, real0: 0, speed: 60, playing: false },
  sel: null,                // {line, id}
  tab: 'stops',
  cardKey: '',
  routeKey: '',
  statusCache: new Map(),
};

function nowT(){
  const c = S.clock;
  if(c.mode === 'live') return sgNow().sec;
  let t = c.base + (c.playing ? (performance.now() - c.real0) / 1000 * c.speed : 0);
  if(t > DAY_END + 1800){ c.base = DAY_START; c.real0 = performance.now(); t = DAY_START; }
  return t;
}
function setSim(t, playing = S.clock.playing){
  S.clock = { ...S.clock, mode: 'sim', base: t, real0: performance.now(), playing };
  S.force = true;
  syncDock();
}
function goLive(){ S.clock = { ...S.clock, mode: 'live', playing: false }; S.force = true; syncDock(); }

// ---------- scene ----------
const scene = new NetworkScene($('#stage'), { onPick: id => selectTrain(id) });
window.__scene = scene;     // handy for debugging from the console
window.__app = { S, findTrain: id => findTrain(id) };
try{ scene.focusOnly = localStorage.getItem('lookup.focus') !== '0'; }catch(e){ scene.focusOnly = true; }

function poseOf(line, st){
  if(!st) return null;
  if(st.kind === 'moving'){
    if(st.frac >= 1 || st.prev === st.next){
      const p = scene.rowPoint(line, st.next);
      const q = st.trip.rows[st.nextIdx + 1] ? scene.rowPoint(line, st.trip.rows[st.nextIdx + 1]) : null;
      const pr = scene.rowPoint(line, st.prev);
      const dir = q && p ? q.clone().sub(p) : (p && pr ? p.clone().sub(pr) : new THREE.Vector3(1, 0, 0));
      return p ? { pos: p, dir: dir.normalize(), state: st.off ? 'off' : 'svc' } : null;
    }
    const pose = scene.poseBetween(line, st.prev, st.next, st.frac);
    return pose ? { ...pose, state: st.off ? 'off' : 'svc' } : null;
  }
  const p = st.at && scene.rowPoint(line, st.at);
  if(!p) return null;
  let dir = new THREE.Vector3(1, 0, 0);
  if(st.kind === 'layover' && st.trip.rows[1]){ const q = scene.rowPoint(line, st.trip.rows[1]); if(q) dir = q.sub(p).normalize(); }
  return { pos: p, dir, state: st.kind === 'layover' ? 'idle' : 'hidden' };
}

let lastUi = 0;
// Train positions: recomputed every frame while a replay is playing, otherwise 10x a second
// (a train moves well under a metre in 100ms at real speed). The camera still runs at full rate.
let lastCompute = 0;
S.force = true;
scene.beforeRender = () => {
  const now = performance.now();
  const playing = S.clock.mode === 'sim' && S.clock.playing;
  if(!playing && !S.force && now - lastCompute < 100){
    if(now - lastUi > 200){ lastUi = now; updateUi(nowT()); }
    return;
  }
  S.force = false; lastCompute = now;
  const T = nowT();
  const list = [];
  S.statusCache.clear();
  for(const [line, d] of Object.entries(S.data)){
    for(const [id, trips] of Object.entries(d.plans)){
      const st = status(trips, T);
      S.statusCache.set(id, { line, st });
      const pose = poseOf(line, st);
      list.push({ id, line, pos: pose && pose.pos, dir: pose && pose.dir, state: pose ? pose.state : 'hidden' });
    }
  }
  scene.syncTrains(list);
  if(now - lastUi > 200){ lastUi = now; updateUi(T); }
};

// ---------- data ----------
async function loadDay(day){
  S.day = day;
  S.data = {};
  scene.syncTrains([]);
  renderDays();
  const jobs = Object.entries(VERSIONS).filter(([, v]) => v[day]).map(async ([line, v]) => {
    const ds = await loadVersion(v[day]);
    if(S.day !== day) return;
    S.data[line] = { ds, plans: buildPlans(line, ds) };
  });
  S.loading = Promise.all(jobs);
  try{ await S.loading; }
  catch(e){ toast('Couldn\'t load the timetable — check your connection.'); }
  S.loading = null;
  renderDays();
  if(S.sel && !findTrain(S.sel.id)) clearSelection();
  S.cardKey = ''; S.force = true;
}

function findTrain(id){
  for(const [line, d] of Object.entries(S.data)){
    if(d.plans[id] || d.ds.trains[id]) return { line, id };
  }
  return null;
}

// ---------- selection ----------
function selectTrain(id, { fly = true } = {}){
  const f = findTrain(id);
  if(!f){ toast(`No train ${id} in the ${S.day} timetable.`); return; }
  S.sel = f; S.cardKey = ''; S.routeKey = '';
  if(!scene.trains.get(id)) scene.syncTrains([{ id, line: f.line, pos: null, state: 'hidden' }]);
  scene.select(id, { fly }); S.force = true;
  $('#q').value = id;
  document.body.classList.add('has-sel');
  setSheet(true);
  updateUi(nowT());
}
function clearSelection(){
  S.sel = null; S.cardKey = ''; scene.select(null); scene.setRoute(null); S.force = true;
  document.body.classList.remove('has-sel');
  $('#q').value = '';
  updateUi(nowT());
}

// ---------- UI rendering ----------
function renderDays(){
  const today = sgNow().day;
  document.querySelectorAll('#days button').forEach(b => {
    const d = b.dataset.day;
    b.classList.toggle('on', d === S.day);
    b.querySelector('i').hidden = d !== today;
  });
  moveLens($('#days'));
  const v = Object.entries(VERSIONS).map(([l, v]) => v[S.day] ? v[S.day] : null).filter(Boolean);
  $('#versions').textContent = v.join(' · ') || '—';
  $('#dayWarn').hidden = S.day === today || S.clock.mode !== 'live';
}

function moveLens(seg){
  const on = seg.querySelector('button.on'), lens = seg.querySelector('.lens');
  if(!on || !lens) return;
  lens.style.width = on.offsetWidth + 'px';
  lens.style.transform = `translateX(${on.offsetLeft - 4}px)`;
}

function counts(){
  const c = { EW: { run: 0, svc: 0 }, NS: { run: 0, svc: 0 } };
  for(const { line, st } of S.statusCache.values()){
    if(!st) continue;
    if(st.kind === 'moving' || st.kind === 'layover') c[line].run++;
    if(st.kind === 'moving' && !st.off) c[line].svc++;
  }
  return c;
}

function updateUi(T){
  // clock
  $('#clockTime').textContent = hms(T);
  const live = S.clock.mode === 'live';
  $('#clockMode').textContent = live ? 'LIVE · SGT' : (S.clock.playing ? `REPLAY ×${S.clock.speed}` : 'PAUSED');
  $('#clock').classList.toggle('live', live);
  const sl = $('#scrub');
  if(document.activeElement !== sl) sl.value = Math.min(DAY_END, Math.max(DAY_START, T));
  $('#scrubFill').style.width = ((Math.min(DAY_END, Math.max(DAY_START, T)) - DAY_START) / (DAY_END - DAY_START) * 100) + '%';
  $('#dayWarn').hidden = S.day === sgNow().day || !live;

  // network stats
  const c = counts();
  for(const l of ['EW', 'NS']){
    const has = !!S.data[l];
    const exists = !!VERSIONS[l][S.day];
    $(`#st-${l} b`).textContent = has ? c[l].run : '–';
    $(`#st-${l} small`).textContent = has ? `${c[l].svc} in service` : exists ? 'loading…' : 'no timetable';
  }
  if(S.sel) renderCard(T); else renderList(T);
}

function renderList(T){
  const key = 'list:' + S.day + ':' + Math.floor(T / 5) + ':' + Object.keys(S.data).join(',') + ':' + S.statusCache.size;
  if(S.cardKey === key) return;
  S.cardKey = key;
  const groups = { EW: [], NS: [] };
  for(const [id, { line, st }] of S.statusCache){
    if(!st || (st.kind !== 'moving' && st.kind !== 'layover')) continue;
    groups[line].push({ id, st });
  }
  const chip = ({ id, st }, line) => {
    const to = st.kind === 'moving' ? st.next.code : 'wait';
    return `<button class="tchip ${st.kind === 'moving' && st.off ? 'off' : ''} ${st.kind === 'layover' ? 'idle' : ''}" data-id="${esc(id)}" style="--c:${LINE_COLORS[line].cssGlow}">
      <b>${esc(id)}</b><small>${st.kind === 'moving' ? DIR_NAMES[st.trip.dir][0] + ' → ' + esc(to) : 'at ' + esc(st.at.code)}</small></button>`;
  };
  const any = groups.EW.length + groups.NS.length;
  $('#card').innerHTML = `
    <div class="hint">${any ? 'Tap a train on the map, or pick one below.' : 'No trains are running at this time. Scrub the timeline or press play.'}</div>
    ${['EW', 'NS'].filter(l => groups[l].length).map(l => `
      <div class="grp"><div class="grp-h"><span class="pill" style="--c:${LINE_COLORS[l].css}">${LINE_SHORT[l]}</span> running now · ${groups[l].length}</div>
      <div class="chips">${groups[l].sort((a, b) => a.id - b.id).map(x => chip(x, l)).join('')}</div></div>`).join('')}`;
}

function routePoints(line, st){
  if(!st || st.kind !== 'moving') return null;
  const rows = st.trip.rows, pts = [];
  const start = scene.poseBetween(line, st.prev, st.next, Math.min(st.frac, .999));
  if(start) pts.push(start.pos);
  for(let i = st.nextIdx; i < rows.length - 1; i++){
    for(let f = 0; f < 1; f += .25){ const p = scene.poseBetween(line, rows[i], rows[i + 1], f); if(p) pts.push(p.pos); }
  }
  const end = scene.rowPoint(line, rows[rows.length - 1]); if(end) pts.push(end);
  return pts;
}

function renderCard(T){
  const { line, id } = S.sel;
  const d = S.data[line];
  const cached = S.statusCache.get(id);
  const st = cached ? cached.st : null;
  const rec = d && d.ds.trains[id];
  const col = LINE_COLORS[line];

  // route glow follows the current trip
  const rk = st && st.kind === 'moving' ? `${st.tripIdx}:${st.nextIdx}` : 'none';
  if(rk !== S.routeKey){ S.routeKey = rk; scene.setRoute(routePoints(line, st)); }

  const key = `card:${id}:${S.tab}:${st ? st.kind + st.tripIdx + ':' + (st.nextIdx ?? '') + (st.off ? 'o' : '') : 'x'}:${S.day}`;
  if(S.cardKey !== key){
    S.cardKey = key;
    const dir = st && st.trip ? DIR_NAMES[st.trip.dir] : '';
    const tabs = ['stops', 'day', 'depot'];
    $('#card').innerHTML = `
      <div class="c-head">
        <div class="c-num" style="--c:${col.cssGlow}">${esc(id)}</div>
        <div class="c-meta">
          <span class="pill" style="--c:${col.css}">${LINE_SHORT[line]}</span>
          ${dir ? `<span class="pill ghost">${dir}</span>` : ''}
          <div class="c-state" id="cState"></div>
        </div>
        <button class="gbtn icon" id="cClose" aria-label="Close">✕</button>
      </div>
      <div class="c-where" id="cWhere"></div>
      <div class="c-next" id="cNext"></div>
      <div class="c-prog" id="cProg"><div class="bar"><i></i><em></em></div><div class="ends"><span></span><span></span></div></div>
      <div class="c-actions">
        <button class="gbtn" id="cFollow">${scene.follow ? '◉ Following' : '○ Follow'}</button>
        <button class="gbtn" id="cOverview">Overview</button>
        <button class="gbtn" id="cFocus">${scene.focusOnly ? 'Show all trains' : 'Only this train'}</button>
      </div>
      <div class="seg small" id="cTabs"><span class="lens"></span>${tabs.map(t => `<button class="${t === S.tab ? 'on' : ''}" data-tab="${t}">${{ stops: 'Stops', day: 'Day plan', depot: 'Depot' }[t]}</button>`).join('')}</div>
      <div class="c-body" id="cBody">${tabBody(line, id, st, rec, T)}</div>`;
    requestAnimationFrame(() => moveLens($('#cTabs')));
  }
  // live bits
  const where = st ? st.text : 'No running times for this train';
  $('#cWhere').textContent = where;
  let state = 'Not running', cls = 'idle';
  if(st && st.kind === 'moving'){ state = st.off ? 'Not in passenger service' : 'In passenger service'; cls = st.off ? 'off' : 'svc'; }
  else if(st && st.kind === 'layover'){ state = 'Waiting to depart'; cls = 'idle'; }
  const cs = $('#cState'); cs.textContent = state; cs.className = 'c-state ' + cls;
  const next = $('#cNext');
  if(st && st.kind === 'moving'){
    const n = st.next, dest = st.trip.rows[st.trip.rows.length - 1];
    next.innerHTML = `<div><label>Next</label><strong>${esc(n.name)}</strong><span>${n.est ? '~' : ''}${hms(n.t)}</span></div>
      <div class="cd"><label>Arrives in</label><strong>${inText(n.t - T)}</strong><span>to ${esc(dest.name)} ${hms(dest.t, false)}</span></div>`;
  } else if(st){
    next.innerHTML = `<div class="wide"><label>${st.kind === 'layover' ? 'Next departure' : st.kind === 'before' ? 'Launch' : 'Done for the day'}</label><strong>${esc(st.sub)}</strong></div>`;
  } else next.innerHTML = '';
  const prog = $('#cProg');
  if(st && st.trip){
    const rows = st.trip.rows, span = st.trip.end - st.trip.start;
    const pct = st.kind === 'moving' ? Math.min(100, Math.max(0, (T - st.trip.start) / span * 100)) : st.kind === 'after' ? 100 : 0;
    prog.hidden = false;
    prog.querySelector('i').style.width = pct + '%';
    prog.querySelector('em').style.left = pct + '%';
    prog.style.setProperty('--c', st.kind === 'moving' && st.off ? '#ffb100' : col.cssGlow);
    const e = prog.querySelectorAll('.ends span');
    e[0].textContent = `${rows[0].name} ${hms(st.trip.start, false)}`; e[1].textContent = `${rows[rows.length - 1].name} ${hms(st.trip.end, false)}`;
  } else prog.hidden = true;
  $('#cFollow').textContent = scene.follow ? '◉ Following' : '○ Follow';
  if(S.tab === 'stops' && st && st.trip){
    $('#cBody').querySelectorAll('tr[data-t]').forEach(tr => tr.classList.toggle('past', +tr.dataset.t < T && !tr.classList.contains('here')));
  }
}

function stopsTable(trip, st, T, fold = false){
  // Fold stops already passed behind a toggle so the current position is on screen.
  const cut = fold && st && st.kind === 'moving' && st.trip === trip ? Math.max(0, st.nextIdx - 1) : 0;
  const more = cut > 0 ? `<button class="gbtn earlier" data-earlier>Show ${cut} earlier stop${cut === 1 ? '' : 's'}</button>` : '';
  return more + `<table class="stops ${cut ? 'folded' : ''}">${trip.rows.map((r, i) => {
    const here = st && st.kind === 'moving' && st.trip === trip && i === st.nextIdx;
    const note = r.kind === 'depot' ? 'depot' : r.est ? 'est.' : (r.label || '');
    return `<tr data-t="${r.t}" class="${r.est ? 'est' : ''} ${here ? 'here' : ''} ${r.off ? 'off' : ''} ${r.t < T && !here ? 'past' : ''} ${i < cut ? 'early' : ''}">
      <td class="t">${r.est ? '~' : ''}${hms(r.t)}</td><td class="dot"><i></i></td><td class="nm">${esc(r.name)} <small>${esc(note)}</small></td></tr>`;
  }).join('')}</table>`;
}

function tabBody(line, id, st, rec, T){
  const trips = S.data[line] && S.data[line].plans[id];
  if(S.tab === 'stops'){
    if(!st || !st.trip) return '<p class="muted">No running times for this train in this timetable.</p>';
    return stopsTable(st.trip, st, T, true);
  }
  if(S.tab === 'day'){
    if(!trips) return '<p class="muted">No trips.</p>';
    return `<div class="trips">${trips.map((tr, i) => `
      <details class="trip ${st && i === st.tripIdx ? 'cur' : ''}" ${st && i === st.tripIdx ? 'open' : ''}>
        <summary><b>${tr.dir}</b><span class="tm">${hms(tr.start, false)}–${hms(tr.end, false)}</span><span class="rt">${esc(tr.rows[0].name)} → ${esc(tr.rows[tr.rows.length - 1].name)}</span>${tr.off ? '<em>off-service</em>' : ''}</summary>
        ${stopsTable(tr, st, T)}
      </details>`).join('')}</div>`;
  }
  // depot
  if(!rec) return '<p class="muted">No launch/withdraw entry.</p>';
  const cell = (label, r) => {
    if(!r) return '';
    const tt = tableTime(r.time);
    return `<div class="dep"><label>${label}</label><strong class="${line === 'EW' && r.depot === 'ECID' ? 'ecid' : ''}">${esc(r.depot)}</strong>
      <span>${esc(r.point)}</span><span class="tm">${tt.time}${tt.nextDay ? ' <small>+1 day</small>' : ''}</span></div>`;
  };
  const W = rec.withdraw, ecid = line === 'EW' && W && W.depot === 'ECID';
  return `<div class="deps">${cell('Launch', rec.launch)}${cell('Withdraw', rec.withdraw)}</div>
    ${line === 'EW' && W ? `<div class="verdict ${ecid ? 'job' : ''}"><i></i>${ecid ? `Withdraws to ECID at ${tableTime(W.time).time} — your job.` : `Withdraws to ${esc(W.depot)} — not ECID.`}</div>` : ''}`;
}

// ---------- dock / time machine ----------
function syncDock(){
  const c = S.clock;
  $('#play').textContent = c.mode === 'sim' && c.playing ? '❚❚' : '▶';
  $('#play').setAttribute('aria-label', c.mode === 'sim' && c.playing ? 'Pause' : 'Play');
  $('#liveBtn').classList.toggle('on', c.mode === 'live');
  document.querySelectorAll('#speeds button').forEach(b => b.classList.toggle('on', +b.dataset.s === c.speed));
  moveLens($('#speeds'));
}

// ---------- events ----------
$('#days').addEventListener('click', e => { const b = e.target.closest('button'); if(b) loadDay(b.dataset.day); });
$('#search').addEventListener('submit', async e => {
  e.preventDefault();
  const v = $('#q').value.trim().replace(/^0+/, '');
  if(!v) return;
  if(S.loading){ toast('Loading timetable…'); try{ await S.loading; }catch(err){} }   // don't say "no train" mid-load
  selectTrain(v);
});
$('#q').addEventListener('input', e => { e.target.value = e.target.value.replace(/[^0-9]/g, '').slice(0, 3); });
$('#card').addEventListener('click', e => {
  const chip = e.target.closest('.tchip'); if(chip){ selectTrain(chip.dataset.id); return; }
  if(e.target.closest('#cClose')){ clearSelection(); scene.overview(); return; }
  if(e.target.closest('#cFollow')){ scene.follow = !scene.follow; if(scene.follow && S.sel) scene.select(S.sel.id); S.cardKey = ''; return; }
  if(e.target.closest('#cOverview')){ scene.overview(); S.cardKey = ''; return; }
  if(e.target.closest('#cFocus')){ scene.focusOnly = !scene.focusOnly; S.cardKey = ''; S.force = true; try{ localStorage.setItem('lookup.focus', scene.focusOnly ? '1' : '0'); }catch(err){} return; }
  if(e.target.closest('[data-earlier]')){ e.target.remove(); $('#cBody .stops').classList.remove('folded'); return; }
  const tab = e.target.closest('#cTabs button'); if(tab){ S.tab = tab.dataset.tab; S.cardKey = ''; updateUi(nowT()); }
});
$('#play').addEventListener('click', () => {
  const c = S.clock;
  if(c.mode === 'live') setSim(nowT(), true);
  else setSim(nowT(), !c.playing);
});
$('#liveBtn').addEventListener('click', () => { goLive(); if(S.day !== sgNow().day) loadDay(sgNow().day); });
$('#speeds').addEventListener('click', e => {
  const b = e.target.closest('button'); if(!b) return;
  const t = nowT(); S.clock.speed = +b.dataset.s;
  setSim(t, true);
});
$('#scrub').addEventListener('input', e => setSim(+e.target.value, S.clock.mode === 'sim' && S.clock.playing));
document.querySelectorAll('.lines button').forEach(b => b.addEventListener('click', () => {
  const l = b.dataset.line, on = !b.classList.contains('on');
  b.classList.toggle('on', on); scene.setLineVisible(l, on); S.force = true;
}));
$('#overviewBtn').addEventListener('click', () => scene.overview());
$('#homeBtn').addEventListener('click', () => scene.overview());
$('#viewBtn').addEventListener('click', () => {
  const top = !scene.top; scene.setTopView(top);
  $('#viewBtn').textContent = top ? '3D' : '2D';
  $('#viewBtn').setAttribute('aria-label', top ? 'Switch to 3D view' : 'Switch to 2D map');
  try{ localStorage.setItem('lookup.view', top ? '2d' : '3d'); }catch(e){}
});
try{ if(localStorage.getItem('lookup.view') === '2d'){ scene.setTopView(true); scene.overview(); $('#viewBtn').textContent = '3D'; } }catch(e){}

// bottom sheet (mobile)
// Bottom sheet (phones) has three heights: 'peek', 'half', 'full'.
let sheetState = 'peek';
function setSheet(open){ setSheetState(open === true ? 'half' : open === false ? 'peek' : open); }
function setSheetState(st){
  sheetState = st;
  document.body.classList.toggle('sheet-open', st !== 'peek');
  document.body.classList.toggle('sheet-full', st === 'full');
  setTimeout(updateInsets, 600);
}
// Tell the 3D view how much of the screen the glass panels cover.
function updateInsets(){
  const W = innerWidth, H = innerHeight;
  if(W > 860){
    const sheet = $('#sheet').getBoundingClientRect(), top = $('.topbar').getBoundingClientRect();
    scene.setInsets({ right: W - sheet.left, left: 0, top: top.bottom, bottom: 90 });
  } else {
    const sheet = $('#sheet').getBoundingClientRect(), net = $('.net').getBoundingClientRect();
    scene.setInsets({ top: net.bottom, bottom: H - sheet.top + 70, left: 0, right: 0 });
  }
}
addEventListener('resize', updateInsets);
// Drag the sheet with the finger; snap to the nearest height on release (a flick picks the next one).
{
  const grab = $('#grab'), sheet = $('#sheet');
  let drag = null;
  const heights = () => ({ peek: 196, half: Math.min(innerHeight * .6, 560), full: innerHeight - 24 - (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--safe-t')) || 0) - 60 });
  grab.addEventListener('pointerdown', e => {
    if(innerWidth > 860) return;
    grab.setPointerCapture(e.pointerId);
    drag = { y: e.clientY, h: sheet.getBoundingClientRect().height, t: performance.now(), moved: false, lastY: e.clientY, lastT: performance.now(), v: 0 };
    sheet.style.transition = 'none';
  });
  grab.addEventListener('pointermove', e => {
    if(!drag) return;
    const dy = e.clientY - drag.y;
    if(Math.abs(dy) > 4) drag.moved = true;
    const now = performance.now();
    drag.v = (e.clientY - drag.lastY) / Math.max(1, now - drag.lastT); drag.lastY = e.clientY; drag.lastT = now;
    const H = heights();
    sheet.style.height = Math.max(120, Math.min(H.full, drag.h - dy)) + 'px';
  });
  const end = e => {
    if(!drag) return;
    const d = drag; drag = null;
    const cur = sheet.getBoundingClientRect().height;
    sheet.style.transition = ''; sheet.style.height = '';
    if(!d.moved){ setSheetState(sheetState === 'peek' ? 'half' : 'peek'); return; }   // tap toggles
    const H = heights(), order = ['peek', 'half', 'full'];
    let target = order.reduce((a, b) => Math.abs(H[b] - cur) < Math.abs(H[a] - cur) ? b : a);
    if(target === sheetState && Math.abs(d.v) > .5){            // short flick: one step in that direction
      const i = order.indexOf(sheetState);
      target = order[Math.max(0, Math.min(2, i + (d.v < 0 ? 1 : -1)))];
    }
    setSheetState(target);
  };
  grab.addEventListener('pointerup', end);
  grab.addEventListener('pointercancel', end);
}

// specular highlight that follows the pointer: only the glass panel under it, at most once per frame
{
  let q = null;
  addEventListener('pointermove', e => {
    if(e.pointerType !== 'mouse') return;
    const first = !q; q = { x: e.clientX, y: e.clientY, t: e.target };
    if(!first) return;
    requestAnimationFrame(() => {
      const { x, y, t } = q; q = null;
      const g = t && t.closest && t.closest('.glass');
      if(!g) return;
      const r = g.getBoundingClientRect();
      g.style.setProperty('--mx', (x - r.left) + 'px');
      g.style.setProperty('--my', (y - r.top) + 'px');
    });
  }, { passive: true });
}
addEventListener('resize', () => { document.querySelectorAll('.seg').forEach(moveLens); });

let toastT;
function toast(msg){
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2800);
}

// ---------- lock ----------
async function boot(){
  document.body.classList.remove('locked', 'booting');
  await loadDay(sgNow().day);
  syncDock();
  updateInsets();
  const hash = location.hash.match(/train=(\d+)/);
  if(hash) selectTrain(hash[1]);
}
$('#lockForm').addEventListener('submit', async e => {
  e.preventDefault();
  const msg = $('#lockMsg'), btn = $('#unlockBtn');
  msg.className = ''; msg.textContent = 'Unlocking…'; btn.disabled = true;
  try{
    if(await unlockWith($('#lockPass').value)){ msg.textContent = ''; $('#lockPass').value = ''; boot(); }
    else { msg.className = 'err'; msg.textContent = 'Wrong password.'; $('#lockCard').classList.remove('shake'); void $('#lockCard').offsetWidth; $('#lockCard').classList.add('shake'); }
  }catch(err){ msg.className = 'err'; msg.textContent = navigator.onLine ? 'Could not unlock on this browser.' : 'You are offline — connect once to unlock.'; }
  finally{ btn.disabled = false; }
});
$('#lockBtn').addEventListener('click', () => { forgetKey(); location.reload(); });
renderDays(); syncDock();
restoreKey().then(ok => { if(ok) boot(); else { document.body.classList.remove('booting'); document.body.classList.add('locked'); $('#lockPass').focus(); } })
  .catch(() => { document.body.classList.remove('booting'); document.body.classList.add('locked'); $('#lockMsg').className = 'err'; $('#lockMsg').textContent = 'Could not load the site data. Check your connection and reload.'; });

if('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
