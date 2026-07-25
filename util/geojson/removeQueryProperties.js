/**
 * Strips the `featureGroup` property (Overpass query metadata such as
 * `query`, `name`, and `only`) left over from the OSM export process from
 * every feature in each GeoJSON file under public/geo/. This data isn't used
 * by the site and just bloats the files.
 *
 * Usage:
 *   node util/geojson/removeQueryProperties.js
 */

import { readFileSync, writeFileSync, readdirSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const geoDir = resolve(__dirname, "../../public/geo");

const files = readdirSync(geoDir).filter((f) => f.endsWith(".geo.json"));

let totalRemoved = 0;
let totalFiles = 0;

for (const file of files) {
    const filePath = join(geoDir, file);
    const geojson = JSON.parse(readFileSync(filePath, "utf-8"));

    if (!geojson.features) {
        console.warn(`  Skipping ${file}: no features array`);
        continue;
    }

    let removed = 0;
    for (const feature of geojson.features) {
        if (feature.properties && "featureGroup" in feature.properties) {
            delete feature.properties.featureGroup;
            removed++;
        }
    }

    if (removed > 0) {
        totalRemoved += removed;
        totalFiles++;
        console.log(`${file}: removed featureGroup from ${removed} feature(s)`);
    } else {
        console.log(`${file}: nothing to remove`);
    }

    writeFileSync(filePath, JSON.stringify(geojson), "utf-8");
}

console.log(
    `\nDone. Removed featureGroup from ${totalRemoved} feature(s) across ${totalFiles} file(s).`,
);
