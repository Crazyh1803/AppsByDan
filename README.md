# Apps by Dan

Source for the **Apps by Dan** homepage — a static site that collects the apps,
games, and 3D printing designs I build and give away.

Live at: https://appsbydan.com/

## What's here

| Page | Contents |
|---|---|
| `index.html` | Hero, everything that's shipped, everything in progress |
| `apps.html` | True Shuffle, Manual Bridge, Pantry Logic |
| `games.html` | Gaga Pit Showdown |
| `printing.html` | 3D printing placeholder |
| `about.html` | About Me, the tips model, the note on how the apps get made |

Plain HTML, CSS, and a few lines of vanilla JS. No framework, no build step,
no dependencies — GitHub Pages serves the repo root as-is.

```
assets/css/site.css        every style on the site; tokens live at the top
assets/js/site.js          mobile nav toggle + footer year, nothing else
assets/img/                web-sized artwork (.webp with a .jpg fallback)
tools/optimize_images.py   regenerates assets/img/ from full-size source art
tools/make_app_banners.py  rebuilds the True Shuffle and Manual Bridge banners
.nojekyll                  tells GitHub Pages to skip Jekyll processing
```

Preview locally — use a real server, not `file://`, or the relative paths lie
to you:

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

## Analytics

GoatCounter, loaded from a tag before `</body>` on all six pages. It is
cookieless and collects no personal data, so the site needs no cookie banner -
if that ever changes, the banner question changes with it. Stats are at
https://appsbydan.goatcounter.com.

The tag pins `https://gc.zgo.at/count.js`; GoatCounter's own snippet uses a
protocol-relative `//gc.zgo.at`, which is a leftover from the mixed http/https
era and has no benefit on an https-only site.

## Publishing

The live site is **https://appsbydan.com**, served from the **`gh-pages`**
branch. The `CNAME` file at the repo root is what points the domain at it, so
it must stay on whichever branch Pages publishes — deleting it reverts the site
to the github.io URL. `main` is where the work happens, so a content
change has to reach both:

```sh
git push origin main
git checkout gh-pages && git merge --ff-only main && git push origin gh-pages
git checkout main
```

`.github/workflows/pages.yml` is the alternative deploy route, currently set to
manual trigger only. It needs Pages "Source" switched to GitHub Actions before
it will work; until then `gh-pages` is the one that matters.

## Working on it

**The header and footer are duplicated in all five pages.** That's deliberate —
it keeps the site dependency-free and working with JS off — but it means a
change to the nav or the tip footer has to be made in all five files. Grep
before you edit.

## Adding a new app

Copy an `<article class="card card-live">` block from `apps.html` and fill it
in. Cards that aren't out yet use `card-coming` instead, which gets the dashed
border and the "Coming soon" badge.

Two of the card banners are not hand-made art: True Shuffle's is composed from
that app's own logo, and Manual Bridge's is its repo banner cropped to 16/9.
`tools/make_app_banners.py` rebuilds both full-size, then
`tools/optimize_images.py` turns them into the files the pages load.

## Adding artwork

Put the full-size image anywhere in the repo, add a line to the `JOBS` list in
`tools/optimize_images.py` (the source path is relative to the repo root), then:

```sh
pip install Pillow
python3 tools/optimize_images.py
```

**Replacing existing artwork? Give the output a new name** (`-v2`, `-v3`) and
update the `<picture>` blocks that reference it. Overwriting a file in place
leaves everyone who already visited looking at the old picture out of their
browser cache, with no way to know they should refresh.

It writes a resized `.webp` and a `.jpg` fallback into `assets/img/`, then the
full-size source can be removed from the tree — git history keeps it, and the
site only ever serves the derivatives. Keep banners under ~350 KB — the whole point is that the page stays quick on a phone.
Reference them with a `<picture>` block so browsers pick the smaller file.
