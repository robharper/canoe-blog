import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { elementToLakeFeature, isNamedLakeTags } from "./lib/lakeGeometry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..");
const outputPath = path.join(
    projectRoot,
    "public",
    "geo",
    "algonquin-lakes.geo.json",
);

const ALGONQUIN_AREA_ID = 3600910784;
const OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.openstreetmap.fr/api/interpreter",
];

const QUERY = `
[out:json][timeout:180];
area(id:${ALGONQUIN_AREA_ID})->.searchArea;
(
  way["natural"="water"]["name"](area.searchArea);
  relation["natural"="water"]["name"](area.searchArea);
);
out geom;
`.trim();

async function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchOverpass(query) {
    let lastError;
    for (const url of OVERPASS_URLS) {
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                console.log(`Querying ${url} (attempt ${attempt})…`);
                const response = await fetch(url, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/x-www-form-urlencoded",
                        Accept: "application/json",
                        "User-Agent":
                            "canoe-blog-basemap/1.0 (Algonquin lake labels; local util script)",
                    },
                    body: `data=${encodeURIComponent(query)}`,
                });
                if (!response.ok) {
                    throw new Error(
                        `HTTP ${response.status} ${response.statusText}`,
                    );
                }
                const text = await response.text();
                if (text.trimStart().startsWith("<")) {
                    throw new Error(
                        `Overpass error response: ${text.slice(0, 300)}`,
                    );
                }
                return JSON.parse(text);
            } catch (err) {
                lastError = err;
                console.warn(`Failed on ${url}: ${err.message}`);
                await sleep(attempt * 5000);
            }
        }
    }
    throw lastError;
}

function buildFeatureCollection(elements) {
    const relations = elements.filter(
        (e) => e.type === "relation" && isNamedLakeTags(e.tags),
    );
    const ways = elements.filter(
        (e) => e.type === "way" && isNamedLakeTags(e.tags),
    );

    // Skip ways that are members of a named water relation we keep (avoids double labels).
    const memberWayIds = new Set();
    for (const rel of relations) {
        for (const m of rel.members || []) {
            if (m.type === "way") memberWayIds.add(m.ref);
        }
    }

    const features = [];
    const seenIds = new Set();

    for (const el of [...relations, ...ways]) {
        if (el.type === "way" && memberWayIds.has(el.id)) continue;

        const feature = elementToLakeFeature(el);
        if (!feature) continue;

        const id = feature.properties.id;
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        features.push(feature);
    }

    features.sort(
        (a, b) => (b.properties.area || 0) - (a.properties.area || 0),
    );

    return {
        type: "FeatureCollection",
        features,
    };
}

async function main() {
    const data = await fetchOverpass(QUERY);
    const elements = data.elements || [];
    console.log(`Received ${elements.length} OSM elements`);

    const collection = buildFeatureCollection(elements);
    console.log(`Wrote ${collection.features.length} lake label points`);

    if (collection.features.length) {
        const areas = collection.features.map((f) => f.properties.area);
        const p = (q) => areas[Math.floor((areas.length - 1) * q)];
        console.log(
            `Area m² — max: ${areas[0]}, p50: ${p(0.5)}, p90: ${p(0.1)}, min: ${areas[areas.length - 1]}`,
        );
        console.log(
            `Sample: ${collection.features
                .slice(0, 8)
                .map((f) => f.properties.name)
                .join(", ")}`,
        );
    }

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(collection));
    console.log(`Saved ${outputPath}`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
