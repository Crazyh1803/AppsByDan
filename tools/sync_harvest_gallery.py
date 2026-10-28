#!/usr/bin/env python3
"""Embed approved gallery JSON as HTML so published artwork needs no JS request."""
import json
import re
from html import escape
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
data = json.loads((ROOT / 'assets/data/harvest-gallery.json').read_text())
cards = []
for entry in data['creations']:
    image = entry['image']
    if not re.fullmatch(r'assets/img/[a-zA-Z0-9_-]+\.(webp|jpg|jpeg|png)', image):
        raise ValueError('Gallery images must be local approved artwork')
    if not (ROOT / image).is_file():
        raise FileNotFoundError(image)
    cards.append(f'''        <article class="card">
          <img src="{escape(image, quote=True)}" alt="{escape(entry.get('alt') or entry['title'], quote=True)}" loading="lazy" decoding="async">
          <div class="card-body">
            <h3>{escape(entry['title'])}</h3>
            <p>Grown by {escape(entry['credit'])}</p>
            <p>{escape(entry.get('description', ''))}</p>
          </div>
        </article>''')
page = ROOT / 'hedge-and-harvest-gallery.html'
source = page.read_text()
source, count = re.subn(r'        <!-- BEGIN APPROVED CREATIONS -->.*?        <!-- END APPROVED CREATIONS -->', lambda _: '        <!-- BEGIN APPROVED CREATIONS -->\n' + '\n'.join(cards) + '\n        <!-- END APPROVED CREATIONS -->', source, flags=re.S)
if count != 1:
    raise ValueError('Expected exactly one approved creations block')
source = re.sub(r'<div id="gallery-empty" class="harvest-empty"(?: hidden)?>', '<div id="gallery-empty" class="harvest-empty"' + (' hidden' if cards else '') + '>', source)
page.write_text(source)
print(f'Embedded {len(cards)} approved creations.')
