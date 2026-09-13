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

The Research Projects, Publications, and People sections follow the same
content-collection pattern as they gain real content.

## Hero design

The landing globe (realistic Earth, day-night terminator, dual cloud shells,
and ocean / land / atmosphere hexagonal grid layers) is specified in
[docs/design/hero.md](docs/design/hero.md). Tunable parameters live at the top
of [src/scripts/globe.ts](src/scripts/globe.ts).

## Asset attribution

- Earth imagery: NASA Blue Marble and night-lights datasets (NASA)
- Cloud map: derived from the three.js examples texture set (MIT)
- Rendering: three.js, MIT license
