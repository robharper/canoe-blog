/**
 * Calculates trip statistics from GeoJSON features.
 * 
 * @param {Object} geojson - The GeoJSON object.
 * @returns {Object} - An object containing:
 *   - portageCount: Total number of portages.
 *   - portageLengthKm: Total length of portages in km.
 *   - paddleLengthKm: Total paddling length in km.
 *   - nights: Number of nights (based on campsites).
 */
export function calculateTripStats(geojson) {
    let portageCount = 0;
    let portageLengthM = 0;
    let paddleLengthM = 0;
    let campsites = 0;

    if (!geojson || !geojson.features) {
        return {
            portageCount: 0,
            portageLengthKm: 0,
            paddleLengthKm: 0,
            nights: 0,
        };
    }

    geojson.features.forEach((feature) => {
        const props = feature.properties || {};

        // Count campsites
        if (props.tourism === 'camp_site') {
            campsites++;
        }

        // Process LineString features for lengths
        if (feature.geometry && feature.geometry.type === 'LineString') {
            let length = props.length;

            // Calculate length if missing
            if (length === undefined || length === null) {
                length = calculateLineStringLength(feature.geometry.coordinates);
            }

            if (props.canoe === 'portage') {
                portageCount++;
                portageLengthM += length;
            } else if (props.canoe === 'yes') {
                paddleLengthM += length;
            }
        }
    });

    return {
        portageCount,
        portageLengthKm: Math.round((portageLengthM / 1000) * 10) / 10,
        paddleLengthKm: Math.round((paddleLengthM / 1000) * 10) / 10,
        nights: campsites > 0 ? campsites : 0,
    };
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
