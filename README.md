# Apps by Dan

Source for the **Apps by Dan** homepage — a static site that collects the apps,
games, and 3D printing designs I build and give away.

Live at: https://crazyh1803.github.io/AppsByDan/

## What's here

| Page | Contents |
|---|---|
| `index.html` | Hero, everything that's shipped, everything in progress, About Me |
| `apps.html` | True Shuffle, Manual Bridge, Pantry Logic |
| `games.html` | Gaga Pit Showdown |
| `printing.html` | 3D printing placeholder |

Plain HTML, CSS, and a few lines of vanilla JS. No framework, no build step,
no dependencies — GitHub Pages serves the repo root as-is.

```
assets/css/site.css        every style on the site; tokens live at the top
assets/js/site.js          mobile nav toggle + footer year, nothing else
assets/img/                web-sized artwork (.webp with a .jpg fallback)
tools/optimize_images.py   regenerates assets/img/ from full-size source art
.nojekyll                  tells GitHub Pages to skip Jekyll processing
```

## Working on it

Preview locally — use a real server, not `file://`, or the relative paths lie
to you:

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

**The header and footer are duplicated in all four pages.** That's deliberate —
it keeps the site dependency-free and working with JS off — but it means a
change to the nav or the tip footer has to be made in all four files. Grep
before you edit.

## Adding a new app

Copy an `<article class="card card-live">` block from `apps.html` and fill it
in. Cards that aren't out yet use `card-coming` instead, which gets the dashed
border and the "Coming soon" badge.

## Adding artwork

Drop the full-size image in the repo root, add a line to the `JOBS` list in
`tools/optimize_images.py`, then:

```sh
pip install Pillow
python3 tools/optimize_images.py
```

It writes a resized `.webp` and a `.jpg` fallback into `assets/img/`. Keep
banners under ~350 KB — the whole point is that the page stays quick on a phone.
Reference them with a `<picture>` block so browsers pick the smaller file.
