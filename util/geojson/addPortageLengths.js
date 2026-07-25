/**
 * Merges connected portage LineString segments into single features and sets
 * an accurate `length` property (whole meters) on every portage in each
 * GeoJSON file under public/geo/.
 *
 * Two portage segments are considered "connected" when the last coordinate of
 * one exactly matches the first coordinate of another (as happens when an OSM
 * way is split into multiple segments). Connected chains are stitched into a
 * single LineString before the length is calculated.
 *
 * Usage:
 *   node util/geojson/addPortageLengths.js
 */

import { readFileSync, writeFileSync, readdirSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const geoDir = resolve(__dirname, "../../public/geo");

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/**
 * Calculates the Haversine distance between two points.
 * @param {Array} p1 - [lng, lat]
 * @param {Array} p2 - [lng, lat]
 * @returns {number} - Distance in meters.
 */
function haversineDistance(p1, p2) {
    const R = 6371e3; // Earth's radius in meters
    const phi1 = (p1[1] * Math.PI) / 180;
    const phi2 = (p2[1] * Math.PI) / 180;
    const deltaPhi = ((p2[1] - p1[1]) * Math.PI) / 180;
    const deltaLambda = ((p2[0] - p1[0]) * Math.PI) / 180;

    const a =
        Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
        Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
}

const coordKey = (coord) => coord.join(",");

function lineStringLength(coordinates) {
    let total = 0;
    for (let i = 0; i < coordinates.length - 1; i++) {
        total += haversineDistance(coordinates[i], coordinates[i + 1]);
    }
    return total;
}

/**
 * Given an unordered array of portage segment features that form a connected
 * chain, return a single merged coordinate array representing the full path.
 */
function orderAndMerge(segments) {
    if (segments.length === 1) return [...segments[0].geometry.coordinates];

    // Count how many times each endpoint appears across all segments.
    // An endpoint that appears only once is a "dangling" end of the chain.
    const endpointCount = new Map();
    for (const seg of segments) {
        const coords = seg.geometry.coordinates;
        for (const key of [coordKey(coords[0]), coordKey(coords[coords.length - 1])]) {
            endpointCount.set(key, (endpointCount.get(key) ?? 0) + 1);
        }
    }

    // Find the segment that starts the chain (one of its endpoints is dangling)
    // and orient it so the dangling end comes first.
    let startSeg = segments[0];
    let reversed = false;

    for (const seg of segments) {
        const coords = seg.geometry.coordinates;
        if (endpointCount.get(coordKey(coords[0])) === 1) {
            startSeg = seg;
            reversed = false;
            break;
        }
        if (endpointCount.get(coordKey(coords[coords.length - 1])) === 1) {
            startSeg = seg;
            reversed = true;
            break;
        }
    }

    const chain = reversed
        ? [...startSeg.geometry.coordinates].reverse()
        : [...startSeg.geometry.coordinates];

    const remaining = new Set(segments.filter((s) => s !== startSeg));

    while (remaining.size > 0) {
        const currentEnd = coordKey(chain[chain.length - 1]);
        let matched = false;

        for (const seg of remaining) {
            const coords = seg.geometry.coordinates;
            if (coordKey(coords[0]) === currentEnd) {
                chain.push(...coords.slice(1));
                remaining.delete(seg);
                matched = true;
                break;
            }
            if (coordKey(coords[coords.length - 1]) === currentEnd) {
                chain.push(...[...coords].reverse().slice(1));
                remaining.delete(seg);
                matched = true;
                break;
            }
        }

        if (!matched) {
            // Groups are built via chain-only endpoints so this should never occur
            throw new Error("Disconnected segment within group — this is a bug");
        }
    }

    return chain;
}

/**
 * Group portage features into connected chains using BFS over shared
 * endpoints, then merge each chain into a single feature.
 *
 * Returns the full feature list with portage chains collapsed.
 */
function mergePortageChains(features) {
    const isPortage = (f) =>
        f.geometry?.type === "LineString" && f.properties?.canoe === "portage";

    const portages = features.filter(isPortage);
    const others = features.filter((f) => !isPortage(f));

    if (portages.length === 0) return features;

    // Map endpoint coord key → indices of segments that start/end there
    const endpointIndex = new Map();
    portages.forEach((seg, i) => {
        const coords = seg.geometry.coordinates;
        for (const key of [coordKey(coords[0]), coordKey(coords[coords.length - 1])]) {
            if (!endpointIndex.has(key)) endpointIndex.set(key, []);
            endpointIndex.get(key).push(i);
        }
    });

    // Only connect two segments via an endpoint that is shared by exactly two
    // segments. A junction touched by 3+ segments would produce a branching
    // path that can't be linearised, so we leave those segments separate.
    const isChainEndpoint = (key) => (endpointIndex.get(key)?.length ?? 0) === 2;

    // BFS to find connected components (only traverse chain endpoints)
    const visited = new Array(portages.length).fill(false);
    const groups = [];

    for (let start = 0; start < portages.length; start++) {
        if (visited[start]) continue;

        const group = [];
        const queue = [start];

        while (queue.length > 0) {
            const i = queue.shift();
            if (visited[i]) continue;
            visited[i] = true;
            group.push(i);

            const coords = portages[i].geometry.coordinates;
            for (const key of [coordKey(coords[0]), coordKey(coords[coords.length - 1])]) {
                if (!isChainEndpoint(key)) continue;
                for (const neighbor of endpointIndex.get(key) ?? []) {
                    if (!visited[neighbor]) queue.push(neighbor);
                }
            }
        }

        groups.push(group);
    }

    // Merge each group into a single feature
    const mergedPortages = groups.map((indices) => {
        const segs = indices.map((i) => portages[i]);
        const mergedCoords = orderAndMerge(segs);
        const length = Math.round(lineStringLength(mergedCoords));

        // Preserve the first segment's feature-level id and properties
        const base = segs[0];
        return {
            ...base,
            geometry: { type: "LineString", coordinates: mergedCoords },
            properties: { ...base.properties, length },
        };
    });

    return [...others, ...mergedPortages];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const files = readdirSync(geoDir).filter((f) => f.endsWith(".geo.json"));

let totalMerged = 0;
let totalFiles = 0;

for (const file of files) {
    const filePath = join(geoDir, file);
    const geojson = JSON.parse(readFileSync(filePath, "utf-8"));

    if (!geojson.features) {
        console.warn(`  Skipping ${file}: no features array`);
        continue;
    }

    const before = geojson.features.filter(
        (f) => f.geometry?.type === "LineString" && f.properties?.canoe === "portage",
    ).length;

    const merged = mergePortageChains(geojson.features);
    geojson.features = merged;

    const after = merged.filter(
        (f) => f.geometry?.type === "LineString" && f.properties?.canoe === "portage",
    ).length;

    const collapsed = before - after;
    if (collapsed > 0) {
        totalMerged += collapsed;
        totalFiles++;
        console.log(`${file}: merged ${collapsed} segment(s) → ${after} portage(s) (was ${before})`);
    } else {
        console.log(`${file}: ${after} portage(s), no chains to merge`);
    }

    writeFileSync(filePath, JSON.stringify(geojson), "utf-8");
}

console.log(
    `\nDone. Collapsed ${totalMerged} segment(s) across ${totalFiles} file(s).`,
);
