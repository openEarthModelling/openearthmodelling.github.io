# openEarthModelling website

Source of <https://openearthmodelling.github.io>, the website and blog of the
[openEarthModelling](https://github.com/openEarthModelling) group: an open
research group building computational software for the Earth system.

## Stack

- [Astro 5](https://astro.build) static site, [Tailwind CSS 4](https://tailwindcss.com)
- [Three.js 0.170](https://threejs.org) (WebGL2) for the hero globe
- Deployed to GitHub Pages via GitHub Actions on every push to `main`

## Develop

```bash
npm install
npm run dev        # http://localhost:4321
npm run build      # static output in dist/
```

Take a screenshot of any page (uses the local chromium, software WebGL):

```bash
node scripts/screenshot.mjs [url] [outfile]
```

## Write a blog post

Add a Markdown file to `src/content/blog/` with this frontmatter:

```md
---
title: Your title
description: One-line summary for the list page.
pubDate: 2026-09-13
author: Fan Zhang
tags: [research, devlog]
---

Your text. Images go in `public/images/`, referenced as `/images/...`.
```

Commit and push to `main`. The site rebuilds automatically.

## Publish from Feishu

Posts and publications can also be written in Feishu and synced into the repository
(requires Node >= 23.6 to run the TypeScript sync script natively):

```bash
node scripts/sync.mts new "Article title"  # scaffold: copy the doc template + add a draft row
node scripts/sync.mts blog                 # publish rows in "pending" state
node scripts/sync.mts publications         # regenerate src/data/publications.json
node scripts/sync.mts all --dry-run        # preview without writing anything
node scripts/sync.mts all --no-push        # write and commit locally, but do not push
```

The Feishu document is the source of truth for the article: its title, and the
author/summary metadata block at the top of the body. Editing a published
document never redeploys automatically: the sync flips the row to "updated"
after a lightweight revision probe, and the change only ships after you set the
row back to "pending".

The content pipeline (registry tables, status machine, permissions) is documented in
[docs/design/content-pipeline.md](docs/design/content-pipeline.md). It requires `lark-cli`
logged in to the group's Feishu account on the machine running the sync.

The Research Projects and People sections follow the same content-collection
pattern as they gain real content.

## Hero design

The landing globe (realistic Earth, day-night terminator, dual cloud shells,
and ocean / land / atmosphere hexagonal grid layers) is specified in
[docs/design/hero.md](docs/design/hero.md). Tunable parameters live at the top
of [src/scripts/globe.ts](src/scripts/globe.ts).

## Asset attribution

- Earth imagery: NASA Blue Marble and night-lights datasets (NASA)
- Cloud map: derived from the three.js examples texture set (MIT)
- Rendering: three.js, MIT license
