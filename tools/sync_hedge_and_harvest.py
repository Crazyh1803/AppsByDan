#!/usr/bin/env python3
"""Copy a tested game checkout and version its browser assets by content hash."""
import hashlib
from pathlib import Path
import re
import subprocess
import sys


def main():
    source = Path(sys.argv[1]).resolve()
    root = Path(__file__).resolve().parent.parent
    destination = root / 'hedge-and-harvest'
    names = ('index.html', 'styles.css', 'game.js', 'audio.js', 'favicon.svg')
    files = {name: (source / name).read_bytes() for name in names}
    revision = subprocess.check_output(
        ['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
    html = files['index.html'].decode('utf-8')
    for name in names[1:]:
        digest = hashlib.sha256(files[name]).hexdigest()[:12]
        html, count = re.subn(
            r'((?:src|href)=")' + re.escape(name) + r'(?:\?[^"\s]*)?"',
            lambda match: match[1] + name + '?v=' + digest + '"', html)
        if count != 1:
            raise ValueError(f'Expected one reference to {name}, found {count}')
    files['index.html'] = html.encode('utf-8')
    destination.mkdir(exist_ok=True)
    for name, data in files.items():
        (destination / name).write_bytes(data)
    readme = root / 'README.md'
    content, count = re.subn(r'commit `[0-9a-f]{40}`', f'commit `{revision}`', readme.read_text())
    if count != 1:
        raise ValueError('Expected one source revision in README.md')
    readme.write_text(content)
    print(f'Synced Hedge and Harvest {revision}; asset URLs use content hashes.')


if __name__ == '__main__':
    main()
