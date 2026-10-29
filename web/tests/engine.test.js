// Teste do motor no Node:  node tests/engine.test.js caminho/do/arquivo.mid
// Lê o MIDI, analisa, gera e escreve tests/out_grid.mid e tests/out_human.mid (ignorados pelo git).
const E = require('../src/engine.js'), fs = require('fs'), path = require('path');
const ref = process.argv[2];
let prof = null;
if (ref){ const a = E.analyzeMidi(path.basename(ref), fs.readFileSync(ref)); prof = E.aggregateProfile([a]); console.log('analisado:', a.nNotes, 'notas,', a.bars, 'compassos,', a.bpm, 'BPM, tom', a.key); }
const o = {prog: 'C#m7:4 A:4 E:4 B:4', key: 'E', seed: 7, repeats: 2, rhythm: 'learned', profile: prof, solo: true, soloStartBar: 2, lhDensity: .28, rhDensity: .22};
const g = E.generate(o);
for (const [tag, amt] of [['grid', 0], ['human', 1]]){
  const h = E.humanize(g.notes, g.segs, 106.4, g.total, 7, {amount: amt, timingSd: 6, timingMax: 22, velJitter: 4, strumMs: 28, strumDir: 'mix', pedal: true});
  fs.writeFileSync(path.join(__dirname, `out_${tag}.mid`), E.writeMidi(h.events, h.pedal, 106.4, 'E', 'seed 7'));
  console.log(tag, h.events.length, 'eventos');
}
const z = E.makeZip([{name: 'a.txt', data: new TextEncoder().encode('ok')}]);
console.log('zip', z.length, 'bytes');
