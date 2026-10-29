"""Exporta MIDI com uma faixa por mão/linha (fácil de arrastar para instrumentos diferentes)."""
import mido
from .humanize import PPQ, TICKS_PER_STEP

TRACK_NAMES = {'lh': 'Piano - mao esquerda', 'rh': 'Piano - mao direita', 'solo': 'Piano - solo'}
CHANNEL = {'lh': 0, 'rh': 1, 'solo': 2}


def write_midi(path, events, pedal, bpm, key_text, total_steps, ts=(4, 4), title='Composer'):
    m = mido.MidiFile(type=1, ticks_per_beat=PPQ)
    cond = mido.MidiTrack()
    cond.append(mido.MetaMessage('track_name', name=title, time=0))
    cond.append(mido.MetaMessage('set_tempo', tempo=mido.bpm2tempo(bpm), time=0))
    cond.append(mido.MetaMessage('time_signature', numerator=ts[0], denominator=ts[1], time=0))
    try:
        cond.append(mido.MetaMessage('key_signature', key=key_text, time=0))
    except Exception:
        pass
    m.tracks.append(cond)
    for trk in ('lh', 'rh', 'solo'):
        evs = [e for e in events if e[4] == trk]
        if not evs:
            continue
        t = mido.MidiTrack()
        t.append(mido.MetaMessage('track_name', name=TRACK_NAMES[trk], time=0))
        ch = CHANNEL[trk]
        msgs = []
        for on, off, p, v, _ in evs:
            msgs.append((on, 2, mido.Message('note_on', channel=ch, note=p, velocity=v)))
            msgs.append((off, 0, mido.Message('note_off', channel=ch, note=p, velocity=0)))
        for tk, val in pedal:
            msgs.append((tk, 1, mido.Message('control_change', channel=ch, control=64, value=val)))
        msgs.sort(key=lambda x: (x[0], x[1]))     # off antes de on no mesmo tick
        last = 0
        for tk, _, msg in msgs:
            t.append(msg.copy(time=max(0, tk - last))); last = max(last, tk)
        t.append(mido.MetaMessage('end_of_track', time=PPQ))
        m.tracks.append(t)
    m.save(path)
