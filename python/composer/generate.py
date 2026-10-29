"""Gerador simbólico de piano: mão esquerda, mão direita (acordes) e solo.
Tudo é gerado na GRADE EXATA (unidade = semicolcheia = 'step'). A humanização vem depois."""
import math
import random
from dataclasses import dataclass, field
from .theory import parse_chord, chord_pcs, parse_key, scale_pcs, NAMES

STEPS_PER_BAR = 16


@dataclass
class Note:
    start: float        # em steps (semicolcheias)
    dur: float          # em steps
    pitch: int
    vel: int = 64
    track: str = 'rh'   # 'lh' | 'rh' | 'solo'
    group: int = 0      # notas com mesmo group (e track) tocam "juntas" (acorde -> strum)
    role: str = ''      # 'bass' | 'top' | 'inner' | 'melody'


@dataclass
class Segment:
    start: int          # step inicial
    length: int         # steps
    root: int
    quality: str
    name: str


def parse_progression(text, default_beats=4):
    """'C#m7:4 A:4 E B:2' -> segmentos. O número depois de ':' é a duração em BATIDAS."""
    segs, pos = [], 0
    for tok in text.split():
        name, _, b = tok.partition(':')
        beats = float(b) if b else default_beats
        length = int(round(beats * 4))
        r, q = parse_chord(name)
        segs.append(Segment(pos, length, r, q, name))
        pos += length
    return segs


def seg_at(segs, step):
    for s in segs:
        if s.start <= step < s.start + s.length:
            return s
    return segs[-1]


# ---------- vozes ----------
def _nearest(pc, around, lo, hi):
    c = [p for p in range(lo, hi + 1) if p % 12 == pc]
    return min(c, key=lambda p: abs(p - around))


def voice_rh(seg, prev, lo=57, hi=76):
    """Escolhe a inversão do acorde que se move menos em relação ao anterior (voice leading)."""
    pcs = chord_pcs(seg.root, seg.quality)
    cands = []
    for rot in range(len(pcs)):
        order = pcs[rot:] + pcs[:rot]
        for base in range(lo, lo + 12):
            notes, cur = [], base - 1
            for pc in order:
                p = cur + 1
                while p % 12 != pc: p += 1
                notes.append(p); cur = p
            if notes[0] >= lo and notes[-1] <= hi:
                cands.append(notes)
    if not cands:
        return [_nearest(pc, 64, lo, hi) for pc in pcs]
    if prev is None:
        target = 64
        return min(cands, key=lambda n: abs(sum(n) / len(n) - target))
    pm = sum(prev) / len(prev)
    return min(cands, key=lambda n: abs(sum(n) / len(n) - pm) + 0.3 * abs(n[-1] - prev[-1]))


def lh_notes(seg):
    root = _nearest(seg.root, 40, 36, 47)
    fifth = root + 7
    return dict(root=root, fifth=fifth, oct=root + 12, tenth=root + (3 if seg.quality.startswith('m') else 4) + 12)


# ---------- ritmo ----------
def sample_hits(prob, rng, density, force0=True, min_gap=2):
    """Sorteia posições (0..15) a partir de um perfil de probabilidade, com densidade alvo."""
    tot = sum(prob) or 1
    p = [density * 16 * x / tot for x in prob]
    hits = []
    for i in range(16):
        if rng.random() < min(0.95, p[i]) and (not hits or i - hits[-1] >= min_gap):
            hits.append(i)
    if force0 and 0 not in hits:
        hits = [0] + [h for h in hits if h >= min_gap]
    return hits


def mutate(hits, rng):
    h = set(hits)
    r = rng.random()
    cands = [i for i in range(1, 16) if i not in h]
    if r < 0.5 and cands:
        h.add(rng.choice(cands))
    elif len(h) > 2:
        h.discard(rng.choice([x for x in h if x != 0]))
    out = []
    for x in sorted(h):
        if not out or x - out[-1] >= 2:
            out.append(x)
    return out


TEMPLATES = {   # posições por compasso (balada)
    'lh': [[0, 6, 8, 12], [0, 8, 10, 12], [0, 4, 8, 12]],
    'rh': [[0, 8], [0, 6, 8, 14], [0, 3, 6, 8, 11, 14]],
}


def bar_patterns(nbars, prof, rng, rhythm, lh_density, rh_density):
    """Padrão de 2 compassos (A, A') que se repete com pequenas mutações; fill a cada 4."""
    pats = {'lh': [], 'rh': []}
    for hand, key, dens in (('lh', 'onset_prob_low', lh_density), ('rh', 'onset_prob_high', rh_density)):
        base = None
        for b in range(nbars):
            if b % 2 == 0:
                if rhythm == 'learned' and prof:
                    base = sample_hits(prof[key], rng, dens, min_gap=2 if hand == 'lh' else 3)
                else:
                    base = list(rng.choice(TEMPLATES[hand]))
                cur = base
            else:
                cur = mutate(base, rng) if rng.random() < 0.7 else list(base)
            if b % 4 == 3 and hand == 'lh' and 14 not in cur:   # anticipação no fim da frase
                cur = sorted(set(cur) | {14})
            pats[hand].append(cur)
    return pats


# ---------- acompanhamento ----------
def gen_comping(segs, total_steps, rng, prof=None, rhythm='learned', lh_density=0.28, rh_density=0.22):
    nbars = (total_steps + 15) // 16
    pats = bar_patterns(nbars, prof, rng, rhythm, lh_density, rh_density)
    notes, grp = [], 0
    prev_voicing, seg_voicing = None, {}
    # LH
    roles = ['root', 'fifth', 'oct', 'fifth']
    for b in range(nbars):
        hits = [h for h in pats['lh'][b] if b * 16 + h < total_steps]
        for k, h in enumerate(hits):
            g = b * 16 + h
            seg = seg_at(segs, g)
            ln = lh_notes(seg)
            first_in_seg = (g == seg.start) or (k == 0 and h == 0)
            role = 'root' if (first_in_seg or g == seg.start) else roles[k % len(roles)]
            end = hits[k + 1] + b * 16 if k + 1 < len(hits) else (b + 1) * 16
            end = min(end, seg.start + seg.length)
            if role == 'root' and (g == seg.start or h == 0):
                p = [ln['root'], ln['root'] + 12]            # oitava na fundamental forte
            else:
                p = [ln[role]]
            grp += 1
            for i, pitch in enumerate(p):
                notes.append(Note(g, max(1.0, end - g), pitch, track='lh', group=grp,
                                  role='bass' if i == 0 else 'inner'))
    # RH (acordes sustentados até o próximo ataque)
    for b in range(nbars):
        hits = [h for h in pats['rh'][b] if b * 16 + h < total_steps]
        for k, h in enumerate(hits):
            g = b * 16 + h
            seg = seg_at(segs, g)
            if seg.start not in seg_voicing:
                seg_voicing[seg.start] = voice_rh(seg, prev_voicing)
                prev_voicing = seg_voicing[seg.start]
            v = seg_voicing[seg.start]
            end = hits[k + 1] + b * 16 if k + 1 < len(hits) else (b + 1) * 16
            end = min(end, seg.start + seg.length)
            grp += 1
            for i, pitch in enumerate(v):
                notes.append(Note(g, max(1.0, end - g), pitch, track='rh', group=grp,
                                  role='top' if i == len(v) - 1 else 'inner'))
    return notes


# ---------- solo ----------
CELLS = [   # células rítmicas de 1 compasso: (step, dur)
    [(0, 4), (4, 2), (6, 2), (8, 4), (12, 4)],
    [(0, 2), (2, 2), (4, 4), (8, 2), (10, 2), (12, 4)],
    [(2, 2), (4, 2), (6, 4), (10, 2), (12, 2), (14, 2)],
    [(0, 6), (6, 2), (8, 8)],
    [(0, 3), (3, 3), (6, 2), (8, 4), (12, 2), (14, 2)],
    [(0, 2), (2, 2), (4, 2), (6, 2), (8, 2), (10, 2), (12, 4)],
]


def gen_solo(segs, total_steps, key, rng, start_bar=0, lo=67, hi=86, rest_prob=0.25):
    scale = sorted(p for p in range(lo, hi + 1) if p % 12 in scale_pcs(key))
    notes, grp = [], 1000
    nbars = (total_steps + 15) // 16
    cur = min(scale, key=lambda p: abs(p - 76))
    b = start_bar
    while b < nbars:
        phrase_len = 2
        cell_a = rng.choice(CELLS)
        cell_b = rng.choice(CELLS)
        # arco melódico: sobe nos 2 primeiros compassos de cada 4, desce depois
        drift = 1 if (b // 2) % 2 == 0 else -1
        for pb in range(phrase_len):
            bar = b + pb
            if bar >= nbars: break
            cell = cell_a if pb == 0 else (cell_a if rng.random() < 0.4 else cell_b)
            for ci, (st_, d) in enumerate(cell):
                g = bar * 16 + st_
                if g >= total_steps: break
                last = (pb == phrase_len - 1 and ci == len(cell) - 1)
                if not last and rng.random() < rest_prob * (0.5 if st_ % 4 == 0 else 1.0):
                    continue
                seg = seg_at(segs, g)
                ct = set(chord_pcs(seg.root, seg.quality))
                # passo melódico
                r = rng.random()
                if r < 0.18:   step_ = 0
                elif r < 0.68: step_ = rng.choice([-1, 1])
                elif r < 0.9:  step_ = rng.choice([-2, 2])
                else:          step_ = rng.choice([-4, -3, 3, 4])
                target = 77 + 4 * math.sin(b * 0.65)          # centro do registro faz um arco suave
                bias = 1 if cur < target - 3 else (-1 if cur > target + 3 else 0)
                if bias and step_ and rng.random() < 0.55:    # puxa de volta ao centro
                    step_ = abs(step_) * bias
                i = scale.index(cur) + step_
                i = max(0, min(len(scale) - 1, i))
                p = scale[i]
                strong = st_ % 8 == 0 or last
                if strong and p % 12 not in ct:             # nota-alvo: tom do acorde
                    cands = [x for x in scale if x % 12 in ct]
                    p = min(cands, key=lambda x: abs(x - p))
                if last:                                    # termina em fundamental/terça
                    tgt = [x for x in scale if x % 12 in (seg.root, (seg.root + (3 if seg.quality.startswith('m') else 4)) % 12)]
                    p = min(tgt, key=lambda x: abs(x - p))
                cur = p
                d_eff = d + (2 if last and d < 4 else 0)
                grp += 1
                notes.append(Note(g, d_eff, p, track='solo', group=grp, role='melody'))
        b += phrase_len
        # pausa entre frases (pergunta/resposta): 1 compasso de respiro a cada 2 frases
        if (b // 2) % 2 == 0:
            b += 1
    return notes


def generate(prog_text, key_text, seed, profile=None, rhythm='learned', solo=True,
             solo_start_bar=2, repeats=1, lh_density=0.28, rh_density=0.22):
    rng = random.Random(seed)
    segs = parse_progression(prog_text)
    # repete a progressão
    if repeats > 1:
        L = sum(s.length for s in segs)
        segs = [Segment(s.start + k * L, s.length, s.root, s.quality, s.name)
                for k in range(repeats) for s in segs]
    total = segs[-1].start + segs[-1].length
    key = parse_key(key_text)
    notes = gen_comping(segs, total, rng, profile, rhythm, lh_density, rh_density)
    if solo:
        notes += gen_solo(segs, total, key, rng, start_bar=solo_start_bar)
    return notes, segs, total
