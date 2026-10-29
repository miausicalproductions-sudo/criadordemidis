"""Teoria básica: acordes, escalas, parsing de cifras."""
import re

NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
_FLAT = {'Db': 'C#', 'Eb': 'D#', 'Gb': 'F#', 'Ab': 'G#', 'Bb': 'A#'}

QUALITIES = {          # intervalos a partir da fundamental
    '':     [0, 4, 7],
    'm':    [0, 3, 7],
    '7':    [0, 4, 7, 10],
    'maj7': [0, 4, 7, 11],
    'm7':   [0, 3, 7, 10],
    'sus4': [0, 5, 7],
    'sus2': [0, 2, 7],
}
_ALIASES = {'min': 'm', 'min7': 'm7', 'M7': 'maj7'}

MAJOR = [0, 2, 4, 5, 7, 9, 11]
MINOR = [0, 2, 3, 5, 7, 8, 10]


def pc_of(name):
    name = _FLAT.get(name, name)
    return NAMES.index(name)


def parse_chord(s):
    """'C#m' -> (1, 'm');  'B7' -> (11, '7')."""
    m = re.fullmatch(r'([A-G][#b]?)(maj7|min7|m7|M7|min|m|7|sus4|sus2|)', s.strip())
    if not m:
        raise ValueError(f'acorde inválido: {s!r}')
    q = _ALIASES.get(m.group(2), m.group(2))
    return pc_of(m.group(1)), q


def chord_name(root, q):
    return NAMES[root] + q


def chord_pcs(root, q):
    return [(root + i) % 12 for i in QUALITIES[q]]


def parse_key(s):
    """'E' -> (4,'major');  'C#m' -> (1,'minor')."""
    s = s.strip()
    minor = s.endswith('m') and not s.endswith('maj')
    root = pc_of(s[:-1] if minor else s)
    return root, ('minor' if minor else 'major')


def scale_pcs(key):
    root, mode = key
    return {(root + i) % 12 for i in (MINOR if mode == 'minor' else MAJOR)}
