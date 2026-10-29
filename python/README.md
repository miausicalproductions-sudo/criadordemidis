# Versão em Python (linha de comando)

Primeira versão do motor. A versão principal hoje é a página em `../web`, que faz o mesmo no navegador.

    pip install mido pretty_midi matplotlib
    python -m composer analyze ../references/meu_exemplo.mid
    python -m composer generate --prog "C#m7:4 A:4 E:4 B:4" --key E --seed 7 --out out/minha
    python -m composer recipe out/minha_recipe.json --seed 8

Rode os comandos dentro da pasta `python`. Gera `_grid.mid` (grade exata) e `_human.mid` (humanizado).
Atenção: esta versão ainda não tem a rolagem de acorde ajustável (só a rolagem curta de 4 a 14 ms).
