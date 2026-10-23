# Maintaining this site

Handover notes for whoever (or whatever) works on this repo next. The `README`
covers day-to-day tasks; this file covers how the pieces fit together and, more
importantly, **what breaks if you get it wrong**.

Read the Invariants and Landmines sections before your first change. Most of
them record something that already went wrong once.

---

## What this is

A five-page static marketing site for "Apps by Dan" — a one-person shop that
publishes small free apps and games and asks for tips rather than charging.

**Plain HTML, CSS and ~28 lines of vanilla JS. No framework, no build step, no
package manager, no backend.** Editing a `.html` file and pushing is the entire
deploy process. Keep it that way unless there's a reason not to; the simplicity
is the point, and it's what makes the site portable between hosts.

There are no forms, no cookies and no server-side anything. That rules out whole
categories of change: anything requiring a database, a form handler, session
state or a cookie banner is not possible here without first adding a backend.

---

## Live site and hosting

| | |
|---|---|
| **Live URL** | https://appsbydan.com |
| **Host** | GitHub Pages, branch-based (not the Actions deploy path) |
| **Repo** | `Crazyh1803/AppsByDan` |
| **Publishing branch** | `gh-pages` |
| **Working branch** | `main` |
| **Domain** | Registered separately; `CNAME` at repo root points Pages at it |

The site previously lived at `crazyh1803.github.io/AppsByDan/` — a sub-path.
It now serves from the **root** of a custom domain, which is why no path in the
repo names the repo any more. Keep it that way: nothing in the tree should
hardcode a host or a `/AppsByDan/` prefix. That's what makes moving hosts a DNS
change rather than a migration.

`CNAME` contains `appsbydan.com` and **must stay on the publishing branch**.
Deleting it reverts the site to the github.io URL.

### The two-branch publishing model — read this

`main` is where work happens. `gh-pages` is what GitHub actually serves.
They're kept identical by fast-forward.

```sh
git push origin main                 # does NOT update the live site
git push origin main:gh-pages        # this is what deploys
```

**Pushing only `main` leaves the live site unchanged.** This is the single
easiest mistake to make. Always push both.

A fresh clone has no local `gh-pages` branch, so `git checkout gh-pages` fails.
Use the `main:gh-pages` refspec above instead, after confirming it's a
fast-forward:

```sh
git fetch origin gh-pages
git merge-base --is-ancestor origin/gh-pages main && echo "safe to push"
```

Never force-push `gh-pages`. If it has diverged, something is wrong — stop and
find out what rather than overwriting it.

### Deploy verification

Pushing `gh-pages` triggers GitHub's own `pages build and deployment` run (not
the workflow in this repo). Confirm it succeeded before reporting success:

```sh
curl -s "https://api.github.com/repos/Crazyh1803/AppsByDan/actions/runs?per_page=1" \
  | python3 -c "import json,sys; r=json.load(sys.stdin)['workflow_runs'][0]; \
    print(r['name'], r['status'], r['conclusion'], r['head_sha'][:7])"
```

`.github/workflows/pages.yml` is an **unused alternative route**, deliberately
set to `workflow_dispatch` only. It exists because the Actions-based deploy was
tried first and failed: the repo's Actions token isn't permitted to create a
Pages site (`Resource not accessible by integration`). Don't re-arm its push
trigger unless Pages "Source" is switched to GitHub Actions — it will just fail
on every commit.

---

## Repo layout

```
index.html          Home: hero, shipped apps, featured game, what's next
apps.html           True Shuffle, Manual Bridge, Pantry Logic
games.html          Gaga Pit Showdown (feature block)
printing.html       3D printing placeholder
about.html          About Me, tips model, AI disclosure, contact
404.html            ⚠ special — see Invariants

assets/css/site.css  every style; design tokens at the top
assets/js/site.js    mobile nav toggle + footer year. That's all it does.
assets/img/          web-sized artwork (.webp + .jpg fallback) and icons

tools/optimize_images.py    full-size source art -> assets/img derivatives
tools/make_app_banners.py   rebuilds two banners that have no source file

CNAME               appsbydan.com — do not delete
robots.txt          allows all, points at the sitemap
sitemap.xml         all five pages (404 deliberately excluded)
site.webmanifest    PWA manifest for home-screen install
.nojekyll           stops Pages running Jekyll over the output
.github/workflows/  unused alternative deploy — see above
```

---

## Invariants

Violating any of these produces a bug that is **invisible in normal local
testing**. That's why they're listed.

### 1. Header and footer are byte-identical across the five main pages

There is no templating. The `<header>` and `<footer>` blocks are duplicated by
hand in every page. A change to the nav or the tip footer must be made in all
five — and `404.html` too, with absolute paths.

Check after every change that touches them:

```sh
# header: strip aria-current (correctly differs per page), expect "1"
for f in index apps games printing about; do
  sed -n '/<header class="site-header">/,/<\/header>/p' $f.html \
    | sed 's/ aria-current="page"//' | md5sum
done | sort -u | wc -l

# footer: expect "1"
for f in index apps games printing about; do
  sed -n '/<footer class="site-footer">/,/<\/footer>/p' $f.html | md5sum
done | sort -u | wc -l
```

This invariant is why analytics event names are **per destination, not per
page** (see Analytics). A per-page name in the footer would silently break it.

### 2. `404.html` uses absolute paths; every other page uses relative

GitHub Pages serves `404.html` for **any** missing path. A request for
`/foo/bar/baz` gets `404.html`, and a relative `assets/css/site.css` then
resolves against `/foo/bar/` and 404s too — the page arrives completely
unstyled.

So every `href`/`src` in `404.html` starts with `/`. Every other page uses
relative paths and must keep doing so.

**Serving locally at the root hides this bug**, because at the root both forms
resolve identically. To actually test it, request a deep nonexistent path, or
diff the asset URLs the browser requests.

`404.html` also carries `<meta name="robots" content="noindex">` and no `og:`
tags — a 404 should never be indexed or render as a social card.

### 3. Replacing artwork requires a new filename

Overwriting `foo.webp` in place leaves every previous visitor seeing the old
image from cache, with no way to know they should refresh. This bit the site
twice before the rule was adopted.

Use a version suffix — `pantry-logic-v2`, `dan-portrait-v2` — and update the
`<picture>` blocks that reference it. New artwork for a *new* card needs no
suffix.

### 4. Every image needs `alt`; every external link needs `target`/`rel`

```sh
# expect 0
grep -oh '<img [^>]*>' *.html | grep -v 'alt=' | wc -l
```

All external links open in a new tab with `rel="noopener"`. One link was found
violating this by asserting it across all tagged links — worth re-running that
assertion after bulk edits.

### 5. Image size budgets

Banners under ~350 KB, portrait under ~100 KB. The original uploads totalled
9.5 MB; the pipeline brought them to well under 1 MB. Don't regress that — the
audience is largely on phones.

---

## Page and component model

Design tokens live at the top of `site.css` as CSS custom properties. The
palette is carried over from the True Shuffle app so the site and the apps read
as one family: `--bg #121212`, `--accent #1db954` (Spotify green),
`--tip #ffdd00` for the Buy Me a Coffee link only.

Mobile-first. One breakpoint at **760px** for the nav and About layout; the card
grid is intrinsic (`auto-fit` + `minmax`) and needs no breakpoint.

### Cards

```html
<article class="card card-live">     <!-- shipped: solid border, accent hover -->
<article class="card card-coming">   <!-- not out: dashed border, dimmed art -->
```

A card is: optional `.card-media` (16:9 banner), `.card-body` with `h3`,
`.card-tagline`, description paragraphs, `.card-actions` (buttons), and
optionally `.card-fineprint` (small print under the buttons).

`.badge` / `.badge-live` overlays the media. **Check it doesn't collide with
text baked into the artwork** — this happened with the Gaga banner and the badge
was dropped from that card.

### The feature block

`.feature` is a wider, single-item presentation used for Gaga Pit Showdown on
the home and games pages. Deliberately **no `aspect-ratio` and no
`object-fit: cover`** — unlike `.card-media`, it renders the banner at its
native ratio, uncropped, because that artwork has its title laid into it.
It's left-aligned, not centred, to match the section headings above it.

### The grid

`.grid` is `repeat(auto-fit, minmax(300px, 1fr))`. At the 1100px container that
fits three cards per row. A previous `.grid-wide` used `minmax(340px)` and only
fit two, wrapping the third onto a half-empty row — it was removed. If you add a
fourth card to a row, re-check the wrapping.

---

## Images pipeline

Source art is **not** kept in the tree. The flow is:

1. Drop a full-size image anywhere in the repo.
2. Add a line to `JOBS` in `tools/optimize_images.py`:
   `("path/to/source.png", "output-stem", max_width, "JPEG", quality)`
3. `pip install Pillow && python3 tools/optimize_images.py`
4. Reference it with a `<picture>` block (`.webp` source, `.jpg` fallback).
5. Delete the source from the tree — git history keeps it.

Jobs whose source no longer exists print `skip` and are harmless; most entries
in `JOBS` are in that state and serve as a record of how each asset was made.

`tools/make_app_banners.py` rebuilds the two banners with no source art at all:
True Shuffle's is composed from that app's own logo, Manual Bridge's is its repo
banner cropped to 16:9. Needs Playwright plus a Chromium binary.

---

## Analytics

GoatCounter, loaded from one `async` tag before `</body>` on all six pages
(404 included — a 404 getting traffic means an inbound link is wrong).

Dashboard: `https://appsbydan.goatcounter.com`

**Cookieless, stores no personal data.** This is why the site needs no cookie
banner. If analytics is ever swapped for something heavier, that changes.

Outbound clicks are events via `data-goatcounter-click` on app, store,
tester-funnel and tip links — GoatCounter only sees pageviews on pages carrying
its tag, so a click through to another site is otherwise invisible.

**Event names are per destination, never per page** (`out-manual-bridge-web`,
`out-tip-button`). A per-page name would make the shared footer markup differ
between pages and break Invariant 1.

GitHub and Instagram links are deliberately untagged. Click events are
best-effort — they fire as the browser navigates away, so some are lost. Treat
them as a trend, not a tally.

---

## External properties this repo depends on

None of these live here. Changing them is out of scope for this repo, but
breaking a link to them is very much in scope.

| Property | Used for |
|---|---|
| `crazyh1803.github.io/SpotifyShuffle` | True Shuffle web app — **separate repo** |
| `crazyh1803.github.io/TricareManualtoPdf` | Manual Bridge web app — **separate repo** |
| `crazyh1803.github.io/Gagaball` | Gaga Pit Showdown web build — **separate repo** |
| `play.google.com/.../com.appsbydan.*` | Play listings for three apps |
| `groups.google.com/g/gagaballtesters` | Gaga closed-test tester list |
| `buymeacoffee.com/AppsbyDan` | tips |
| `instagram.com/appsbydan` | social |

⚠ **Those three `crazyh1803.github.io` links are correct and must not be
rewritten.** They're sibling projects at their own Pages URLs. A global
find-and-replace of "crazyh1803.github.io" during the domain migration would
have broken all three; the rewrite was scoped to `/AppsByDan` only.

---

## Verify before pushing

```sh
python3 -m http.server 8000        # serve at the ROOT — matches production
```

Then, with a headless browser over all six pages at 375px and 1440px:

- no console errors, no failed requests, no horizontal overflow
- exactly one `<h1>` per page, no skipped heading levels
- `aria-current="page"` on the correct nav item
- header/footer md5 checks above return `1` and `1`
- `sitemap.xml` parses as XML, `site.webmanifest` as JSON
- every `assets/img/...` path referenced in HTML exists on disk

**Look at screenshots, don't just assert.** Several real problems here were
invisible to assertions and obvious on sight: a badge covering a logo, a card
wrapping to a half-empty row, banner text illegible at card scale.

`gc.zgo.at` may be unreachable from a sandboxed environment. Stub it with a
route handler rather than letting its failures mask real ones.

---

## Landmines

Each of these cost time at least once.

- **Pushing only `main`.** The live site doesn't change. Push `gh-pages` too.
- **Lazy-loaded images screenshot blank.** Scroll them into view and wait before
  capturing, or you'll "find" a bug that isn't there.
- **The sticky header appears mid-page in full-page screenshots.** An artifact
  of capturing while scrolled, not a layout bug. Verify with
  `getBoundingClientRect().top === 0` at several scroll offsets.
- **Serving locally at a sub-path vs the root changes which bugs are visible.**
  Production is the root now; test there.
- **A sandbox may have no DNS at all** (no `dig`/`host`, DNS-over-HTTPS blocked,
  `getaddrinfo` failing even for `example.com`). Don't infer a domain is
  misconfigured from a failed lookup — have a human check.
- **Don't add a `CNAME` before DNS resolves.** Pages immediately redirects the
  github.io URL to the custom domain; if DNS isn't live the site is simply down.
- **A CAA record added before the certificate is issued can block issuance.**

---

## Open items

- **Per-app privacy policy links.** Each app has a policy in its own repo, but
  they aren't linked from the cards here. Someone on this site can't reach them
  without going via the Play listing. Needs the URLs.
- **GoatCounter on the three app sites.** Same tag, their repos, separate push.
- **`Enforce HTTPS`** in Settings → Pages, once GitHub issues the certificate.
- **Play listings and Instagram bio** should point at `appsbydan.com` rather
  than the old github.io URL.
