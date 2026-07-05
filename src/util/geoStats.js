import { calculateDailyTripStats } from './dailyTripStats.js';

/**
 * Calculates trip statistics from GeoJSON features.
 *
 * Prefers summing up the day-by-day breakdown from calculateDailyTripStats
 * so the totals shown here always agree with the daily breakdown table.
 * Falls back to summing every mapped route segment directly when a daily
 * breakdown isn't available (e.g. missing/incomplete access point or
 * campsite tags).
 *
 * @param {Object} geojson - The GeoJSON object.
 * @param {import('./dailyTripStats.js').DayStats[]|null} [dailyStats] -
 *   Pre-computed daily breakdown (e.g. from calculateDailyTripStats). If
 *   omitted, it's computed here; pass it in when the caller already has it
 *   to avoid running the calculation twice.
 * @returns {Object} - An object containing:
 *   - portageCount: Total number of portages.
 *   - portageLengthKm: Total length of portages in km.
 *   - paddleLengthKm: Total paddling length in km.
 *   - nights: Number of nights (based on campsites).
 */
export function calculateTripStats(geojson, dailyStats) {
    if (!geojson || !geojson.features) {
        return {
            portageCount: 0,
            portageLengthKm: 0,
            paddleLengthKm: 0,
            nights: 0,
        };
    }

    const nights = geojson.features.filter(
        (feature) => feature.properties?.tourism === 'camp_site',
    ).length;

    const resolvedDailyStats = dailyStats === undefined ? calculateDailyTripStats(geojson) : dailyStats;
    if (resolvedDailyStats && resolvedDailyStats.length > 0) {
        const totals = resolvedDailyStats.reduce(
            (sum, day) => ({
                paddleLengthKm: sum.paddleLengthKm + day.paddleLengthKm,
                portageLengthKm: sum.portageLengthKm + day.portageLengthKm,
                portageCount: sum.portageCount + day.portageCount,
            }),
            { paddleLengthKm: 0, portageLengthKm: 0, portageCount: 0 },
        );

        return {
            portageCount: totals.portageCount,
            portageLengthKm: roundToOneDecimal(totals.portageLengthKm),
            paddleLengthKm: roundToOneDecimal(totals.paddleLengthKm),
            nights,
        };
    }

    return calculateTripStatsFromSegments(geojson, nights);
}

/**
 * Sums every mapped route segment directly, regardless of whether it
 * belongs to a day's actual path. Used when the route network doesn't have
 * enough data (access point/campsite tags) to build a day-by-day breakdown.
 */
function calculateTripStatsFromSegments(geojson, nights) {
    let portageCount = 0;
    let portageLengthM = 0;
    let paddleLengthM = 0;

    geojson.features.forEach((feature) => {
        if (feature.geometry?.type !== 'LineString') {
            return;
        }

        const length = calculateLineStringLength(feature.geometry.coordinates);

        // Every non-portage LineString is a paddling segment. Route data
        // pulled in from other sources (rivers, streams, etc.) won't always
        // carry an explicit canoe=yes tag the way hand-drawn segments do, so
        // only an explicit canoe=portage tag is treated as a portage.
        if (feature.properties?.canoe === 'portage') {
            portageCount++;
            portageLengthM += length;
        } else {
            paddleLengthM += length;
        }
    });

    return {
        portageCount,
        portageLengthKm: roundToOneDecimal(portageLengthM / 1000),
        paddleLengthKm: roundToOneDecimal(paddleLengthM / 1000),
        nights,
    };
}

function roundToOneDecimal(value) {
    return Math.round(value * 10) / 10;
}

/**
 * Calculates the length of a LineString in meters.
 * @param {Array} coordinates - Array of [lng, lat] coordinates.
 * @returns {number} - Length in meters.
 */
function calculateLineStringLength(coordinates) {
    let totalLength = 0;
    for (let i = 0; i < coordinates.length - 1; i++) {
        totalLength += haversineDistance(coordinates[i], coordinates[i + 1]);
    }
    return totalLength;
}

/**
 * Calculates the Haversine distance between two points.
 * @param {Array} p1 - [lng, lat]
 * @param {Array} p2 - [lng, lat]
 * @returns {number} - Distance in meters.
 */
export function haversineDistance(p1, p2) {
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
