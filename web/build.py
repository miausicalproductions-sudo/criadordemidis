"""Monta web/dist/page.html juntando src/page.html + src/engine.js.
Uso (dentro da pasta web):  python3 build.py
Gera também dist/test.html (com <html>/<body>) para abrir direto no navegador."""
import os
here = os.path.dirname(os.path.abspath(__file__))
rd = lambda p: open(os.path.join(here, p), encoding='utf-8').read()
eng = rd('src/engine.js').replace("if (typeof module !== 'undefined') module.exports = PGM;", "")
page = rd('src/page.html').replace('/*ENGINE*/', eng)
os.makedirs(os.path.join(here, 'dist'), exist_ok=True)
open(os.path.join(here, 'dist/page.html'), 'w', encoding='utf-8').write(page)
open(os.path.join(here, 'dist/test.html'), 'w', encoding='utf-8').write(
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>' + page + '</body></html>')
print('ok', len(page), 'bytes')
