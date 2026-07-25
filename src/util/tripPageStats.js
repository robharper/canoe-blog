import { calculateTripStats } from './geoStats.js';
import { calculateDailyTripStats } from './dailyTripStats.js';

/**
 * Loads a trip's GeoJSON (if any) and computes its overall stats and
 * day-by-day breakdown, applying any manual frontmatter overrides
 * (portageCount).
 *
 * Computed once per trip page so the same values can be handed both to
 * `TripLayout` (for the key details / automatic daily breakdown) and to the
 * trip's rendered `<Content />`, letting the markdown/MDX body reference
 * `dailyStats` directly (e.g. to render one day at a time via
 * `<TripDailyDetails day={n} days={dailyStats} />`).
 *
 * @param {import('astro:content').CollectionEntry<'trips'>} trip
 * @returns {{
 *   stats: import('./geoStats.js').TripStats|null,
 *   dailyStats: import('./dailyTripStats.js').DayStats[]|null,
 * }}
 */
export function computeTripPageStats(trip) {
    let stats = null;
    let dailyStats = null;

    if (trip.data.geojson) {
        try {
            const geojsonFiles = import.meta.glob('/public/geo/*.json', { eager: true });
            const normalizedPath = trip.data.geojson.startsWith('/') ? trip.data.geojson : `/${trip.data.geojson}`;
            const key = `/public${normalizedPath}`;
            const file = geojsonFiles[key];

            if (file) {
                const geojsonContent = file.default || file;
                dailyStats = calculateDailyTripStats(
                    geojsonContent,
                    trip.data.title,
                    trip.data.waypointNames,
                );
                stats = calculateTripStats(geojsonContent, dailyStats);
            } else {
                console.warn(`GeoJSON file not found: ${key}`);
            }
        } catch (e) {
            console.error(`Error calculating stats for ${trip.data.title}:`, e);
        }
    }

    // Manual overrides
    if (stats && trip.data.portageCount !== undefined) {
        stats.portageCount = trip.data.portageCount;
    }

    return { stats, dailyStats };
}
