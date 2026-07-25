# Canoe Route Builder

## Building a Route
### Isolating Route
1. Go to https://mapshaper.org/
2. Load all-routes.geo.json
3. Choose "selection tool"
4. Click to select all segments paddled/portages and campsites visited
5. Choose "Keep" from the context menu to delete all other routes
6. Use the simplify tool to simplify as much as possible without losing key detail
7. Export as GeoJSON

### Campsites
1. Go to https://mapshaper.org/
2. Load campsite.geo.json
3. Select campsites used
4. Choose keep
5. Export
6. Merge with route from previous stage

### Touch Ups
You may want to draw connecting lines from the route to the campsites used. If so, do the following:
1. Open geojson.io
2. Load geojson from previous steps
3. Make minor edits
4. Save

## Combining
```
nvm use
cd source-data
node combine.js
```

## Portage lengths

Merges connected portage segments (e.g. an OSM way split into multiple pieces)
into single features and (re)calculates the `length` property (whole meters)
on every portage across all files in `public/geo/`.

```bash
node util/geojson/addPortageLengths.js
```

## Removing query metadata

Strips the leftover `featureGroup` property (the Overpass `query`, `name`,
and `only` used to build the export) from every feature across all files in
`public/geo/`.

```bash
node util/geojson/removeQueryProperties.js
```