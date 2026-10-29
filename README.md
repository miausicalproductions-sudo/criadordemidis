# Criador de MIDIs

Gerador simbólico de piano: você define os acordes e a duração de cada um, e ele cria acompanhamento (mão esquerda e mão direita) e solo em **MIDI editável**, com humanização (velocity, microtiming, rolagem do acorde, pedal de sustain). A ideia é parecido com gerar música por IA, mas cada nota continua sua para trocar no FL Studio ou no Reaper.

## Como funciona

1. **Referências:** você carrega MIDIs de piano de que gosta. O sistema lê o andamento, o tom, os acordes e a chance de ataque em cada semicolcheia do compasso, separada por mão. Esse perfil dá o groove.
2. **Geração na grade exata:** com seus acordes, ele sorteia (com seed, então reproduzível) os padrões de mão esquerda, os acordes da mão direita com voice leading e frases de solo com notas-alvo no acorde.
3. **Humanização por cima:** velocity por posição no compasso e por frase, desvio de timing limitado (nunca acumula), rolagem do acorde (notas entrando uma depois da outra), durações com legato variável e pedal CC64.
4. **Exportação:** um MIDI humanizado e um na grade exata, cada um com três faixas (mão esquerda, mão direita, solo).

## Pastas

- `web/` — a página (JavaScript, roda inteira no navegador). `src/engine.js` é o motor, `src/page.html` a interface, `build.py` junta os dois em `dist/page.html`.
- `python/` — a primeira versão em linha de comando.
- `references/` — seus MIDIs de exemplo (**não sobem para o GitHub**).

## Limites conhecidos

- O ritmo aprendido é só tão bom quanto as referências. MIDIs transcritos de áudio por IA têm timing e velocity pouco confiáveis; MIDIs tocados num teclado são melhores.
- O solo ainda é simples e tende a soar mecânico.
- Ainda não há baixo, bateria e outras linhas.

## Rodando o teste do motor

    cd web
    node tests/engine.test.js ../references/meu_exemplo.mid
