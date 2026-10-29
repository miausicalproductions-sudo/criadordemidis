'use strict';
/* ===== Motor: teoria, análise de MIDIs, geração, humanização, exportação ===== */
const PGM = (() => {
const NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const FLAT = {Db:'C#',Eb:'D#',Gb:'F#',Ab:'G#',Bb:'A#',Cb:'B',Fb:'E','E#':'F','B#':'C'};
const QUAL = {'':[0,4,7], m:[0,3,7], '7':[0,4,7,10], maj7:[0,4,7,11], m7:[0,3,7,10], sus4:[0,5,7], sus2:[0,2,7],
  maj9:[0,4,7,11,14], m9:[0,3,7,10,14], '9':[0,4,7,10,14], add9:[0,4,7,14], '6':[0,4,7,9], m6:[0,3,7,9], dim:[0,3,6], m7b5:[0,3,6,10], aug:[0,4,8]};
const isMin = q => /^m(?!aj)/.test(q);
const ALIAS = {min:'m', min7:'m7', M7:'maj7'};
const MAJOR = [0,2,4,5,7,9,11], MINOR = [0,2,3,5,7,8,10];
const PPQ = 480, TPS = PPQ / 4;           // TPS = ticks por semicolcheia (step)

function pcOf(n){ n = FLAT[n] || n; const i = NAMES.indexOf(n); if (i < 0) throw new Error('Nota inválida: ' + n); return i; }
function parseChord(s){
  const m = /^([A-G][#b]?)(maj9|maj7|min7|m7b5|m9|m7|M7|min|m6|m|add9|sus4|sus2|dim|aug|9|7|6|)(?:\/([A-G][#b]?))?$/.exec(s.trim());
  if (!m) throw new Error('Acorde inválido: "' + s + '"');
  return [pcOf(m[1]), ALIAS[m[2]] ?? m[2], m[3] ? pcOf(m[3]) : null];
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
    const length = Math.max(1, Math.round(beats * 4)); const [root, q, bass] = parseChord(name);
    segs.push({start: pos, length, root, q, name, bass});  pos += length;
  }
  return segs;
}
const segAt = (segs, step) => { for (const s of segs) if (s.start <= step && step < s.start + s.length) return s; return segs[segs.length - 1]; };
const nearest = (pc, around, lo, hi) => { let best = null; for (let p = lo; p <= hi; p++) if (p % 12 === pc && (best === null || Math.abs(p - around) < Math.abs(best - around))) best = p; return best; };
const avg = a => a.reduce((x, y) => x + y, 0) / a.length;

function voicePcs(seg){
  let iv = QUAL[seg.q].map(i => i % 12), r = seg.root;
  const uniq = [...new Set(iv)];
  let use = uniq.slice();
  if (use.length >= 4 && use.includes(7) && !seg.q.startsWith('dim') ) use = use.filter(i => i !== 7);   // quinta fora nos acordes ricos
  if (use.length > 4) use = use.filter(i => i !== 0);                                                      // sem fundamental na mão direita se passar de 4
  return use.map(i => (r + i) % 12);
}
function voiceRh(seg, prev, lo = 57, hi = 76){
  const pcs = voicePcs(seg), cands = [];
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
function lhNotes(seg){ const root = nearest(seg.bass ?? seg.root, 40, 36, 47); return {root, fifth: root + 7, oct: root + 12}; }

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
/* ---------- Texturas de balada ----------
   ballad:       mão esquerda arpejando em colcheias, mão direita com acordes longos (1 e 3)
   ballad-still: baixo parado (raiz + oitava no 1, quinta no 3) e acordes longos
   arpeggio:     baixo parado e mão direita arpejando em colcheias
   Notas longas + pedal, poucos ataques: é o que dá a suavidade. */
function lhLadder(seg){
  const r = nearest(seg.bass ?? seg.root, 40, 36, 47);
  if (seg.bass != null && seg.bass !== seg.root){            // baixo trocado: sobe pelos sons do acorde a partir dele
    const tones = voicePcs(seg).map(pc => ((pc - r) % 12 + 12) % 12).filter(i => i > 0).sort((a, b) => a - b);
    const a = tones[0] ?? 7, b = tones[1] ?? a + 3, c = tones[2] ?? b + 3;
    return [r, r + b, r + 12, r + 12 + a, r + 12 + c];
  }
  const sixth = seg.q.includes('dim') || seg.q.includes('b5') ? 6 : seg.q === 'aug' ? 8 : 7;
  const t = r + 12 + (isMin(seg.q) || seg.q.startsWith('dim') ? 3 : seg.q.startsWith('sus') ? (seg.q === 'sus4' ? 5 : 2) : 4);
  return [r, r + sixth, r + 12, t, r + 12 + sixth];
}
function genBallad(segs, total, rng, texture, V){
  const nbars = Math.ceil(total / 16), notes = []; let grp = 0, prevV = null; const segV = new Map();
  const voice = seg => { if (!segV.has(seg.start)){ let lo = 60, hi = 79;
    if (V){ const r = V.range(seg.start, seg.start + seg.length);
      if (r){ if (r[1] < 55){ lo = Math.min(r[1] + 3, 76); hi = lo + 19; } else { hi = Math.max(58, Math.min(79, r[0] - 1)); lo = Math.max(46, hi - 17); } } }
    const v = voiceRh(seg, prevV, lo, hi); segV.set(seg.start, v); prevV = v; } return segV.get(seg.start); };
  const EMO_TEX = {sussurro: 'whisper', balada: 'ballad', crescendo: 'arpeggio', climax: 'climax'};
  let rhPat = [0, 8];
  for (let b = 0; b < nbars; b++){
    const base = b * 16;
    const sg0 = segAt(segs, base), tx = (sg0.emo && EMO_TEX[sg0.emo]) || texture;
    const dense = !!V && V.count(base, base + 16) >= 6;
    const lhArp = tx === 'ballad', rhArp = tx === 'arpeggio', climax = tx === 'climax', whisper = tx === 'whisper';
    if (lhArp){
      const idx = [0, 1, 2, 3, 2, 1, 2, 3], drop = rng() < 0.35 ? 1 + Math.floor(rng() * 7) : -1;
      for (let k = 0; k < 8; k++){
        const g = base + k * 2; if (g >= total || k === drop) continue;
        const seg = segAt(segs, g), end = Math.min(seg.start + seg.length, g + (k === 7 ? 2 : 3));
        grp++; notes.push({start: g, dur: Math.max(1, end - g), pitch: lhLadder(seg)[idx[k]], track: 'lh', group: grp, role: k === 0 ? 'bass' : 'inner', lg: [1.0, 1.15]});
      }
    } else if (climax){
      for (const [h, hi] of [[0, 0], [8, 1]]){
        const g = base + h; if (g >= total) continue; const seg = segAt(segs, g), l = lhLadder(seg);
        const end = Math.min(seg.start + seg.length, base + h + 8), ps = [l[0] - 12, l[0], hi ? l[1] : l[2]];
        grp++; ps.forEach((pitch, i) => notes.push({start: g, dur: Math.max(1, end - g), pitch, track: 'lh', group: grp, role: i === 0 ? 'bass' : 'inner', lg: [0.98, 1.05]}));
      }
    } else {
      for (const [h, which] of [[0, 'root'], [8, 'fifth']]){
        const g = base + h; if (g >= total) continue; const seg = segAt(segs, g), l = lhLadder(seg);
        const end = Math.min(seg.start + seg.length, h === 0 ? base + 8 : base + 16);
        const ps = which === 'root' ? [l[0], l[2]] : [l[0], l[1]];
        grp++; ps.forEach((pitch, i) => notes.push({start: g, dur: Math.max(1, end - g), pitch, track: 'lh', group: grp, role: i === 0 ? 'bass' : 'inner', lg: [0.98, 1.05]}));
      }
    }
    if (rhArp){
      const idx = [0, 1, 2, 3, 2, 1, 2, 1], drop = rng() < 0.3 ? 1 + Math.floor(rng() * 7) : -1;
      for (let k = 0; k < 8; k++){
        const g = base + k * 2; if (g >= total || k === drop) continue;
        if (dense && k % 2) continue;
        const seg = segAt(segs, g), v = voice(seg), lad = v.concat([v[0] + 12]), end = Math.min(seg.start + seg.length, g + 4);
        grp++; notes.push({start: g, dur: Math.max(1, end - g), pitch: lad[idx[k] % lad.length], track: 'rh', group: grp, role: 'inner', lg: [0.95, 1.1]});
      }
    } else if (climax){
      (dense ? [0, 8] : [0, 4, 8, 12]).forEach((h, k, arr) => {
        const g = base + h; if (g >= total) return; const seg = segAt(segs, g), v = voice(seg);
        const end = Math.min(k + 1 < arr.length ? base + arr[k + 1] : base + 16, seg.start + seg.length);
        grp++; v.forEach((pitch, i) => notes.push({start: g, dur: Math.max(1, end - g), pitch, track: 'rh', group: grp, role: i === v.length - 1 ? 'top' : 'inner', lg: [0.96, 1.02]}));
        if (!V) notes.push({start: g, dur: Math.max(1, end - g), pitch: v[v.length - 1] + 12, track: 'rh', group: grp, role: 'top', lg: [0.96, 1.02]});
      });
    } else {
      if (whisper || dense) rhPat = rng() < (dense ? 0.6 : 0.5) ? [0] : [0, 8]; else if (b % 2 === 0) rhPat = rng.choice([[0, 8], [0, 8], [0, 10], [0, 6, 10]]); else if (rng() < 0.4) rhPat = rng.choice([[0, 8], [0, 10], [0, 12]]);
      rhPat.forEach((h, k) => {
        const g = base + h; if (g >= total) return; const seg = segAt(segs, g), v = voice(seg);
        let end = k + 1 < rhPat.length ? base + rhPat[k + 1] : base + 16; end = Math.min(end, seg.start + seg.length);
        grp++; v.forEach((pitch, i) => notes.push({start: g, dur: Math.max(1, end - g), pitch, track: 'rh', group: grp, role: i === v.length - 1 ? 'top' : 'inner', lg: [0.96, 1.03]}));
      });
    }
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
        if (last){ const third = (seg.root + (isMin(seg.q) || seg.q.startsWith('dim') ? 3 : 4)) % 12; p = closest(scale.filter(x => x % 12 === seg.root || x % 12 === third), p); }
        if (p === cur && rng() < 0.75){ const j = Math.max(0, Math.min(scale.length - 1, scale.indexOf(p) + rng.choice([-1, 1]))); p = scale[j]; }
        cur = p; grp++;
        notes.push({start: g, dur: d + (last && d < 4 ? 2 : 0), pitch: p, track: 'solo', group: grp, role: 'melody'});
      }
    }
    b += 2; if (Math.floor(b / 2) % 2 === 0) b += 1;
  }
  return notes;
}
/* Seções: cada uma com acordes, repetições, emoção (sussurro/balada/crescendo/climax), intensidade 0–100 e solo ligado/desligado.
   Cada seção ocupa compassos inteiros (o último acorde estica até o fim do compasso). */
function buildSections(sections){
  const segs = []; let pos = 0;
  sections.forEach((sec, si) => {
    const base = parseProgression(sec.prog), L0 = base.reduce((a, x) => a + x.length, 0), reps = Math.max(1, sec.reps | 0 || 1);
    const L = Math.ceil(L0 / 16) * 16, total = L * reps, ramp = sec.ramp ?? (sec.emo === 'crescendo' ? 30 : 0);
    for (let k = 0; k < reps; k++) base.forEach((s, i) => {
      const length = s.length + (i === base.length - 1 ? L - L0 : 0), start = pos + k * L + s.start;
      const frac = (start - pos + length / 2) / total;
      segs.push({...s, start, length, sec: si, secName: sec.name || ('Seção ' + (si + 1)), emo: sec.emo || 'balada', solo: sec.solo !== false,
        vint: Math.max(0, Math.min(100, (sec.int ?? 50) + ramp * (frac - 0.5)))});
    });
    pos += total;
  });
  return segs;
}

/* ---------- Voz guia (MIDI do Melodyne): o acompanhamento se desenha em volta dela ---------- */
function vocalFromMidi(buf){
  const m = parseMidi(buf), k = 4 / m.ppq;
  const ns = m.notes.map(n => ({start: n.start * k, dur: (n.end - n.start) * k, pitch: n.pitch, vel: n.vel})).filter(n => n.dur >= 0.5);
  if (!ns.length) throw new Error('Não achei notas nesse MIDI.');
  const r = x => Math.round(x * 1000) / 1000, end = Math.max(...ns.map(n => n.start + n.dur));
  return {notes: ns.map(n => ({start: r(n.start), dur: r(n.dur), pitch: n.pitch, vel: n.vel})), bars: Math.ceil(end / 16), key: guessKey(m.notes), bpm: Math.round(m.bpm * 10) / 10};
}
function vocalCtx(v){
  if (!v || !v.notes || !v.notes.length) return null;
  const ns = v.notes, ov = (a, b) => ns.filter(n => n.start < b && n.start + n.dur > a);
  const rests = []; let t = 0;
  for (const n of ns){ if (n.start - t >= 6) rests.push([t, n.start]); t = Math.max(t, n.start + n.dur); }
  rests.push([t, 1e9]);
  return {ns, ov, rests, count: (a, b) => ov(a, b).length,
    range: (a, b) => { const o = ov(a, b).map(n => n.pitch).sort((x, y) => x - y); return o.length ? [o[Math.floor(0.1 * (o.length - 1))], o[Math.ceil(0.9 * (o.length - 1))]] : null; }};
}
function suggestChords(vnotes, keyText, perBar = 1, bars = null){
  const key = parseKey(keyText), minor = key[1] === 'minor', sc = minor ? MINOR : MAJOR;
  const nb = bars || Math.ceil(Math.max(...vnotes.map(n => n.start + n.dur)) / 16), W = 16 / perBar, nw = nb * perBar;
  const cands = [];
  for (let d = 0; d < 7; d++){
    const iv = [0, 2, 4, 6].map(k => (sc[(d + k) % 7] - sc[d] + 12) % 12), root = (key[0] + sc[d]) % 12;
    const q3 = iv[1] === 3 ? (iv[2] === 6 ? 'dim' : 'm') : '';
    const seventh = (root + iv[3]) % 12, tri = [root, (root + iv[1]) % 12, (root + iv[2]) % 12];
    const q7 = q3 === 'dim' ? 'm7b5' : q3 === 'm' ? 'm7' : (iv[3] === 11 ? 'maj7' : '7');
    cands.push({d, root, tri, seventh, q3, q7, prior: [.25, .05, .1, .2, .25, .15, 0][d]});
  }
  const sc2 = [];
  for (let w = 0; w < nw; w++){
    const a = w * W, b = a + W, h = new Array(12).fill(0); let tot = 0;
    for (const n of vnotes){ const o = Math.min(b, n.start + n.dur) - Math.max(a, n.start); if (o > 0){ h[n.pitch % 12] += o; tot += o; } }
    sc2.push(cands.map(c => { if (!tot) return 0; let s = 0; for (let pc = 0; pc < 12; pc++) s += (c.tri.includes(pc) ? 1 : -0.8) * h[pc] / tot; return s + c.prior + (h[c.root] / tot) * 0.3; }));
  }
  const CH = 0.15, best = [], from = [];
  for (let w = 0; w < nw; w++){
    best.push(cands.map((_, i) => { let bv = -1e9, bf = 0; for (let j = 0; j < 7; j++){ const v = (w ? best[w - 1][j] : 0) - (w && j !== i ? CH : 0); if (v > bv){ bv = v; bf = j; } } return bv + sc2[w][i]; }));
    from.push(cands.map((_, i) => { let bv = -1e9, bf = 0; for (let j = 0; j < 7; j++){ const v = (w ? best[w - 1][j] : 0) - (w && j !== i ? CH : 0); if (v > bv){ bv = v; bf = j; } } return bf; }));
  }
  let st = best[nw - 1].indexOf(Math.max(...best[nw - 1])); const path = new Array(nw);
  for (let w = nw - 1; w >= 0; w--){ path[w] = st; st = from[w][st]; }
  const names = path.map((d, w) => {
    const c = cands[d], a = w * W, b = a + W, sw = vnotes.reduce((x, n) => { const o = Math.min(b, n.start + n.dur) - Math.max(a, n.start); return n.pitch % 12 === c.seventh && o > 0 ? x + o : x; }, 0);
    const all = vnotes.reduce((x, n) => { const o = Math.min(b, n.start + n.dur) - Math.max(a, n.start); return o > 0 ? x + o : x; }, 0);
    return NAMES[c.root] + (all && sw > 0.25 * all ? c.q7 : c.q3);
  });
  const out = [];
  for (const n of names){ if (out.length && out[out.length - 1][0] === n) out[out.length - 1][1] += 4 / perBar; else out.push([n, 4 / perBar]); }
  return out.map(([n, b]) => n + ':' + b).join(' ');
}
function fitFills(sol, V){
  const out = [];
  for (const n of sol){
    const w = V.rests.find(r => n.start >= r[0] + 1 && n.start < r[1] - 1); if (!w) continue;
    const end = Math.min(n.start + n.dur, w[1] - 1); if (end - n.start >= 1) out.push({...n, dur: end - n.start, fill: true});
  }
  return out;
}
function vocalEvents(v){
  return (v && v.notes ? v.notes : []).map(n => ({on: Math.round(n.start * TPS), off: Math.round((n.start + n.dur) * TPS), pitch: n.pitch, vel: n.vel, track: 'voz'}));
}

/* ---------- Guia de acordes a partir de um MIDI harmônico (Melodyne, piano, violão...) ----------
   Janela por compasso (ou meio compasso): soma a duração de cada nota por classe de altura, compara com cada acorde
   do vocabulário, dá bônus para o baixo e para acordes do tom, e suaviza trocas à toa. */
const GUIDE_Q = ['', 'm', '7', 'maj7', 'm7', 'sus4', 'dim', 'm7b5'];
function chordGuideFromMidi(name, buf, perBar = 1){
  const m = parseMidi(buf); if (!m.notes.length) throw new Error('Sem notas (parece ser só um mapa de andamento).');
  const notes = cleanNotes(m.notes, m.ppq); if (!notes.length) throw new Error('Sem notas utilizáveis depois da limpeza.');
  const bar = m.ppq * (m.ts ? m.ts[0] : 4), W = bar / perBar, lastOn = Math.max(...notes.map(n => n.start)), nw = Math.max(1, Math.floor(lastOn / W) + 1);
  const keyText = guessKey(notes), key = parseKey(keyText), dia = scalePcs(key);
  const names = []; let prev = null;
  const rawBass = [];
  for (let w = 0; w < nw; w++){
    const lo = w * W, hi = lo + W, inb = notes.filter(n => n.start < hi && n.end > lo);
    if (inb.length < 2){ names.push(prev); rawBass.push(null); continue; }
    const h = new Array(12).fill(0); let tot = 0;
    for (const n of inb){ const ov = Math.min(n.end, hi) - Math.max(n.start, lo); const wt = ov * (n.pitch < 55 ? 1.25 : 1); h[n.pitch % 12] += wt; tot += wt; }
    let low = null; for (const n of inb) if (n.start < hi && n.end > lo && (!low || n.pitch < low.pitch)) low = n;
    const bass = low ? low.pitch % 12 : null; rawBass.push(bass);
    let best = null, bs = -1e18;
    for (let r = 0; r < 12; r++) for (const q of GUIDE_Q){
      const pcs = new Set(chordPcs(r, q)); let sc = 0;
      for (let p = 0; p < 12; p++) sc += pcs.has(p) ? h[p] : -0.8 * h[p];
      if (bass === r) sc += 0.25 * tot;
      if (q !== '' && q !== 'm') sc -= 0.12 * tot;                // prefere o simples quando empata
      if (q === 'sus4' || q === 'dim' || q === 'm7b5') sc -= 0.12 * tot;
      if (dia.has(r)) sc += 0.08 * tot;
      if (prev && prev.r === r && prev.q === q) sc += 0.10 * tot; // pequena inércia
      if (sc > bs){ bs = sc; best = {r, q, bass}; }
    }
    names.push(best); prev = best;
  }
  const first = names.find(c => c); const ch = names.map(c => c || first);
  // baixo trocado só quando o baixo é nota do acorde e não é a fundamental
  const label = (c, i) => { const base = NAMES[c.r] + c.q; const b = rawBass[i]; return b != null && b !== c.r && chordPcs(c.r, c.q).includes(b) && ['', 'm'].includes(c.q) ? base + '/' + NAMES[b] : base; };
  const list = ch.map(label), out = [];
  for (const n of list){ if (out.length && out[out.length - 1][0] === n) out[out.length - 1][1] += 4 / perBar; else out.push([n, 4 / perBar]); }
  return {name, key: keyText, bpm: Math.round(m.bpm * 10) / 10, bars: Math.ceil(nw / perBar), nNotes: notes.length, windows: list,
    prog: out.map(([n, b]) => n + ':' + b).join(' ')};
}

/* ---------- Cifra colada (Cifra Club e parecidos): acordes em cima da letra, com [Seções] ---------- */
function normChord(tok){
  const m = /^([A-G][#b]?)(.*?)(?:\/([A-G][#b]?))?$/.exec(tok.trim()); if (!m) return null;
  let q = m[2].replace(/[()\s]/g, ''), out;
  if (/^(dim|º|°|o)/i.test(q) && !/^(o)$/.test('x')) out = 'dim';
  else if (/m7b5|m7\(?5-|ø|m7-5/i.test(q)) out = 'm7b5';
  else if (/^(aug|\+)/.test(q)) out = 'aug';
  else if (/^m(?!aj)/.test(q)) out = /9/.test(q) ? 'm9' : /6/.test(q) && !/7/.test(q) ? 'm6' : /7/.test(q) ? 'm7' : 'm';
  else if (/^(maj|M|7M|7\+)/.test(q)) out = /9/.test(q) ? 'maj9' : 'maj7';
  else if (/^sus2|^2/.test(q)) out = 'sus2';
  else if (/^sus|^4/.test(q)) out = 'sus4';
  else if (/^add9/.test(q)) out = 'add9';
  else if (/^9/.test(q)) out = '9';
  else if (/^7/.test(q)) out = '7';
  else if (/^6/.test(q)) out = '6';
  else out = '';
  let name = m[1] + out + (m[3] ? '/' + m[3] : '');
  try { parseChord(name); } catch (e){ try { parseChord(m[1] + out); name = m[1] + out; } catch (e2){ return null; } }
  return name;
}
const CIF_FILL = /^(\||\|\||-|–|—|\/|:|\.{2,}|N\.?C\.?|x\d+|\d+x|\(?\d+x\)?|\(|\)|\[|\]|%)$/i;
function keyFromChords(names, weights){
  const cs = names.map(n => parseChord(n)); let best = null, bs = -1e9;
  for (let r = 0; r < 12; r++) for (const minor of [false, true]){
    const sc = scalePcs([r, minor ? 'minor' : 'major']); let s = 0;
    cs.forEach(([root, q], i) => { const pcs = chordPcs(root, q.startsWith('sus') ? '' : q); const inn = pcs.filter(p => sc.has(p)).length / pcs.length; s += (inn === 1 ? 1 : inn - 1.2) * weights[i]; });
    const tonic = (r), triadOK = (c) => c && c[0] === tonic && (minor ? isMin(c[1]) : !isMin(c[1]));
    if (triadOK(cs[0])) s += 1.2; if (triadOK(cs[cs.length - 1])) s += 1.2; if (cs.some(triadOK)) s += 0.8;
    if (s > bs){ bs = s; best = NAMES[r] + (minor ? 'm' : ''); }
  }
  return best;
}
const sylCount = t => (String(t).toLowerCase().match(/[aeiouáéíóúâêôãõàü]+/g) || []).length;
/* Duração pela letra: cada acorde ganha a parte da frase cantada em cima dele. A frase vira compassos inteiros
   conforme a velocidade de fala (sílabas por segundo) e o BPM; cada acorde recebe múltiplos de 2 batidas. */
function lyricBeats(items, lyric, bpm, sylPerSec = 3.5){
  const n = items.length, cols = items.map(i => i.col), syl = items.map((_, i) => sylCount(lyric.slice(i === 0 ? 0 : cols[i], i + 1 < n ? cols[i + 1] : undefined)));
  const S = syl.reduce((a, b) => a + b, 0); if (!S) return null;
  const spb = sylPerSec * 240 / bpm;                                     // sílabas por compasso
  let total = 4 * Math.max(1, Math.round(S / spb)); if (total < 2 * n) total = Math.ceil(2 * n / 4) * 4;
  const b = syl.map(x => Math.max(2, 2 * Math.round(total * x / S / 2)));
  let sum = b.reduce((x, y) => x + y, 0), guard = 40;
  while (sum !== total && guard--){ const i = sum > total ? b.indexOf(Math.max(...b)) : b.indexOf(Math.max(...syl.map((x, k) => syl[k] === Math.max(...syl) ? b[k] : 0))); if (sum > total){ if (b[i] <= 2) break; b[i] -= 2; sum -= 2; } else { b[i] += 2; sum += 2; } }
  return b;
}
function parseCifra(text, beatsPerChord = 4, bpm = 100){
  const secs = [], warn = []; let cur = null, pend = null;
  const flush = () => { if (pend){ for (const it of pend.items) if (it.o.b == null) it.o.b = beatsPerChord > 0 ? beatsPerChord : 4; pend = null; } };
  const EMO = [[/intro/i, 'sussurro', 30, false], [/pr[eé]/i, 'crescendo', 50, true], [/refr|chorus|coro/i, 'climax', 80, true], [/ponte|bridge/i, 'crescendo', 55, true],
    [/final|outro|coda|fim/i, 'sussurro', 30, false], [/solo|instrum|interl/i, 'balada', 55, true], [/verso|estrofe|verse|parte/i, 'sussurro', 38, false]];
  const open = name => { flush(); const e = EMO.find(x => x[0].test(name)) || [null, 'balada', 50, true]; cur = {name, chords: [], lyric: '', emo: e[1], int: e[2], solo: e[3]}; secs.push(cur); };
  const isHeading = l => /^\s*\[[^\]]+\]\s*$/.test(l) || /^\s*(intro|verso|estrofe|pr[eé][- ]?refr|refr|ponte|solo|final|outro|coda|bridge|chorus|verse|interl|parte)[^\n]{0,24}:?\s*$/i.test(l) && !/[a-záéíóúãõç]{4,}\s+[a-záéíóúãõç]{3,}\s+[a-záéíóúãõç]{3,}/i.test(l);
  const lines = []; for (const l of String(text).replace(/\r/g, '').split('\n')){ const m = /^\s*(\[[^\]]+\])\s*(\S.*)$/.exec(l); if (m){ lines.push(m[1]); lines.push(m[2]); } else lines.push(l); }
  for (const raw of lines){
    const line = raw.trim(); if (!line) continue;
    if (/^(tom|capo|afina|tab|letra|cifra)\s*[:\-]/i.test(line)) continue;
    const toks = line.replace(/[\[\]]/g, ' ').split(/\s+/).filter(Boolean);
    const chordToks = toks.filter(t => !CIF_FILL.test(t));
    const chords = chordToks.map(t => normChord(t));
    const heading = isHeading(raw) && (/^\s*\[/.test(raw) || !chords.every(c => c));
    if (heading){ open(line.replace(/[\[\]:]/g, '').trim()); continue; }
    // uma linha de acordes: tudo são acordes (ou marcas) e há pelo menos um
    if (chordToks.length && chords.every(c => c)){
      if (!cur) open('Música');
      // barras "|" separam compassos: acordes entre duas barras dividem o compasso
      if (toks.includes('|')){
        let bar = [];
        const flushBar = () => { if (bar.length){ for (const c of bar) cur.chords.push({c, b: 4 / bar.length}); bar = []; } };
        for (const t of toks){ if (t === '|' || t === '||') flushBar(); else if (!CIF_FILL.test(t)) bar.push(normChord(t)); }
        flushBar();
      } else {
        flush(); const cols = []; raw.replace(/\S+/g, (t, i) => { if (!CIF_FILL.test(t.replace(/[\[\]]/g, ''))) cols.push(i); return t; });
        pend = {items: chords.map((c, i) => { const o = {c, b: beatsPerChord > 0 ? null : null}; cur.chords.push(o); return {o, col: cols[i] ?? 0}; })};
      }
      continue;
    }
    const bad = chordToks.filter((t, i) => !chords[i]);
    if (bad.length && bad.length === chordToks.length && toks.length <= 3 && /^[A-G]/.test(toks[0]) && !/[a-z]{3,}/.test(line)) warn.push('Acorde não reconhecido: ' + bad.join(' '));
    if (pend && beatsPerChord <= 0){
      const lb = lyricBeats(pend.items, raw.replace(/\t/g, '    '), bpm);
      if (lb) pend.items.forEach((it, i) => { it.o.b = lb[i]; }); pend = null;
    } else if (pend) flush();
    if (cur && !cur.lyric) cur.lyric = line.slice(0, 80);
  }
  flush();
  const keep = secs.filter(x => x.chords.length);
  if (!keep.length) throw new Error('Não achei acordes nesse texto. Cole a cifra com os acordes em linhas próprias (como no Cifra Club).');
  const all = keep.flatMap(x => x.chords.map(o => [o.c, o.b]));
  const key = keyFromChords(all.map(c => c[0]), all.map(c => c[1]));
  const sections = keep.map(x => {
    const merged = []; for (const {c, b} of x.chords){ if (merged.length && merged[merged.length - 1][0] === c) merged[merged.length - 1][1] += b; else merged.push([c, b]); }
    return {name: x.name, prog: merged.map(([c, b]) => c + ':' + b).join(' '), reps: 1, emo: x.emo, int: x.int, solo: x.solo, lyric: x.lyric};
  });
  return {sections, key, nChords: all.length, warnings: [...new Set(warn)]};
}
function generate(o){
  const rng = makeRng(o.seed); let segs;
  if (o.sections && o.sections.length) segs = buildSections(o.sections);
  else { segs = parseProgression(o.prog);
  if (o.repeats > 1 && !o.vocal){ const L = segs.reduce((s, x) => s + x.length, 0), base = segs; segs = [];
    for (let k = 0; k < o.repeats; k++) for (const s of base) segs.push({...s, start: s.start + k * L}); } }
  const last = segs[segs.length - 1], total = last.start + last.length, key = parseKey(o.key);
  const tex = o.texture || 'driving';
  let notes = tex === 'driving' && !(o.sections && o.sections.length) ? genComping(segs, total, rng, o.profile, o.rhythm, {lh: o.lhDensity, rh: o.rhDensity}) : genBallad(segs, total, rng, tex, vocalCtx(o.vocal));
  const V = vocalCtx(o.vocal);
  if (o.solo){ let sol = genSolo(segs, total, key, rng, o.soloStartBar); if (V) sol = fitFills(sol, V); notes = notes.concat(sol.filter(n => segAt(segs, n.start).solo !== false)); }
  return {notes, segs, total};
}

/* ---------- Humanização v2 ----------
   Desvios correlacionados e com intenção, sempre medidos a partir da grade exata:
   - rubato lento compartilhado por todas as linhas + respiro no fim de cada frase de 4 compassos
   - ruído por tempo compartilhado entre as mãos (+ um pouco individual por nota)
   - melodia à frente do acompanhamento
   - rolagem do acorde só em parte dos acordes, com intervalos irregulares e direção variável
   - velocity por papel (melodia > topo do acorde > notas internas), arco por frase, acento na troca de acorde
   - durações por linha (melodia ligada, mão direita mais curta), sem notas presas no mesmo pitch
   - pedal com meio-pedal (profundidade variável) */
const msToTicks = (ms, bpm) => ms * bpm * PPQ / 60000;
const accent = s => s === 0 ? 9 : s === 8 ? 5 : s % 4 === 0 ? 2 : s % 2 === 0 ? -1 : -4;
const HUMAN_DEFAULTS = {vShift: 0, strumMs: 36, strumProb: 0.8, strumDir: 'mix', lead: 12, rubato: 10, contrast: 1, timingSd: 6, timingMax: 22, velJitter: 6, pedal: true};
function humanize(notes, segs, bpm, total, seed, cfg){
  const c = {...HUMAN_DEFAULTS}; for (const k in cfg) if (cfg[k] !== undefined) c[k] = cfg[k];
  const A = c.amount, rng = makeRng(seed * 7919 + 13), events = [], groups = new Map();
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const flat = {lh: 54 + c.vShift, rh: 62 + c.vShift, solo: 84 + c.vShift};
  const base = {lh: 50 + c.vShift, rh: 56 + c.vShift, solo: 56 + 12 * c.contrast + c.vShift};
  const segStarts = new Set(segs.map(s => s.start));
  const ph1 = rng() * 2 * Math.PI, ph2 = rng() * 2 * Math.PI;
  const drift = t => c.rubato * A * (0.6 * Math.sin(2 * Math.PI * t / (4.7 * 4) + ph1) + 0.4 * Math.sin(2 * Math.PI * t / (11.3 * 4) + ph2));
  const ritard = t => { const bar = Math.floor(t / 16), s = t % 16; return (bar % 4 === 3 && s >= 12) ? c.rubato * A * 0.9 * (s - 11) / 4 : 0; };
  const beatNoise = Array.from({length: Math.ceil(total / 4) + 2}, () => rng.gauss(0, 0.6 * c.timingSd) * A);
  for (const n of notes){ const k = n.track + ':' + n.group; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(n); }
  for (const [, ns] of groups){
    const trk = ns[0].track; ns.sort((a, b) => a.pitch - b.pitch);
    const nn = ns.length;
    // rolagem: só parte dos acordes rola forte; os outros ficam quase juntos
    const rolled = rng() < c.strumProb;
    const dirDown = c.strumDir === 'down' || (c.strumDir === 'mix' && rng() < 0.65);
    const order = ns.map((_, i) => i); if (dirDown) order.reverse();
    const span = nn < 2 ? 0 : c.strumMs * A * (rolled ? rng.uniform(0.5, 1.6) : rng.uniform(0, 0.3)) * Math.min(1, (nn - 1) / 3);
    const gaps = order.slice(1).map(() => rng.uniform(0.5, 1.5)), gs = gaps.reduce((a, b) => a + b, 0) || 1;
    const delay = new Array(nn).fill(0), rank = new Array(nn).fill(0); let acc = 0;
    order.forEach((idx, k) => { if (k > 0) acc += span * gaps[k - 1] / gs; delay[idx] = acc; rank[idx] = nn > 1 ? 1 - 2 * k / (nn - 1) : 0; });
    const roleOff = (trk === 'lh' ? 0 : trk === 'rh' ? -c.lead * 0.5 : -c.lead) * A;
    const gBeat = beatNoise[Math.floor(ns[0].start / 4)];
    ns.forEach((n, i) => {
      const noise = clamp(rng.gauss(0, 0.5 * c.timingSd) * A, -c.timingMax, c.timingMax);
      const onMs = drift(n.start) + ritard(n.start) + gBeat + roleOff + noise + delay[i];
      const on = n.start * TPS + msToTicks(onMs, bpm);
      // velocity
      const st = Math.floor(n.start), sb = st % 16;
      let add = (n.fill ? -6 : 0) + ((segAt(segs, st).vint ?? 50) - 50) * 0.4 + accent(sb) + 6 * Math.sin(2 * Math.PI * n.start / 64) + (segStarts.has(st) ? 5 : 0) + 3 * rank[i] * (span > 8 ? 1 : 0);
      if (trk === 'solo'){ const fr = (n.start % 32) / 32; add += 6 * (2 * Math.sin(Math.PI * (0.15 + 0.7 * fr)) - 1) + (n.pitch - 76) * 0.25 + Math.min(8, n.dur) * 0.3; }
      if (n.role === 'top') add += 7 * c.contrast; else if (n.role === 'inner' && trk === 'rh') add -= 5 * c.contrast; else if (n.role === 'bass') add -= 2;
      let v = base[trk] + A * add + rng.gauss(0, c.velJitter * 0.8) * A;
      if (A === 0) v = flat[trk];
      v = Math.round(clamp(v, 18, 122));
      // duração por linha
      const lgr = n.lg || (trk === 'solo' ? [0.98, 1.12] : trk === 'rh' ? [0.78, 0.96] : [0.95, 1.04]);
      const lg = A === 0 ? 1 : 1 + (rng.uniform(lgr[0], lgr[1]) - 1) * A;
      let offT = (n.start + n.dur * lg) * TPS + msToTicks(rng.gauss(0, c.timingSd * 0.6) * A, bpm);
      offT = Math.max(offT, on + msToTicks(45, bpm));
      events.push({on: Math.round(Math.max(0, on)), off: Math.round(offT), pitch: n.pitch, vel: v, track: trk});
    });
  }
  // nunca deixa a mesma nota ligada por cima da repetição dela mesma
  const byKey = new Map();
  for (const e of events){ const k = e.track + ':' + e.pitch; if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(e); }
  for (const list of byKey.values()){ list.sort((a, b) => a.on - b.on); for (let i = 0; i + 1 < list.length; i++) if (list[i].off > list[i + 1].on - 2) list[i].off = Math.max(list[i].on + 1, list[i + 1].on - 2); }
  const pedal = [];
  if (c.pedal){
    const marks = new Set(segs.map(s => s.start)); for (let b = 0; b < Math.floor(total / 16); b++) marks.add(b * 16);
    const depth = () => { const r = rng(), d = r < 0.27 ? rng.uniform(35, 63) : r < 0.74 ? rng.uniform(64, 95) : rng.uniform(96, 127); return Math.round(127 - A * (127 - d)); };
    for (const m of [...marks].sort((a, b) => a - b)){
      const t0 = m * TPS, up = t0 + msToTicks(clamp(rng.gauss(60, 35), 15, 130) * A + 8, bpm), dn = up + msToTicks(rng.uniform(100, 260) * A + 30, bpm);
      pedal.push([Math.round(up), Math.round(rng.uniform(0, 26) * A)], [Math.round(dn), depth()]);
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
  generate, buildSections, parseCifra, chordGuideFromMidi, vocalFromMidi, suggestChords, vocalEvents, humanize, writeMidi, makeZip, PPQ, TPS, msToTicks, chordName};
})();
if (typeof module !== 'undefined') module.exports = PGM;
