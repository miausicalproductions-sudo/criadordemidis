"""Camada de humanização. Parte SEMPRE da grade exata; os desvios são limitados e não acumulam."""
import math, random
from dataclasses import dataclass, field

PPQ = 480
TICKS_PER_STEP = PPQ // 4


@dataclass
class HumanCfg:
    amount: float = 1.0            # 0 = grade exata, 1 = padrão, 2 = bem solto
    timing_sd_ms: float = 6.0      # desvio-padrão do microtiming
    timing_max_ms: float = 22.0    # teto: nunca erra além disso
    lh_early_ms: float = 4.0       # mão esquerda levemente adiantada
    solo_late_ms: float = 8.0      # solo levemente "atrás" do tempo (laid back)
    strum_ms: tuple = (4.0, 14.0)  # espalhamento do acorde, grave -> agudo
    vel_base: dict = field(default_factory=lambda: {'lh': 54, 'rh': 62, 'solo': 84})
    vel_jitter: float = 4.0
    legato: tuple = (0.88, 1.0)    # fração da duração que a nota realmente sustenta
    pedal: bool = True


def ms_to_ticks(ms, bpm):
    return ms * bpm * PPQ / 60000.0


def _accent(step_in_bar):
    if step_in_bar == 0: return 9
    if step_in_bar == 8: return 5
    if step_in_bar % 4 == 0: return 2
    if step_in_bar % 2 == 0: return -1
    return -4                      # contratempos finos mais leves


def humanize(notes, segs, bpm, total_steps, seed, cfg=None):
    """Devolve lista de eventos: (tick_on, tick_off, pitch, vel, track) e eventos de pedal."""
    cfg = cfg or HumanCfg()
    rng = random.Random(seed * 7919 + 13)
    A = cfg.amount
    events = []
    # strum por grupo: ordem grave->agudo com atraso crescente
    groups = {}
    for n in notes:
        groups.setdefault((n.track, n.group), []).append(n)
    group_strum = {k: rng.uniform(*cfg.strum_ms) * A for k in groups}
    for (trk, gid), ns in groups.items():
        ns.sort(key=lambda n: n.pitch)
        size = len(ns)
        # deslocamento do grupo (compartilhado: o acorde "inteiro" cai junto)
        off_ms = rng.gauss(0, cfg.timing_sd_ms) * A
        if trk == 'lh': off_ms -= cfg.lh_early_ms * A
        if trk == 'solo': off_ms += cfg.solo_late_ms * A
        for i, n in enumerate(ns):
            sib = 0.0 if size == 1 else group_strum[(trk, gid)] * i / (size - 1)
            o = max(-cfg.timing_max_ms, min(cfg.timing_max_ms, off_ms + rng.gauss(0, 1.2) * A)) + sib
            on = n.start * TICKS_PER_STEP + ms_to_ticks(o, bpm)
            # velocidade
            sib_bar = int(n.start) % 16
            bar = int(n.start) // 16
            contour = 6 * math.sin(2 * math.pi * (n.start / (16 * 4)))      # respira a cada 4 compassos
            v = cfg.vel_base[trk] + A * (_accent(sib_bar) + contour)
            if n.role == 'top': v += 4 * A
            elif n.role == 'inner' and trk == 'rh': v -= 3 * A
            elif n.role == 'bass': v += 3 * A
            if trk == 'solo':
                v += (n.pitch - 76) * 0.5 * A                              # notas agudas um pouco mais fortes
                v += min(8, n.dur) * 0.6 * A                               # notas longas soam mais "cantadas"
            v += rng.gauss(0, cfg.vel_jitter) * A
            if A == 0: v = cfg.vel_base[trk]
            v = int(max(18, min(121, round(v))))
            # duração (legato variável); a nota nunca atravessa o ataque do próximo no mesmo registro
            lg = 1.0 if A == 0 else rng.uniform(*cfg.legato)
            off_t = (n.start + n.dur * lg) * TICKS_PER_STEP + ms_to_ticks(
                rng.gauss(0, cfg.timing_sd_ms * 0.7) * A, bpm)
            off_t = max(off_t, on + ms_to_ticks(45, bpm))
            events.append((int(round(max(0, on))), int(round(off_t)), n.pitch, v, trk))
    # pedal: sobe logo depois do novo baixo, desce de novo em seguida (pedal sincopado)
    pedal = []
    if cfg.pedal:
        marks = sorted({s.start for s in segs} | {b * 16 for b in range(total_steps // 16)})
        for m in marks:
            t0 = m * TICKS_PER_STEP
            up = t0 + ms_to_ticks(rng.uniform(12, 30) * A + 8, bpm)
            dn = up + ms_to_ticks(rng.uniform(35, 70) * A + 20, bpm)
            pedal += [(int(up), 0), (int(dn), 127)]
        pedal.insert(0, (0, 127))
        pedal.append((total_steps * TICKS_PER_STEP + 10, 0))
    return events, pedal
