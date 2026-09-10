# Собрать все инструкции в один HTML-файл с картинками внутри: python3 docs/build-html.py
import base64, os, re, markdown

DOCS = os.path.dirname(os.path.abspath(__file__))
FILES = [
    ('process',    '00-process.md',    'Как устроен процесс'),
    ('lidgen',     '01-lidgen.md',     'Для лидогенерации'),
    ('manager',    '02-manager.md',    'Для менеджера'),
    ('supervisor', '03-supervisor.md', 'Для руководителя'),
]

def inline_images(html):
    def rep(m):
        src = m.group(1)
        path = os.path.join(DOCS, src)
        if not os.path.exists(path):
            return m.group(0)
        b64 = base64.b64encode(open(path, 'rb').read()).decode()
        return 'src="data:image/png;base64,%s"' % b64
    return re.sub(r'src="([^"]+)"', rep, html)

md = markdown.Markdown(extensions=['tables', 'fenced_code', 'attr_list'])

sections = []
nav = []
for key, fname, title in FILES:
    text = open(os.path.join(DOCS, fname)).read()
    # внутренние ссылки между файлами -> якоря
    for k2, f2, _ in FILES:
        text = text.replace('(%s)' % f2, '(#%s)' % k2)
    md.reset()
    body = inline_images(md.convert(text))
    sections.append('<section id="%s">%s</section>' % (key, body))
    nav.append('<a href="#%s">%s</a>' % (key, title))

CSS = """
:root{--bg:#fbfaf7;--fg:#2b2620;--dim:#7a7166;--line:#e2ddd3;--acc:#8a6d3b;--soft:#f4f1ea}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
     font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
header{position:sticky;top:0;z-index:5;background:rgba(251,250,247,.96);
       backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
header .in{max-width:900px;margin:0 auto;padding:12px 24px;display:flex;flex-wrap:wrap;gap:6px 18px;align-items:baseline}
header b{font-size:15px;margin-right:8px}
header a{color:var(--acc);text-decoration:none;font-size:14px;padding:3px 0;border-bottom:2px solid transparent}
header a:hover{border-color:var(--acc)}
main{max-width:900px;margin:0 auto;padding:8px 24px 80px}
section{padding-top:28px}
section+section{border-top:1px solid var(--line);margin-top:40px}
h1{font-size:27px;margin:.6em 0 .5em;letter-spacing:-.01em}
h2{font-size:21px;margin:1.7em 0 .6em;padding-bottom:6px;border-bottom:1px solid var(--line)}
h3{font-size:17px;margin:1.4em 0 .4em}
p,li{color:#39332c}
code{background:var(--soft);padding:1px 5px;border-radius:4px;font-size:.9em;
     font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
pre{background:var(--soft);border:1px solid var(--line);border-radius:8px;padding:14px 16px;overflow:auto}
pre code{background:none;padding:0;font-size:13px;line-height:1.5}
img{max-width:100%;border:1px solid var(--line);border-radius:8px;display:block;margin:16px 0;
    box-shadow:0 2px 10px rgba(0,0,0,.05)}
table{border-collapse:collapse;width:100%;margin:16px 0;font-size:15px}
th,td{border:1px solid var(--line);padding:8px 11px;text-align:left;vertical-align:top}
th{background:var(--soft);font-weight:600}
blockquote{margin:16px 0;padding:2px 16px;border-left:3px solid var(--acc);color:var(--dim)}
hr{border:0;border-top:1px solid var(--line);margin:32px 0}
a{color:var(--acc)}
ul{padding-left:22px}
input[type=checkbox]{margin-right:6px}
@media print{header{display:none}section{page-break-before:always}section:first-child{page-break-before:auto}}
"""

html = """<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Контур лидов — инструкции</title><style>%s</style></head><body>
<header><div class="in"><b>Контур лидов</b>%s</div></header>
<main>%s</main></body></html>""" % (CSS, ''.join(nav), '\n'.join(sections))

out = os.path.join(DOCS, 'kontur-lidov-instrukcii.html')
os.makedirs(os.path.dirname(out), exist_ok=True)
open(out, 'w').write(html)
print(out, round(len(html)/1024/1024, 2), 'MB')
