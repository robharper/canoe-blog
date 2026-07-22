import polylabel from "polylabel";

const EXCLUDED_WATER = new Set(["river", "stream", "canal", "ditch"]);

/** Approximate meters-per-degree at a reference latitude (Algonquin ~45.8°N). */
const REF_LAT = 45.8;
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LNG = 111_320 * Math.cos((REF_LAT * Math.PI) / 180);

/**
 * Convert Overpass `{lat, lon}` nodes to GeoJSON `[lng, lat]` rings.
 */
export function nodesToRing(nodes) {
    if (!nodes?.length) return null;
    const ring = nodes.map((n) => [n.lon, n.lat]);
    const [first, last] = [ring[0], ring[ring.length - 1]];
    if (first[0] !== last[0] || first[1] !== last[1]) {
        ring.push([...first]);
    }
    return ring.length >= 4 ? ring : null;
}

/**
 * Shoelace area in m² using equirectangular projection at REF_LAT.
 * Positive for CCW or CW; returns absolute value.
 */
export function ringAreaM2(ring) {
    if (!ring || ring.length < 4) return 0;
    let sum = 0;
    for (let i = 0; i < ring.length - 1; i++) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[i + 1];
        sum +=
            x1 * M_PER_DEG_LNG * (y2 * M_PER_DEG_LAT) -
            x2 * M_PER_DEG_LNG * (y1 * M_PER_DEG_LAT);
    }
    return Math.abs(sum) / 2;
}

/**
 * Polygon area in m²: outer minus holes.
 */
export function polygonAreaM2(outer, holes = []) {
    let area = ringAreaM2(outer);
    for (const hole of holes) {
        area -= ringAreaM2(hole);
    }
    return Math.max(0, area);
}

/**
 * Interior label point via polylabel (pole of inaccessibility).
 * `polygon` is [outer, ...holes] in [lng, lat].
 */
export function labelPoint(polygon, precision = 0.00001) {
    const result = polylabel(polygon, precision);
    return [result[0], result[1]];
}

export function isNamedLakeTags(tags = {}) {
    if (!tags.name) return false;
    if (tags.natural !== "water") return false;
    const water = tags.water;
    if (water && EXCLUDED_WATER.has(water)) return false;
    // Skip linear watercourses tagged as polygons without water=*
    if (/\b(river|creek|stream|brook|canal|ditch)\b/i.test(tags.name)) {
        return false;
    }
    return true;
}

/**
 * Build closed rings from an ordered list of way geometries.
 * Ways may need reversing to connect; returns array of rings.
 */
export function assembleRingsFromWays(wayGeoms) {
    if (!wayGeoms.length) return [];

    const remaining = wayGeoms
        .map((geom) => nodesToRing(geom))
        .filter(Boolean)
        .map((ring) => ring.slice(0, -1)); // drop closing point while stitching

    const rings = [];

    while (remaining.length) {
        let chain = remaining.shift();
        let extended = true;

        while (extended && remaining.length) {
            extended = false;
            const start = chain[0];
            const end = chain[chain.length - 1];

            for (let i = 0; i < remaining.length; i++) {
                const next = remaining[i];
                const nStart = next[0];
                const nEnd = next[next.length - 1];

                if (coordsEqual(end, nStart)) {
                    chain = chain.concat(next.slice(1));
                    remaining.splice(i, 1);
                    extended = true;
                    break;
                }
                if (coordsEqual(end, nEnd)) {
                    chain = chain.concat(next.slice(0, -1).reverse());
                    remaining.splice(i, 1);
                    extended = true;
                    break;
                }
                if (coordsEqual(start, nEnd)) {
                    chain = next.slice(0, -1).concat(chain);
                    remaining.splice(i, 1);
                    extended = true;
                    break;
                }
                if (coordsEqual(start, nStart)) {
                    chain = next.slice(1).reverse().concat(chain);
                    remaining.splice(i, 1);
                    extended = true;
                    break;
                }
            }
        }

        if (!coordsEqual(chain[0], chain[chain.length - 1])) {
            chain.push([...chain[0]]);
        }
        if (chain.length >= 4) {
            rings.push(chain);
        }
    }

    return rings;
}

function coordsEqual(a, b) {
    return a[0] === b[0] && a[1] === b[1];
}

/**
 * From a closed way element with `geometry`, return { outer, holes, area }.
 */
export function polygonFromWay(way) {
    const outer = nodesToRing(way.geometry);
    if (!outer) return null;
    return {
        outer,
        holes: [],
        area: polygonAreaM2(outer),
        polygon: [outer],
    };
}

/**
 * From a multipolygon relation with member geometries, pick the largest
 * outer basin and attach its holes for labeling.
 */
export function polygonFromRelation(relation) {
    const outerGeoms = [];
    const innerGeoms = [];

    for (const member of relation.members || []) {
        if (member.type !== "way" || !member.geometry?.length) continue;
        if (member.role === "inner") {
            innerGeoms.push(member.geometry);
        } else {
            // default / outer / empty role
            outerGeoms.push(member.geometry);
        }
    }

    const outers = assembleRingsFromWays(outerGeoms);
    if (!outers.length) return null;

    const inners = assembleRingsFromWays(innerGeoms);

    let bestOuter = outers[0];
    let bestArea = polygonAreaM2(bestOuter);
    for (let i = 1; i < outers.length; i++) {
        const a = polygonAreaM2(outers[i]);
        if (a > bestArea) {
            bestArea = a;
            bestOuter = outers[i];
        }
    }

    const holes = inners.filter((hole) => pointInRing(hole[0], bestOuter));

    return {
        outer: bestOuter,
        holes,
        area: polygonAreaM2(bestOuter, holes),
        polygon: [bestOuter, ...holes],
    };
}

/** Ray-casting point-in-polygon for [lng, lat] against a closed ring. */
function pointInRing(point, ring) {
    const [x, y] = point;
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if (yj === yi) continue;
        const intersect =
            yi > y !== yj > y &&
            x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
        if (intersect) inside = !inside;
    }
    return inside;
}

/**
 * Convert an Overpass element into a GeoJSON Point feature, or null.
 */
export function elementToLakeFeature(element) {
    if (!isNamedLakeTags(element.tags)) return null;

    let poly;
    if (element.type === "way") {
        poly = polygonFromWay(element);
    } else if (element.type === "relation") {
        poly = polygonFromRelation(element);
    } else {
        return null;
    }

    if (!poly || poly.area <= 0) return null;

    let point;
    try {
        point = labelPoint(poly.polygon);
    } catch {
        return null;
    }

    const props = {
        name: element.tags.name,
        area: Math.round(poly.area),
        id: `${element.type}/${element.id}`,
    };
    if (element.tags.water) {
        props.water = element.tags.water;
    }

    return {
        type: "Feature",
        geometry: {
            type: "Point",
            coordinates: point,
        },
        properties: props,
    };
}
