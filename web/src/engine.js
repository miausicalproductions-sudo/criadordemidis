'use strict';
/* ===== Motor: teoria, análise de MIDIs, geração, humanização, exportação ===== */
const PGM = (() => {
const NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const FLAT = {Db:'C#',Eb:'D#',Gb:'F#',Ab:'G#',Bb:'A#'};
const QUAL = {'':[0,4,7], m:[0,3,7], '7':[0,4,7,10], maj7:[0,4,7,11], m7:[0,3,7,10], sus4:[0,5,7], sus2:[0,2,7]};
const ALIAS = {min:'m', min7:'m7', M7:'maj7'};
const MAJOR = [0,2,4,5,7,9,11], MINOR = [0,2,3,5,7,8,10];
const PPQ = 480, TPS = PPQ / 4;           // TPS = ticks por semicolcheia (step)

function pcOf(n){ n = FLAT[n] || n; const i = NAMES.indexOf(n); if (i < 0) throw new Error('Nota inválida: ' + n); return i; }
function parseChord(s){
  const m = /^([A-G][#b]?)(maj7|min7|m7|M7|min|m|7|sus4|sus2|)$/.exec(s.trim());
  if (!m) throw new Error('Acorde inválido: "' + s + '"');
  return [pcOf(m[1]), ALIAS[m[2]] ?? m[2]];
}
function chordPcs(root, q){ return QUAL[q].map(i => (root + i) % 12); }
function chordName(root, q){ return NAMES[root] + q; }
function parseKey(s){
  s = s.trim(); const minor = s.endsWith('m') && !s.endsWith('maj');
  return [pcOf(minor ? s.slice(0, -1) : s), minor ? 'minor' : 'major'];
}
function scalePcs(key){ const set = new Set(); for (const i of (key[1] === 'minor' ? MINOR : MAJOR)) set.add((key[0] + i) % 12); return set; }

/* ---------- RNG determinístico ---------- */
function makeRng(seed){
  let a = seed >>> 0;
  const r = () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  r.uniform = (x, y) => x + (y - x) * r();
  r.gauss = (m, s) => { let u = 0; while (!u) u = r(); const v = r(); return m + s * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  r.choice = arr => arr[Math.floor(r() * arr.length)];
  return r;
}

/* ---------- Leitura de MIDI ---------- */
function parseMidi(buf){
  const d = buf instanceof Uint8Array ? buf : new Uint8Array(buf); let p = 0;
  const u32 = () => { const v = (d[p] << 24 | d[p+1] << 16 | d[p+2] << 8 | d[p+3]) >>> 0; p += 4; return v; };
  const u16 = () => { const v = d[p] << 8 | d[p+1]; p += 2; return v; };
  if (d.length < 14 || String.fromCharCode(d[0], d[1], d[2], d[3]) !== 'MThd') throw new Error('Não é um arquivo MIDI.');
  p = 4; const hl = u32(); u16(); const ntr = u16(), div = u16(); p = 8 + hl;
  if (div & 0x8000) throw new Error('MIDI com tempo SMPTE não é suportado.');
  const notes = []; let bpm = null, ts = [4, 4], tempoChanges = 0;
  for (let t = 0; t < ntr; t++){
    if (p + 8 > d.length) break;
    const id = String.fromCharCode(d[p], d[p+1], d[p+2], d[p+3]); p += 4; const len = u32();
    const end = Math.min(p + len, d.length);
    if (id !== 'MTrk'){ p = end; continue; }
    let tick = 0, run = 0; const on = new Map();
    while (p < end){
      let dt = 0, b; do { b = d[p++]; dt = (dt << 7) | (b & 0x7f); } while ((b & 0x80) && p < end); tick += dt;
      const st = d[p];
      if (st === 0xFF){
        p++; const type = d[p++]; let l = 0; do { b = d[p++]; l = (l << 7) | (b & 0x7f); } while (b & 0x80);
        if (type === 0x51 && l === 3){ tempoChanges++; if (bpm === null) bpm = 60000000 / (d[p] << 16 | d[p+1] << 8 | d[p+2]); }
        else if (type === 0x58 && l >= 2) ts = [d[p], 1 << d[p+1]];
        p += l; continue;
      }
      if (st === 0xF0 || st === 0xF7){ p++; let l = 0; do { b = d[p++]; l = (l << 7) | (b & 0x7f); } while (b & 0x80); p += l; continue; }
      if (st & 0x80){ run = st; p++; }
      const hi = run & 0xF0, ch = run & 0x0F;
      if (hi === 0x80 || hi === 0x90 || hi === 0xA0 || hi === 0xB0 || hi === 0xE0){
        const a = d[p++], v = d[p++];
        if (ch === 9) continue;                                   // ignora bateria
        const key = ch * 128 + a;
        if (hi === 0x90 && v > 0){ if (!on.has(key)) on.set(key, []); on.get(key).push([tick, v]); }
        else if (hi === 0x80 || (hi === 0x90 && v === 0)){
          const q = on.get(key); if (q && q.length){ const [s, vel] = q.shift(); notes.push({start: s, end: tick, pitch: a, vel}); }
        }
      } else if (hi === 0xC0 || hi === 0xD0) p++;
      else p++;
    }
    p = end;
  }
  notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  return {notes, ppq: div, bpm: bpm ?? 120, ts, tempoChanges};
}

/* ---------- Análise ---------- */
function cleanNotes(notes, ppq){
  const out = [], seen = new Set();
  for (const n of notes){
    const d = (n.end - n.start) / ppq; if (d < 1/16) continue;
    const k = n.start + ':' + n.pitch; if (seen.has(k)) continue; seen.add(k);
    out.push({...n, end: n.start + Math.floor(Math.min(d, 8) * ppq)});
  }
  return out;
}
const KK_MAJ = [6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88];
const KK_MIN = [6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17];
function guessKey(notes){
  const w = new Array(12).fill(0); for (const n of notes) w[n.pitch % 12] += n.end - n.start;
  const corr = (a, b) => { const ma = a.reduce((x,y)=>x+y)/12, mb = b.reduce((x,y)=>x+y)/12; let s=0,x=0,y=0;
    for (let i=0;i<12;i++){ s+=(a[i]-ma)*(b[i]-mb); x+=(a[i]-ma)**2; y+=(b[i]-mb)**2; } return s/Math.sqrt(x*y||1); };
  let best = null, bs = -2;
  for (let r = 0; r < 12; r++){
    const rot = i => w[(r + i) % 12];
    const a = Array.from({length: 12}, (_, i) => rot(i));
    const cM = corr(a, KK_MAJ), cm = corr(a, KK_MIN);
    if (cM > bs){ bs = cM; best = NAMES[r]; }
    if (cm > bs){ bs = cm; best = NAMES[r] + 'm'; }
  }
  return best;
}
function detectChords(notes, ppq, bpb = 4){
  const bar = ppq * bpb; let nbars = 0; for (const n of notes) nbars = Math.max(nbars, Math.floor(n.end / bar) + 1);
  const res = []; let prev = null;
  for (let b = 0; b < nbars; b++){
    const lo = b * bar, hi = (b + 1) * bar; const w = new Array(12).fill(0); let tot = 0;
    const inb = notes.filter(n => n.start < hi && n.end > lo);
    if (inb.length < 2){ res.push(prev); continue; }
    for (const n of inb){ const ov = Math.min(n.end, hi) - Math.max(n.start, lo); w[n.pitch % 12] += ov; tot += ov; }
    let low = null; for (const n of inb) if (n.start >= lo && n.start < hi && (!low || n.pitch < low.pitch)) low = n;
    const bass = low ? low.pitch % 12 : null;
    let best = null, bs = -1e18;
    for (let r = 0; r < 12; r++) for (const q of ['', 'm', '7', 'm7']){
      const pcs = new Set(chordPcs(r, q)); let s = 0;
      for (let p = 0; p < 12; p++) s += pcs.has(p) ? w[p] : -0.7 * w[p];
      if (bass === r) s += 0.25 * tot; if (q === '7' || q === 'm7') s -= 0.15 * tot;
      if (s > bs){ bs = s; best = chordName(r, q); }
    }
    res.push(best); prev = best;
  }
  const first = res.find(c => c); return res.map(c => c || first);
}
function analyzeMidi(name, buf){
  const m = parseMidi(buf);
  if (!m.notes.length) throw new Error('Sem notas (parece ser só um mapa de andamento).');
  const notes = cleanNotes(m.notes, m.ppq);
  if (!notes.length) throw new Error('Sem notas utilizáveis depois da limpeza.');
  const step = m.ppq / 4, lowSet = new Set(), highSet = new Set();
  let lastStep = 0; const lowC = new Array(16).fill(0), highC = new Array(16).fill(0), durs = [];
  for (const n of notes){
    const s = Math.round(n.start / step), e = Math.max(s + 1, Math.round(n.end / step)); lastStep = Math.max(lastStep, s); durs.push(e - s);
    const set = n.pitch < 60 ? lowSet : highSet; if (!set.has(s)){ set.add(s); (n.pitch < 60 ? lowC : highC)[s % 16]++; }
  }
  durs.sort((a, b) => a - b);
  const bars = Math.max(1, Math.floor(lastStep / 16) + 1);
  const pitches = notes.map(n => n.pitch);
  return {name, nNotes: notes.length, bars, bpm: Math.round(m.bpm * 10) / 10, ts: m.ts, key: guessKey(notes),
    chords: detectChords(notes, m.ppq, m.ts[0]), low: lowC, high: highC, medianDur: durs[Math.floor(durs.length / 2)],
    range: [Math.min(...pitches), Math.max(...pitches)], tempoChanges: m.tempoChanges};
}
function aggregateProfile(refs){
  if (!refs.length) return null;
  const bars = refs.reduce((s, r) => s + r.bars, 0), low = new Array(16).fill(0), high = new Array(16).fill(0);
  for (const r of refs) for (let i = 0; i < 16; i++){ low[i] += r.low[i]; high[i] += r.high[i]; }
  return {low: low.map(x => x / bars), high: high.map(x => x / bars), bars};
}
function progressionFromChords(chords, nbars = 8){
  const out = []; const c = chords.slice(0, nbars);
  for (const x of c){ if (out.length && out[out.length - 1][0] === x) out[out.length - 1][1] += 4; else out.push([x, 4]); }
  return out.map(([n, b]) => n + ':' + b).join(' ');
}

/* ---------- Geração (grade exata; unidade = semicolcheia) ---------- */
function parseProgression(text, defBeats = 4){
  const segs = []; let pos = 0; const toks = text.trim().split(/\s+/).filter(Boolean);
  if (!toks.length) throw new Error('Escreva ao menos um acorde.');
  for (const tok of toks){
    const [name, b] = tok.split(':'); const beats = b ? parseFloat(b) : defBeats;
    if (!(beats > 0)) throw new Error('Duração inválida em "' + tok + '".');
    const length = Math.max(1, Math.round(beats * 4)); const [root, q] = parseChord(name);
    segs.push({start: pos, length, root, q, name}); pos += length;
  }
  return segs;
}
const segAt = (segs, step) => { for (const s of segs) if (s.start <= step && step < s.start + s.length) return s; return segs[segs.length - 1]; };
const nearest = (pc, around, lo, hi) => { let best = null; for (let p = lo; p <= hi; p++) if (p % 12 === pc && (best === null || Math.abs(p - around) < Math.abs(best - around))) best = p; return best; };
const avg = a => a.reduce((x, y) => x + y, 0) / a.length;

function voiceRh(seg, prev, lo = 57, hi = 76){
  const pcs = chordPcs(seg.root, seg.q), cands = [];
  for (let rot = 0; rot < pcs.length; rot++){
    const order = pcs.slice(rot).concat(pcs.slice(0, rot));
    for (let base = lo; base < lo + 12; base++){
      const notes = []; let cur = base - 1;
      for (const pc of order){ let p = cur + 1; while (p % 12 !== pc) p++; notes.push(p); cur = p; }
      if (notes[0] >= lo && notes[notes.length - 1] <= hi) cands.push(notes);
    }
  }
  if (!cands.length) return pcs.map(pc => nearest(pc, 64, lo, hi));
  if (!prev) return cands.reduce((b, n) => Math.abs(avg(n) - 64) < Math.abs(avg(b) - 64) ? n : b);
  const pm = avg(prev), sc = n => Math.abs(avg(n) - pm) + 0.3 * Math.abs(n[n.length - 1] - prev[prev.length - 1]);
  return cands.reduce((b, n) => sc(n) < sc(b) ? n : b);
}
function lhNotes(seg){ const root = nearest(seg.root, 40, 36, 47); return {root, fifth: root + 7, oct: root + 12}; }

function sampleHits(prob, rng, density, minGap){
  const tot = prob.reduce((a, b) => a + b, 0) || 1; let hits = [];
  for (let i = 0; i < 16; i++){
    const p = density * 16 * prob[i] / tot;
    if (rng() < Math.min(0.95, p) && (!hits.length || i - hits[hits.length - 1] >= minGap)) hits.push(i);
  }
  if (!hits.includes(0)) hits = [0].concat(hits.filter(h => h >= minGap));
  return hits;
}
function mutate(hits, rng){
  const h = new Set(hits), r = rng(); const cands = []; for (let i = 1; i < 16; i++) if (!h.has(i)) cands.push(i);
  if (r < 0.5 && cands.length) h.add(rng.choice(cands));
  else if (h.size > 2) h.delete(rng.choice([...h].filter(x => x !== 0).sort((a, b) => a - b)));
  const out = []; for (const x of [...h].sort((a, b) => a - b)) if (!out.length || x - out[out.length - 1] >= 2) out.push(x);
  return out;
}
const TEMPLATES = {lh: [[0,6,8,12],[0,8,10,12],[0,4,8,12]], rh: [[0,8],[0,6,8,14],[0,3,6,8,11,14]]};
function barPatterns(nbars, prof, rng, rhythm, dens){
  const pats = {lh: [], rh: []};
  for (const [hand, key, d] of [['lh', 'low', dens.lh], ['rh', 'high', dens.rh]]){
    let base = null;
    for (let b = 0; b < nbars; b++){
      let cur;
      if (b % 2 === 0){
        base = (rhythm === 'learned' && prof) ? sampleHits(prof[key], rng, d, hand === 'lh' ? 2 : 3) : rng.choice(TEMPLATES[hand]).slice();
        cur = base;
      } else cur = rng() < 0.7 ? mutate(base, rng) : base.slice();
      if (b % 4 === 3 && hand === 'lh' && !cur.includes(14)) cur = cur.concat([14]).sort((a, b) => a - b);
      pats[hand].push(cur);
    }
  }
  return pats;
}
function genComping(segs, total, rng, prof, rhythm, dens){
  const nbars = Math.ceil(total / 16), pats = barPatterns(nbars, prof, rng, rhythm, dens);
  const notes = []; let grp = 0, prevV = null; const segV = new Map(); const roles = ['root', 'fifth', 'oct', 'fifth'];
  for (let b = 0; b < nbars; b++){
    const hits = pats.lh[b].filter(h => b * 16 + h < total);
    hits.forEach((h, k) => {
      const g = b * 16 + h, seg = segAt(segs, g), ln = lhNotes(seg);
      const role = (g === seg.start || h === 0) ? 'root' : roles[k % roles.length];
      let end = k + 1 < hits.length ? hits[k + 1] + b * 16 : (b + 1) * 16; end = Math.min(end, seg.start + seg.length);
      const ps = (role === 'root' && (g === seg.start || h === 0)) ? [ln.root, ln.root + 12] : [ln[role]];
      grp++; ps.forEach((pitch, i) => notes.push({start: g, dur: Math.max(1, end - g), pitch, track: 'lh', group: grp, role: i === 0 ? 'bass' : 'inner'}));
    });
  }
  for (let b = 0; b < nbars; b++){
    const hits = pats.rh[b].filter(h => b * 16 + h < total);
    hits.forEach((h, k) => {
      const g = b * 16 + h, seg = segAt(segs, g);
      if (!segV.has(seg.start)){ const v = voiceRh(seg, prevV); segV.set(seg.start, v); prevV = v; }
      const v = segV.get(seg.start);
      let end = k + 1 < hits.length ? hits[k + 1] + b * 16 : (b + 1) * 16; end = Math.min(end, seg.start + seg.length);
      grp++; v.forEach((pitch, i) => notes.push({start: g, dur: Math.max(1, end - g), pitch, track: 'rh', group: grp, role: i === v.length - 1 ? 'top' : 'inner'}));
    });
  }
  return notes;
}
const CELLS = [
  [[0,4],[4,2],[6,2],[8,4],[12,4]], [[0,2],[2,2],[4,4],[8,2],[10,2],[12,4]], [[2,2],[4,2],[6,4],[10,2],[12,2],[14,2]],
  [[0,6],[6,2],[8,8]], [[0,3],[3,3],[6,2],[8,4],[12,2],[14,2]], [[0,2],[2,2],[4,2],[6,2],[8,2],[10,2],[12,4]]];
function genSolo(segs, total, key, rng, startBar, lo = 67, hi = 86, restProb = 0.25){
  const sc = scalePcs(key); const scale = []; for (let p = lo; p <= hi; p++) if (sc.has(p % 12)) scale.push(p);
  const notes = []; let grp = 1000; const nbars = Math.ceil(total / 16);
  let cur = scale.reduce((b, p) => Math.abs(p - 76) < Math.abs(b - 76) ? p : b); let b = startBar;
  while (b < nbars){
    const cellA = rng.choice(CELLS), cellB = rng.choice(CELLS);
    for (let pb = 0; pb < 2; pb++){
      const bar = b + pb; if (bar >= nbars) break;
      const cell = pb === 0 ? cellA : (rng() < 0.4 ? cellA : cellB);
      for (let ci = 0; ci < cell.length; ci++){
        const [s0, d] = cell[ci], g = bar * 16 + s0; if (g >= total) break;
        const last = pb === 1 && ci === cell.length - 1;
        if (!last && rng() < restProb * (s0 % 4 === 0 ? 0.5 : 1)) continue;
        const seg = segAt(segs, g), ct = new Set(chordPcs(seg.root, seg.q));
        const r = rng(); let st;
        if (r < 0.18) st = 0; else if (r < 0.68) st = rng.choice([-1, 1]); else if (r < 0.9) st = rng.choice([-2, 2]); else st = rng.choice([-4, -3, 3, 4]);
        const target = 77 + 4 * Math.sin(b * 0.65), bias = cur < target - 3 ? 1 : (cur > target + 3 ? -1 : 0);
        if (bias && st && rng() < 0.55) st = Math.abs(st) * bias;
        let i = scale.indexOf(cur) + st; i = Math.max(0, Math.min(scale.length - 1, i)); let p = scale[i];
        const strong = s0 % 8 === 0 || last;
        const closest = (arr, x) => arr.reduce((bb, y) => Math.abs(y - x) < Math.abs(bb - x) ? y : bb);
        if (strong && !ct.has(p % 12)) p = closest(scale.filter(x => ct.has(x % 12)), p);
        if (last){ const third = (seg.root + (seg.q.startsWith('m') ? 3 : 4)) % 12; p = closest(scale.filter(x => x % 12 === seg.root || x % 12 === third), p); }
        cur = p; grp++;
        notes.push({start: g, dur: d + (last && d < 4 ? 2 : 0), pitch: p, track: 'solo', group: grp, role: 'melody'});
      }
    }
    b += 2; if (Math.floor(b / 2) % 2 === 0) b += 1;
  }
  return notes;
}
function generate(o){
  const rng = makeRng(o.seed); let segs = parseProgression(o.prog);
  if (o.repeats > 1){ const L = segs.reduce((s, x) => s + x.length, 0), base = segs; segs = [];
    for (let k = 0; k < o.repeats; k++) for (const s of base) segs.push({...s, start: s.start + k * L}); }
  const last = segs[segs.length - 1], total = last.start + last.length, key = parseKey(o.key);
  let notes = genComping(segs, total, rng, o.profile, o.rhythm, {lh: o.lhDensity, rh: o.rhDensity});
  if (o.solo) notes = notes.concat(genSolo(segs, total, key, rng, o.soloStartBar));
  return {notes, segs, total};
}

/* ---------- Humanização ---------- */
const msToTicks = (ms, bpm) => ms * bpm * PPQ / 60000;
const accent = s => s === 0 ? 9 : s === 8 ? 5 : s % 4 === 0 ? 2 : s % 2 === 0 ? -1 : -4;
function humanize(notes, segs, bpm, total, seed, cfg){
  const A = cfg.amount, rng = makeRng(seed * 7919 + 13), events = [], groups = new Map();
  const velBase = {lh: 54, rh: 62, solo: 84};
  for (const n of notes){ const k = n.track + ':' + n.group; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(n); }
  for (const [k, ns] of groups){
    const trk = ns[0].track; ns.sort((a, b) => a.pitch - b.pitch);
    let off = rng.gauss(0, cfg.timingSd) * A;
    if (trk === 'lh') off -= 4 * A; if (trk === 'solo') off += 8 * A;
    // rolagem do acorde: cada nota entra num instante diferente, com intervalos irregulares
    const nn = ns.length, dirDown = cfg.strumDir === 'down' || (cfg.strumDir === 'mix' && rng() < 0.3);
    const order = ns.map((_, i) => i); if (dirDown) order.reverse();
    const total = nn < 2 ? 0 : (cfg.strumMs ?? 28) * A * rng.uniform(0.6, 1.0) * Math.min(1, (nn - 1) / 3);
    const gaps = order.slice(1).map(() => rng.uniform(0.5, 1.5)), gs = gaps.reduce((a, b) => a + b, 0) || 1;
    const delay = new Array(nn).fill(0); let acc = 0;
    order.forEach((idx, k) => { if (k > 0) acc += total * gaps[k - 1] / gs; delay[idx] = acc; });
    ns.forEach((n, i) => {
      const sib = delay[i];
      const o = Math.max(-cfg.timingMax, Math.min(cfg.timingMax, off + rng.gauss(0, 1.2) * A)) + sib;
      const on = n.start * TPS + msToTicks(o, bpm), sb = Math.floor(n.start) % 16;
      const contour = 6 * Math.sin(2 * Math.PI * (n.start / 64));
      let v = velBase[trk] + A * (accent(sb) + contour);
      if (n.role === 'top') v += 4 * A; else if (n.role === 'inner' && trk === 'rh') v -= 3 * A; else if (n.role === 'bass') v += 3 * A;
      if (trk === 'solo'){ v += (n.pitch - 76) * 0.5 * A; v += Math.min(8, n.dur) * 0.6 * A; }
      v += rng.gauss(0, cfg.velJitter) * A; if (A === 0) v = velBase[trk];
      v = Math.max(18, Math.min(121, Math.round(v)));
      const lg = A === 0 ? 1 : rng.uniform(0.88, 1.0);
      let offT = (n.start + n.dur * lg) * TPS + msToTicks(rng.gauss(0, cfg.timingSd * 0.7) * A, bpm);
      offT = Math.max(offT, on + msToTicks(45, bpm));
      events.push({on: Math.round(Math.max(0, on)), off: Math.round(offT), pitch: n.pitch, vel: v, track: trk});
    });
  }
  const pedal = [];
  if (cfg.pedal){
    const marks = new Set(segs.map(s => s.start)); for (let b = 0; b < Math.floor(total / 16); b++) marks.add(b * 16);
    for (const m of [...marks].sort((a, b) => a - b)){
      const t0 = m * TPS, up = t0 + msToTicks(rng.uniform(12, 30) * A + 8, bpm), dn = up + msToTicks(rng.uniform(35, 70) * A + 20, bpm);
      pedal.push([Math.round(up), 0], [Math.round(dn), 127]);
    }
    pedal.unshift([0, 127]); pedal.push([total * TPS + 10, 0]);
  }
  events.sort((a, b) => a.on - b.on || a.pitch - b.pitch);
  return {events, pedal};
}

/* ---------- Exportação MIDI ---------- */
const vlq = n => { const b = [n & 0x7f]; while ((n >>= 7) > 0) b.unshift((n & 0x7f) | 0x80); return b; };
const str = s => Array.from(new TextEncoder().encode(s));
function keySig(keyText){
  const [pc, mode] = parseKey(keyText), maj = mode === 'minor' ? (pc + 3) % 12 : pc;
  const sf = [0, -5, 2, -3, 4, -1, 6, 1, -4, 3, -2, 5][maj]; return [sf & 0xff, mode === 'minor' ? 1 : 0];
}
function writeMidi(events, pedal, bpm, keyText, title){
  const be32 = n => [n >>> 24 & 255, n >>> 16 & 255, n >>> 8 & 255, n & 255], be16 = n => [n >> 8 & 255, n & 255];
  const chunk = (id, data) => [...str(id), ...be32(data.length), ...data];
  const trackBytes = msgs => { // msgs: [tick, order, bytes[]]
    msgs.sort((a, b) => a[0] - b[0] || a[1] - b[1]); const out = []; let last = 0;
    for (const [t, , bytes] of msgs){ out.push(...vlq(Math.max(0, t - last)), ...bytes); last = Math.max(last, t); }
    out.push(...vlq(PPQ), 0xFF, 0x2F, 0); return out;
  };
  const meta = (type, data) => [0xFF, type, ...vlq(data.length), ...data];
  const us = Math.round(60000000 / bpm), [sf, mi] = keySig(keyText);
  const cond = trackBytes([
    [0, 0, meta(0x03, str(title))], [0, 0, meta(0x51, [us >> 16 & 255, us >> 8 & 255, us & 255])],
    [0, 0, meta(0x58, [4, 2, 24, 8])], [0, 0, meta(0x59, [sf, mi])]]);
  const tracks = [chunk('MTrk', cond)], names = {lh: 'Piano - mao esquerda', rh: 'Piano - mao direita', solo: 'Piano - solo'}, chan = {lh: 0, rh: 1, solo: 2};
  for (const trk of ['lh', 'rh', 'solo']){
    const evs = events.filter(e => e.track === trk); if (!evs.length) continue; const ch = chan[trk];
    const msgs = [[0, 0, meta(0x03, str(names[trk]))]];
    for (const e of evs){ msgs.push([e.on, 2, [0x90 | ch, e.pitch, e.vel]], [e.off, 0, [0x80 | ch, e.pitch, 0]]); }
    for (const [t, v] of pedal) msgs.push([t, 1, [0xB0 | ch, 64, v]]);
    tracks.push(chunk('MTrk', trackBytes(msgs)));
  }
  return new Uint8Array([...str('MThd'), ...be32(6), ...be16(1), ...be16(tracks.length), ...be16(PPQ), ...tracks.flat()]);
}

/* ---------- ZIP (sem compressão) ---------- */
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++){ let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = d => { let c = 0xFFFFFFFF; for (let i = 0; i < d.length; i++) c = CRC_T[(c ^ d[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function makeZip(files){
  const parts = [], central = []; let off = 0; const le16 = n => [n & 255, n >> 8 & 255], le32 = n => [n & 255, n >> 8 & 255, n >> 16 & 255, n >>> 24 & 255];
  for (const f of files){
    const name = new TextEncoder().encode(f.name), crc = crc32(f.data), sz = f.data.length;
    const head = [0x50,0x4b,3,4, ...le16(20), ...le16(0x0800), ...le16(0), ...le16(0), ...le16(0x21), ...le32(crc), ...le32(sz), ...le32(sz), ...le16(name.length), ...le16(0)];
    parts.push(new Uint8Array(head), name, f.data);
    central.push(new Uint8Array([0x50,0x4b,1,2, ...le16(20), ...le16(20), ...le16(0x0800), ...le16(0), ...le16(0), ...le16(0x21), ...le32(crc), ...le32(sz), ...le32(sz), ...le16(name.length), ...le16(0), ...le16(0), ...le16(0), ...le16(0), ...le32(0), ...le32(off)]), name);
    off += head.length + name.length + sz;
  }
  const cdSize = central.reduce((s, p) => s + p.length, 0);
  const end = new Uint8Array([0x50,0x4b,5,6, 0,0,0,0, ...le16(files.length), ...le16(files.length), ...le32(cdSize), ...le32(off), 0,0]);
  const all = [...parts, ...central, end], out = new Uint8Array(all.reduce((s, p) => s + p.length, 0)); let o = 0;
  for (const p of all){ out.set(p, o); o += p.length; } return out;
}

return {NAMES, parseChord, parseKey, parseProgression, parseMidi, analyzeMidi, aggregateProfile, progressionFromChords,
  generate, humanize, writeMidi, makeZip, PPQ, TPS, msToTicks, chordName};
})();
if (typeof module !== 'undefined') module.exports = PGM;
