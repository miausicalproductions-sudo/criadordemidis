import argparse, json, os, sys
from .analyze import analyze
from .generate import generate
from .humanize import humanize, HumanCfg
from .export import write_midi


def main(argv=None):
    ap = argparse.ArgumentParser(prog='composer', description='Gerador simbólico de piano -> MIDI humanizado')
    sub = ap.add_subparsers(dest='cmd', required=True)
    a = sub.add_parser('analyze', help='analisa um MIDI de referência')
    a.add_argument('midi'); a.add_argument('--out', default='out/analysis')
    g = sub.add_parser('generate', help='gera música')
    g.add_argument('--prog', default='C#m7:4 A:4 E:4 B:4', help='ex: "C#m7:4 A:4 E:2 B:2"  (número = batidas)')
    g.add_argument('--key', default='E')
    g.add_argument('--bpm', type=float, default=106.4)
    g.add_argument('--repeats', type=int, default=2)
    g.add_argument('--seed', type=int, default=1)
    g.add_argument('--profile', default='out/analysis/profile.json')
    g.add_argument('--rhythm', choices=['learned', 'template'], default='learned')
    g.add_argument('--no-solo', action='store_true')
    g.add_argument('--solo-start-bar', type=int, default=2)
    g.add_argument('--human', type=float, default=1.0, help='0=grade exata, 1=padrão, 2=solto')
    g.add_argument('--out', default='out/song')
    r = sub.add_parser('recipe', help='regenera a partir de um recipe.json')
    r.add_argument('recipe'); r.add_argument('--seed', type=int)
    args = ap.parse_args(argv)

    if args.cmd == 'analyze':
        p = analyze(args.midi, args.out)
        print(json.dumps({k: v for k, v in p.items() if k != 'chords_per_bar'}, indent=1))
        print('acordes por compasso:', ' '.join(p['chords_per_bar']))
        return
    if args.cmd == 'recipe':
        rec = json.load(open(args.recipe))
        if args.seed is not None: rec['seed'] = args.seed
        return run(rec)
    rec = dict(prog=args.prog, key=args.key, bpm=args.bpm, repeats=args.repeats, seed=args.seed,
               profile=args.profile, rhythm=args.rhythm, solo=not args.no_solo,
               solo_start_bar=args.solo_start_bar, human=args.human, out=args.out)
    run(rec)


def run(rec):
    prof = json.load(open(rec['profile'])) if rec.get('profile') and os.path.exists(rec['profile']) else None
    notes, segs, total = generate(rec['prog'], rec['key'], rec['seed'], prof, rec['rhythm'],
                                  rec['solo'], rec['solo_start_bar'], rec['repeats'])
    os.makedirs(os.path.dirname(rec['out']) or '.', exist_ok=True)
    kt = rec['key']
    for tag, amt in (('grid', 0.0), ('human', rec['human'])):
        cfg = HumanCfg(amount=amt)
        ev, ped = humanize(notes, segs, rec['bpm'], total, rec['seed'], cfg)
        write_midi(f"{rec['out']}_{tag}.mid", ev, ped, rec['bpm'], kt, total, title=f"seed {rec['seed']}")
        print('escreveu', f"{rec['out']}_{tag}.mid", f'({len(ev)} notas)')
    json.dump(rec, open(f"{rec['out']}_recipe.json", 'w'), indent=1)
    print('receita:', f"{rec['out']}_recipe.json")
