# Canoe Blog

A static site built with [Astro](https://astro.build) — a digital logbook of canoe trips with interactive maps, route stats, and trip write-ups.

**Live site (after deployment):** [https://robharper.github.io/canoe-blog/](https://robharper.github.io/canoe-blog/)

## Local development

Requires Node.js 20+ (see `util/.nvmrc`).

```sh
npm install
npm run dev       # http://localhost:4321
npm run build     # output to ./dist/
npm run preview   # serve the production build locally
```

## Project structure

```text
/
├── public/geo/          # Per-trip GeoJSON files served as static assets
├── src/
│   ├── assets/          # Trip photos (processed by Astro Image)
│   ├── components/      # TripCard, TripMap, Photo, etc.
│   ├── content/trips/   # Trip front matter and markdown/MDX write-ups
│   ├── layouts/         # BaseLayout, TripLayout
│   ├── pages/           # Routes: /, /about, /trips/[slug]
│   └── util/            # Geo stats and daily breakdown helpers
├── util/geojson/        # Route-building tools and source data (not deployed)
├── util/google-photos/  # CLI to import trip photos from Google Photos (not deployed)
├── util/addTripPhotos/  # CLI to scaffold <Photo> elements from a trip's image folder (not deployed)
└── astro.config.mjs
```

Trip content lives in `src/content/trips/`. Each trip references a matching GeoJSON file at `public/geo/<slug>.geo.json`. See [`util/geojson/README.md`](util/geojson/README.md) for how to build and combine route data.

## GitHub Pages deployment

The site deploys automatically to [https://robharper.github.io/canoe-blog/](https://robharper.github.io/canoe-blog/) on every push to `main`.

### One-time GitHub setup

1. Open **Settings → Pages** in [robharper/canoe-blog](https://github.com/robharper/canoe-blog)
2. Set **Build and deployment → Source** to **GitHub Actions**
3. Push to `main` and confirm the **Deploy to GitHub Pages** workflow succeeds

### How it works

| Piece | Location |
| --- | --- |
| Astro `site` / `base` | `astro.config.mjs` (`/canoe-blog/` subpath) |
| Internal links | Prefixed with `import.meta.env.BASE_URL` |
| CI workflow | `.github/workflows/deploy.yml` |

**Verify locally** (with `base` already set in config):

```sh
npm run build
npm run preview
```

Open `http://localhost:4321/canoe-blog/` and click through home → trip → about.

### Custom domain

Set `base: '/'`, add `public/CNAME` with your domain, update DNS, and change `site` in `astro.config.mjs` to match.

## Content workflow

1. **Add trip markdown** — create `src/content/trips/<slug>.md` (or `.mdx`) with front matter (title, date, location, excerpt, coverImage, optional waypoint names).
2. **Import photos** — run `node util/google-photos/import-photos.js <slug>` to pick photos from Google Photos (within +/- 15 days of the trip date) and download them as `.jpg` into `src/assets/images/trips/<slug>/`. See [`util/google-photos/README.md`](util/google-photos/README.md) for one-time setup.
3. **Scaffold photo elements** — run `node util/addTripPhotos/addTripPhotos.js <slug>` to add a `<Photo>` element (with a `TODO` caption) for every image in that folder that doesn't have one yet, grouped by capture date into `## Day N` sections with an inline `<TripDailyDetails>`, reusing unused imports where present. Converts the content file to `.mdx` if needed, since `<Photo>` is a component. Then edit the captions and move each `<Photo>` block to the right place in the narrative. If photos are missing a capture date (common for images added outside `util/google-photos/`), grouping falls back to an ungrouped list — re-run the importer and re-select those photos to backfill the date (see `util/google-photos/README.md`).
4. **Add route GeoJSON** — place `public/geo/<slug>.geo.json` (same slug as the content file).
5. **Rebuild combined map** — from `util/geojson/`, run the combine script so `public/geo/all.geo.json` includes the new route (see `util/geojson/README.md`).
6. **Preview** — `npm run dev` and check the trip page map and daily stats.
7. **Deploy** — merge to `main`; GitHub Actions publishes automatically once Phases 1–6 are done.

## Commands

| Command | Action |
| --- | --- |
| `npm install` | Install dependencies |
| `npm run dev` | Dev server at `localhost:4321` |
| `npm run build` | Production build to `./dist/` |
| `npm run preview` | Serve `./dist/` locally |
