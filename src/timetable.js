// Timetable model: encrypted data loading, trip expansion, and "where is train X at time T".
// Ported from the classic page (classic.html), which has the same behaviour.

export const VERSIONS = {
  EW: { weekday: 'EWWD081', saturday: 'EWSA049', sunday: 'EWSU043' },
  NS: { weekday: 'NSWD074', saturday: 'NSSA048', sunday: 'NSSU039' },
};
export const LINE_NAMES = { EW: 'East-West Line', NS: 'North-South Line' };
export const DIR_NAMES = { E: 'Eastbound', W: 'Westbound', N: 'Northbound', S: 'Southbound' };
export const DEPOTS = { ECID: 'East Coast Integrated Depot', TWD: 'Tuas West Depot', UPD: 'Ulu Pandan Depot', BSD: 'Bishan Depot' };

// Stations in line order with rough distance (km) from the previous one. Only used to
// estimate times at stations the OCC report doesn't list; timing-point times are exact.
export const LINES = {
  EW: {
    main: [['TLK','Tuas Link',0],['TWR','Tuas West Road',1.1],['TCR','Tuas Crescent',1.3],['GCL','Gul Circle',1.5],
      ['JKN','Joo Koon',2.2],['PNR','Pioneer',2.0],['BNL','Boon Lay',1.2],['LKS','Lakeside',1.6],['CNG','Chinese Garden',1.3],
      ['JUR','Jurong East',1.3],['CLE','Clementi',2.6],['DVR','Dover',1.7],['BNV','Buona Vista',1.7],['COM','Commonwealth',1.1],
      ['QUE','Queenstown',0.9],['RDH','Redhill',1.6],['TIB','Tiong Bahru',1.2],['OTP','Outram Park',1.3],['TPG','Tanjong Pagar',0.9],
      ['RFP','Raffles Place',1.1],['CTH','City Hall',0.9],['BGS','Bugis',1.0],['LVR','Lavender',0.8],['KAL','Kallang',1.0],
      ['ALJ','Aljunied',1.3],['PYL','Paya Lebar',1.1],['EUN','Eunos',1.1],['KEM','Kembangan',1.1],['BDK','Bedok',1.5],
      ['TNM','Tanah Merah',1.8],['SIM','Simei',2.0],['TAM','Tampines',1.5],['PSR','Pasir Ris',2.4]],
    branch: { from: 'TNM', stations: [['XPO','Expo',3.5],['CGA','Changi Airport',2.4]] },
  },
  NS: {
    main: [['JUR','Jurong East',0],['BBT','Bukit Batok',2.2],['BGB','Bukit Gombak',1.4],['CCK','Choa Chu Kang',2.0],
      ['YWT','Yew Tee',1.4],['KRJ','Kranji',3.4],['MSL','Marsiling',2.4],['WDL','Woodlands',1.4],['ADM','Admiralty',1.4],
      ['SBW','Sembawang',1.5],['CBR','Canberra',1.8],['YIS','Yishun',1.7],['KTB','Khatib',3.6],['YCK','Yio Chu Kang',4.0],
      ['AMK','Ang Mo Kio',1.1],['BSH','Bishan',2.4],['BDL','Braddell',1.6],['TAP','Toa Payoh',1.0],['NOV','Novena',1.4],
      ['NEW','Newton',1.3],['ORC','Orchard',1.1],['SOM','Somerset',0.9],['DBG','Dhoby Ghaut',0.9],['CTH','City Hall',1.0],
      ['RFP','Raffles Place',1.1],['MRB','Marina Bay',0.9],['MSP','Marina South Pier',1.4]],
  },
};

// station -> {name, km, branch?, idx}
export const GEO = {};
for(const [line, def] of Object.entries(LINES)){
  const g = GEO[line] = {};
  let km = 0;
  def.main.forEach(([c, n, d], i) => { km += d; g[c] = { code: c, name: n, km, idx: i }; });
  if(def.branch){
    let bk = 0;
    def.branch.stations.forEach(([c, n, d], i) => { bk += d; g[c] = { code: c, name: n, bkm: bk, branch: true, idx: i }; });
  }
}

// "TLK A" -> station TLK; "ECID-TB3A" -> depot; "JKN S" / "PSR S A" -> siding near a station.
export function locate(line, label){
  const dep = label.match(/^(ECID|TWD|UPD|BSD)\b/);
  if(dep) return { kind: 'depot', code: dep[1], name: DEPOTS[dep[1]], label };
  const code = label.split(/[\s-]/)[0];
  const st = GEO[line][code];
  if(!st) return { kind: 'other', code, name: label, label };
  const siding = /\sS(\s|$)/.test(label) || (/^TNM B/.test(label) && line === 'EW');
  return { kind: siding ? 'siding' : 'station', code, name: st.name + (siding ? ' siding' : ''), label };
}

// Stations strictly between two stations, in travel order, with fraction of the distance from a.
export function between(line, a, b){
  const g = GEO[line], def = LINES[line];
  const pathMain = (x, y) => {
    if(x === y) return [];
    const i = g[x].idx, j = g[y].idx, step = i < j ? 1 : -1, out = [];
    for(let k = i + step; k !== j; k += step){ out.push(def.main[k][0]); }
    return out;
  };
  const pathBranch = (x, y) => {
    if(x === y) return [];
    const seq = [def.branch.from, ...def.branch.stations.map(s => s[0])];
    const i = seq.indexOf(x), j = seq.indexOf(y), step = i < j ? 1 : -1, out = [];
    for(let k = i + step; k !== j; k += step){ out.push(seq[k]); }
    return out;
  };
  const onBranch = c => g[c] && g[c].branch;
  if(!g[a] || !g[b] || a === b) return [];
  let seq;
  if(!onBranch(a) && !onBranch(b)) seq = pathMain(a, b);
  else if(onBranch(a) && onBranch(b)) seq = pathBranch(a, b);
  else {
    const j = def.branch.from, mid = (a === j || b === j) ? [] : [j];
    seq = onBranch(a) ? [...pathBranch(a, j), ...mid, ...pathMain(j, b)] : [...pathMain(a, j), ...mid, ...pathBranch(j, b)];
  }
  const pos = c => g[c].branch ? g[def.branch.from].km + g[c].bkm : g[c].km;
  const dist = (x, y) => (onBranch(x) !== onBranch(y) && !(x === def.branch.from || y === def.branch.from))
    ? Math.abs(pos(x) - g[def.branch.from].km) + Math.abs(pos(y) - g[def.branch.from].km)
    : Math.abs(pos(x) - pos(y));
  const total = dist(a, b);
  let prev = a, acc = 0;
  return seq.map(c => { acc += dist(prev, c); prev = c; return { code: c, frac: total ? acc / total : 0 }; });
}

// Expand one trip's timing points into every station, estimating the ones in between.
export function expandTrip(line, trip){
  const [, dir, pts] = trip, rows = [];
  pts.forEach(([label, t, off], i) => {
    const loc = locate(line, label);
    if(i > 0){
      const [pl, pt] = pts[i - 1];
      const a = locate(line, pl);
      if(a.kind !== 'depot' && loc.kind !== 'depot' && a.kind !== 'other' && loc.kind !== 'other'){
        for(const s of between(line, a.code, loc.code)){
          rows.push({ code: s.code, name: GEO[line][s.code].name, kind: 'station', t: Math.round(pt + (t - pt) * s.frac), est: true, off: !!off });
        }
      }
    }
    const last = rows[rows.length - 1];
    if(last && last.code === loc.code && loc.kind === last.kind && !last.est){ last.t2 = t; last.label += ' / ' + label; return; }
    rows.push({ code: loc.code, name: loc.name, kind: loc.kind, label, t, est: false, off: !!off });
  });
  return { dir, rows, start: rows[0].t, end: rows[rows.length - 1].t, off: pts.every(p => p[2]) };
}

export function buildPlans(line, ds){
  const plans = {};
  for(const trip of ds.trips){
    try{ (plans[trip[0]] = plans[trip[0]] || []).push(expandTrip(line, trip)); }
    catch(e){ console.warn('Skipped trip', trip, e); }
  }
  Object.values(plans).forEach(p => p.sort((a, b) => a.start - b.start));
  return plans;
}

// ---------- time (always Singapore) ----------
const SGT = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Singapore', weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
export const SERVICE_START = 4 * 3600;            // service day runs 04:00 -> 04:00 next day
export function sgNow(){
  const now = new Date();
  const p = Object.fromEntries(SGT.formatToParts(now).map(x => [x.type, x.value]));
  let sec = +p.hour * 3600 + +p.minute * 60 + +p.second + now.getMilliseconds() / 1000;
  let wd = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(p.weekday);
  if(sec < SERVICE_START){ sec += 86400; wd = (wd + 6) % 7; }
  return { sec, day: wd === 0 ? 'sunday' : wd === 6 ? 'saturday' : 'weekday' };
}
export function hms(sec, withSec = true){
  sec = Math.floor(sec);
  const s = ((sec % 86400) + 86400) % 86400;
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + (withSec ? ':' + String(x).padStart(2, '0') : '');
}
export function inText(d){
  d = Math.max(0, Math.round(d));
  if(d < 60) return `${d}s`;
  const m = Math.floor(d / 60), s = d % 60;
  if(m < 60) return s && m < 10 ? `${m}m ${s}s` : `${m} min`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
export function esc(s){ return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
export function tableTime(t){             // "1.00:21:01" -> "00:21:01 +1"
  const m = String(t).match(/^1\.(\d{1,2}:\d{2}:\d{2})$/);
  return m ? { time: m[1], nextDay: true } : { time: t, nextDay: false };
}

// ---------- where is a train at time T ----------
export function status(trips, T){
  if(!trips || !trips.length) return null;
  const first = trips[0], last = trips[trips.length - 1];
  if(T < first.start){
    const r0 = first.rows[0];
    return { kind: 'before', at: r0, text: r0.kind === 'depot' ? `In ${r0.code} depot` : `Stabled at ${r0.name}`,
      sub: `Launches ${hms(first.start)} · in ${inText(first.start - T)}`, trip: first, tripIdx: 0 };
  }
  if(T > last.end){
    const rl = last.rows[last.rows.length - 1];
    return { kind: 'after', at: rl, text: rl.kind === 'depot' ? `Withdrawn to ${rl.code}` : `Stabled at ${rl.name}`,
      sub: `Arrived ${hms(last.end)}`, trip: last, tripIdx: trips.length - 1 };
  }
  for(let i = 0; i < trips.length; i++){
    const tr = trips[i];
    if(T >= tr.start && T <= tr.end){
      const rows = tr.rows;
      let k = rows.findIndex(r => r.t > T);
      if(k === -1) k = rows.length - 1;
      const next = rows[k], prev = rows[Math.max(0, k - 1)];
      const dwell = next.t - T <= 30 || (prev.t2 && T <= prev.t2);
      let text, pos, frac = 0;
      if(k === 0 || prev === next){ text = `At ${next.name}`; pos = 0; }
      else if(dwell){ text = `At ${next.name}`; pos = k; frac = 1; }
      else { frac = (T - prev.t) / (next.t - prev.t); text = `Between ${prev.name} and ${next.name}`; pos = k - 1 + frac; }
      return { kind: 'moving', text, trip: tr, tripIdx: i, prev, next, frac, nextIdx: k, pos, off: next.off, est: next.est || prev.est };
    }
    const nx = trips[i + 1];
    if(nx && T > tr.end && T < nx.start){
      const at = tr.rows[tr.rows.length - 1];
      return { kind: 'layover', at, text: at.kind === 'depot' ? `In ${at.code} depot` : `At ${at.name}`,
        sub: `${DIR_NAMES[nx.dir]} from ${nx.rows[0].name} at ${hms(nx.start)} · in ${inText(nx.start - T)}`,
        trip: nx, tripIdx: i + 1, waiting: true };
    }
  }
  return null;
}

// ---------- encrypted data ----------
const KEY_STORE = 'lookup.key.v1';        // shared with classic.html
let aesKey = null, meta = null;
const cache = {};
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const b64 = u8 => btoa(String.fromCharCode(...u8));

async function getMeta(){
  if(!meta){ const r = await fetch('data/meta.json', { cache: 'no-cache' }); if(!r.ok) throw new Error('meta ' + r.status); meta = await r.json(); }
  return meta;
}
async function tryKey(key){
  const m = await getMeta();
  try{
    const ok = new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(m.check.iv) }, key, unb64(m.check.ct)));
    return ok === 'looktrain-ok';
  }catch(e){ return false; }
}
export async function unlockWith(pass){
  const m = await getMeta();
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: unb64(m.salt), iterations: m.iter, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, true, ['decrypt']);
  if(!(await tryKey(key))) return false;
  aesKey = key;
  try{ localStorage.setItem(KEY_STORE, JSON.stringify({ salt: m.salt, k: b64(new Uint8Array(await crypto.subtle.exportKey('raw', key))) })); }catch(e){}
  return true;
}
export async function restoreKey(){
  let saved = null;
  try{ saved = JSON.parse(localStorage.getItem(KEY_STORE)); }catch(e){}
  if(!saved) return false;
  const m = await getMeta();
  if(saved.salt !== m.salt) return false;
  const key = await crypto.subtle.importKey('raw', unb64(saved.k), { name: 'AES-GCM' }, false, ['decrypt']);
  if(!(await tryKey(key))) return false;
  aesKey = key;
  return true;
}
export function forgetKey(){ try{ localStorage.removeItem(KEY_STORE); }catch(e){} aesKey = null; }

export async function loadVersion(v){
  if(!cache[v]){
    cache[v] = (async () => {
      const r = await fetch(`data/${v}.enc`);
      if(!r.ok) throw new Error(r.status);
      const box = await r.json();
      const gz = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, aesKey, unb64(box.ct)));
      const text = await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
      return JSON.parse(text);
    })();
    cache[v].catch(() => { delete cache[v]; });
  }
  return cache[v];
}
