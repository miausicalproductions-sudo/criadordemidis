"""Analisa um MIDI de referência: limpa, quantiza, detecta acordes, extrai perfil rítmico."""
import json, collections, statistics as st
import mido
from .theory import NAMES, QUALITIES, chord_name, chord_pcs

SCORE_Q = ['', 'm', '7', 'm7']       # qualidades consideradas na detecção


def load_notes(path):
    """Retorna (notas, ppq, bpm, (num, den)). Nota = dict(start, end, pitch, vel) em ticks."""
    m = mido.MidiFile(path)
    ppq = m.ticks_per_beat
    bpm, ts = 120.0, (4, 4)
    notes = []
    for tr in m.tracks:
        t, on = 0, {}
        for e in tr:
            t += e.time
            if e.type == 'set_tempo' and bpm == 120.0:
                bpm = mido.tempo2bpm(e.tempo)
            elif e.type == 'time_signature':
                ts = (e.numerator, e.denominator)
            elif e.type == 'note_on' and e.velocity > 0:
                on.setdefault(e.note, []).append((t, e.velocity))
            elif e.type in ('note_off', 'note_on') and on.get(e.note):
                s, v = on[e.note].pop(0)
                notes.append(dict(start=s, end=t, pitch=e.note, vel=v))
    notes.sort(key=lambda n: (n['start'], n['pitch']))
    return notes, ppq, bpm, ts


def clean(notes, ppq, min_dur=1/16, max_dur=8.0):
    """Remove notas minúsculas/duplicadas e limita durações absurdas (em beats)."""
    out, seen = [], set()
    for n in notes:
        d = (n['end'] - n['start']) / ppq
        if d < min_dur:
            continue
        key = (n['start'], n['pitch'])
        if key in seen:
            continue
        seen.add(key)
        n = dict(n)
        n['end'] = n['start'] + int(min(d, max_dur) * ppq)
        out.append(n)
    return out


def quantize(notes, ppq, div=4):
    """Quantiza onsets para 1/(4*div)... div=4 => semicolcheia. Guarda o desvio original (em steps)."""
    step = ppq / div
    out = []
    for n in notes:
        s = round(n['start'] / step)
        e = max(s + 1, round(n['end'] / step))
        dev = n['start'] / step - s
        out.append(dict(n, qstart=s, qend=e, dev=dev))
    return out


def detect_chords(notes, ppq, beats_per_bar=4):
    """Um acorde por compasso (por peso de duração + baixo). Devolve lista de nomes (ou None)."""
    bar = ppq * beats_per_bar
    nbars = max(n['end'] for n in notes) // bar + 1
    res, prev = [], None
    for b in range(nbars):
        lo, hi = b * bar, (b + 1) * bar
        w, bass, tot = [0.0] * 12, None, 0.0
        inbar = [n for n in notes if n['start'] < hi and n['end'] > lo]
        if len(inbar) < 2:
            res.append(prev)
            continue
        for n in inbar:
            ov = min(n['end'], hi) - max(n['start'], lo)
            w[n['pitch'] % 12] += ov; tot += ov
        low = min((n for n in inbar if lo <= n['start'] < hi), key=lambda n: n['pitch'], default=None)
        bass = low['pitch'] % 12 if low else None
        best, best_s = None, -1e9
        for r in range(12):
            for q in SCORE_Q:
                pcs = set(chord_pcs(r, q))
                s = sum(w[p] for p in pcs) - 0.7 * sum(w[p] for p in range(12) if p not in pcs)
                if bass == r: s += 0.25 * tot
                if q in ('7', 'm7'): s -= 0.15 * tot
                if s > best_s: best, best_s = chord_name(r, q), s
        res.append(best); prev = best
    # preenche início vazio
    first = next((c for c in res if c), None)
    return [c or first for c in res]


def profile(qnotes, ppq, bpm, split=60, grid=16):
    """Probabilidade de onset por posição de semicolcheia no compasso, por registro."""
    nbars = max(1, max(n['qstart'] for n in qnotes) // grid + 1)

    def hist(sel):
        onsets = sorted({n['qstart'] for n in sel})      # acorde = 1 onset
        c = collections.Counter(s % grid for s in onsets)
        return [round(c.get(i, 0) / nbars, 4) for i in range(grid)]
    lo = [n for n in qnotes if n['pitch'] < split]
    hi = [n for n in qnotes if n['pitch'] >= split]
    durs = [(n['qend'] - n['qstart']) for n in qnotes]
    return dict(
        bpm=round(bpm, 2),
        onset_prob_low=hist(lo), onset_prob_high=hist(hi),
        median_dur_steps=st.median(durs),
        mean_abs_dev_steps=round(st.mean(abs(n['dev']) for n in qnotes), 3),
        dev_sd_steps=round(st.pstdev([n['dev'] for n in qnotes]), 3),
        pitch_range=[min(n['pitch'] for n in qnotes), max(n['pitch'] for n in qnotes)],
    )


def write_quantized(qnotes, ppq, bpm, path):
    """MIDI limpo/quantizado na grade (para você abrir no DAW e comparar)."""
    m = mido.MidiFile(ticks_per_beat=480)
    c, t = mido.MidiTrack(), mido.MidiTrack()
    c.append(mido.MetaMessage('set_tempo', tempo=mido.bpm2tempo(bpm)))
    m.tracks += [c, t]
    step = 480 // 4
    ev = []
    for n in qnotes:
        ev.append((n['qstart'] * step, 1, mido.Message('note_on', note=n['pitch'], velocity=n['vel'])))
        ev.append((n['qend'] * step, 0, mido.Message('note_off', note=n['pitch'], velocity=0)))
    ev.sort(key=lambda x: (x[0], x[1]))
    last = 0
    for tk, _, msg in ev:
        t.append(msg.copy(time=tk - last)); last = tk
    m.save(path)


def analyze(path, out_dir):
    import os
    os.makedirs(out_dir, exist_ok=True)
    notes, ppq, bpm, ts = load_notes(path)
    cn = clean(notes, ppq)
    q = quantize(cn, ppq)
    chords = detect_chords(cn, ppq, ts[0])
    prof = profile(q, ppq, bpm)
    prof['chords_per_bar'] = chords
    prof['n_notes_raw'], prof['n_notes_clean'] = len(notes), len(cn)
    with open(f'{out_dir}/profile.json', 'w') as f:
        json.dump(prof, f, indent=1)
    write_quantized(q, ppq, bpm, f'{out_dir}/reference_quantized.mid')
    return prof
