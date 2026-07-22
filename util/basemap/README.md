# Basemap overlays

Offline scripts that build static basemap GeoJSON used by trip maps (not canoe route geometry — that lives in `util/geojson/`).

## Lake names

Extracts named lakes/ponds/reservoirs in Algonquin Provincial Park from OpenStreetMap, computes an in-water label point ([polylabel](https://github.com/mapbox/polylabel)) and polygon area, and writes:

`public/geo/algonquin-lakes.geo.json`

### Refresh

```bash
cd util/basemap
npm install
node fetchLakeNames.js
```

Requires network access to an Overpass API endpoint. The script tries `overpass-api.de` then `overpass.kumi.systems`.
