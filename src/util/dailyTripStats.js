import { haversineDistance } from './geoStats.js';

// Endpoints within this distance of each other are treated as the same
// junction on the route network, so LineStrings that were drawn a little
// short of touching (e.g. sketched in separate editing passes) still count
// as connected. This comfortably covers the ~10m gaps that hand-drawn
// GeoJSON routes tend to leave between segments that were meant to join.
const NODE_TOLERANCE_M = 25;

/**
 * @typedef {Object} DayStats
 * @property {number} day
 * @property {string} from
 * @property {string} to
 * @property {number} paddleLengthKm
 * @property {number} portageLengthKm
 * @property {number} portageCount
 */

/**
 * Builds a day-by-day breakdown of a canoe trip from its route GeoJSON.
 *
 * The route network (paddle + portage LineStrings) is modelled as a graph so
 * that loops, out-and-backs, and combinations of both are handled correctly:
 * dead ends in the mapped network (e.g. a paddle across the access lake that
 * wasn't drawn as its own line) are connected back to the nearest access
 * point, and each day's path is the shortest route between that day's
 * waypoints. Travel is only allowed to pass through an access point on the
 * first or last day.
 *
 * Most trips have a single access point used for both put-in and take-out
 * (a loop or out-and-back). Some trips instead have two access points,
 * labeled "Start" and "End" (e.g. a one-way river trip with a shuttle), in
 * which case the trip runs Start -> campsites -> End instead of looping
 * back to the same point.
 *
 * @param {Object} geojson
 * @param {string} [context] Optional label (e.g. trip title/slug) included
 *   in console warnings to make it easier to find which trip's data needs
 *   fixing when a day's route can't be found.
 * @returns {DayStats[]|null}
 */
export function calculateDailyTripStats(geojson, context = 'trip') {
    if (!geojson?.features?.length) {
        return null;
    }

    const accessPoints = findAccessPoints(geojson);
    if (!accessPoints) {
        console.warn(
            `[dailyTripStats] ${context}: no access_point Point feature found ` +
                `(properties.tourism must be "access_point"). Skipping daily breakdown.`,
        );
        return null;
    }

    const campsites = findCampsites(geojson);
    if (campsites.length === 0) {
        console.warn(
            `[dailyTripStats] ${context}: no camp_site Point features with a numeric ` +
                `"label" property found (properties.tourism must be "camp_site"). Skipping daily breakdown.`,
        );
        return null;
    }

    const segments = extractRouteSegments(geojson);
    if (segments.length === 0) {
        console.warn(`[dailyTripStats] ${context}: no route LineString features found. Skipping daily breakdown.`);
        return null;
    }

    const startLabel = accessPoints.isLoop ? 'Access point' : 'Start';
    const endLabel = accessPoints.isLoop ? 'Access point' : 'End';

    const waypoints = [
        { label: startLabel, coordinates: accessPoints.start },
        ...campsites.map((campsite) => ({
            label: `Campsite ${campsite.night}`,
            coordinates: campsite.coordinates,
        })),
    ];
    if (!accessPoints.isLoop) {
        waypoints.push({ label: endLabel, coordinates: accessPoints.end });
    }

    const graph = buildRouteGraph(segments, waypoints);
    const startNodeId = graph.waypointNodeId[0];
    const endNodeId = accessPoints.isLoop
        ? startNodeId
        : graph.waypointNodeId[waypoints.length - 1];
    const accessNodeIds =
        startNodeId === endNodeId ? [startNodeId] : [startNodeId, endNodeId];

    connectDanglingEndsToAccess(graph, {
        startNodeId,
        endNodeId,
        startCoordinates: accessPoints.start,
        endCoordinates: accessPoints.end,
    });

    const dayCount = accessPoints.isLoop ? waypoints.length : waypoints.length - 1;

    const days = [];
    for (let index = 0; index < dayCount; index++) {
        const toIndex = accessPoints.isLoop ? (index + 1) % waypoints.length : index + 1;
        const from = waypoints[index];
        const to = waypoints[toIndex];
        const fromNodeId = graph.waypointNodeId[index];
        const toNodeId = graph.waypointNodeId[toIndex];

        const excludeNodeIds = accessNodeIds.filter(
            (nodeId) => nodeId !== fromNodeId && nodeId !== toNodeId,
        );

        const path = findDayPath(graph.edges, fromNodeId, toNodeId, excludeNodeIds);
        if (!path) {
            // The route network doesn't connect these two waypoints at all
            // (e.g. a mapping gap). Fabricating a zero-distance day would be
            // misleading, so skip the whole breakdown for this trip.
            console.warn(
                `[dailyTripStats] ${context}: no route found for day ${index + 1} ` +
                    `(${from.label} @ [${from.coordinates}] -> ${to.label} @ [${to.coordinates}]). ` +
                    `Check that the GeoJSON route LineStrings actually connect these points.`,
            );
            return null;
        }

        const dayStats = summarizePath(path);

        days.push({
            day: index + 1,
            from: from.label,
            to: to.label,
            paddleLengthKm: roundKm(dayStats.paddleLengthM),
            portageLengthKm: roundKm(dayStats.portageLengthM),
            portageCount: dayStats.portageCount,
        });
    }

    if (!isPlausibleBreakdown(days, segments)) {
        const dayTotalKm = days.reduce(
            (sum, day) => sum + day.paddleLengthKm + day.portageLengthKm,
            0,
        );
        const routeTotalKm =
            segments.reduce((sum, segment) => sum + calculateLineStringLength(segment.coordinates), 0) /
            1000;
        console.warn(
            `[dailyTripStats] ${context}: rejected implausible breakdown ` +
                `(days sum to ${dayTotalKm.toFixed(1)}km vs ${routeTotalKm.toFixed(1)}km of mapped route). ` +
                `This usually means a day's path detoured through most of the network instead of a ` +
                `direct route, which points to a missing/disconnected LineString. Per-day breakdown: ` +
                days
                    .map(
                        (day) =>
                            `day ${day.day} (${day.from} -> ${day.to}): ${day.paddleLengthKm}km paddle + ${day.portageLengthKm}km portage`,
                    )
                    .join('; '),
        );
        return null;
    }

    return days;
}

// When the mapped route network is too fragmented to route through
// confidently, the graph falls back to long detours through the access
// point's dead-end connections. If the resulting days add up to
// substantially more distance than the route actually contains, the
// breakdown isn't trustworthy, so we skip rendering it rather than show
// misleading numbers.
const PLAUSIBLE_DISTANCE_RATIO = 1.3;

function isPlausibleBreakdown(days, segments) {
    const dayTotalM = days.reduce(
        (sum, day) => sum + (day.paddleLengthKm + day.portageLengthKm) * 1000,
        0,
    );
    const routeTotalM = segments.reduce(
        (sum, segment) => sum + calculateLineStringLength(segment.coordinates),
        0,
    );

    return routeTotalM > 0 && dayTotalM <= routeTotalM * PLAUSIBLE_DISTANCE_RATIO;
}

function calculateLineStringLength(coordinates) {
    let totalLength = 0;
    for (let i = 0; i < coordinates.length - 1; i++) {
        totalLength += haversineDistance(coordinates[i], coordinates[i + 1]);
    }
    return totalLength;
}

/**
 * Finds the trip's access point(s). Trips with a single access_point use it
 * as both the start and end (a loop or out-and-back). Trips with two
 * access_point features labeled "Start" and "End" (case-insensitive) treat
 * them as distinct put-in/take-out points.
 */
function findAccessPoints(geojson) {
    const features = geojson.features.filter(
        (entry) =>
            entry.geometry?.type === 'Point' &&
            entry.properties?.tourism === 'access_point',
    );

    if (features.length === 0) {
        return null;
    }

    if (features.length >= 2) {
        const startFeature = features.find(
            (feature) => String(feature.properties?.label ?? '').toLowerCase() === 'start',
        );
        const endFeature = features.find(
            (feature) => String(feature.properties?.label ?? '').toLowerCase() === 'end',
        );

        if (startFeature && endFeature) {
            return {
                start: startFeature.geometry.coordinates,
                end: endFeature.geometry.coordinates,
                isLoop: false,
            };
        }
    }

    return {
        start: features[0].geometry.coordinates,
        end: features[0].geometry.coordinates,
        isLoop: true,
    };
}

function findCampsites(geojson) {
    return geojson.features
        .filter(
            (feature) =>
                feature.geometry?.type === 'Point' &&
                feature.properties?.tourism === 'camp_site',
        )
        .map((feature) => ({
            coordinates: feature.geometry.coordinates,
            night: parseInt(String(feature.properties?.label ?? ''), 10),
        }))
        .filter((campsite) => Number.isFinite(campsite.night))
        .sort((a, b) => a.night - b.night);
}

// Route data is often pulled in from other sources (rivers, trails, etc.)
// and won't always carry an explicit canoe=yes tag the way hand-drawn
// paddle segments do. Rather than silently dropping those segments (and
// fragmenting the route network), treat any LineString as paddleable
// unless it's explicitly tagged as a portage.
function extractRouteSegments(geojson) {
    return geojson.features
        .filter((feature) => feature.geometry?.type === 'LineString')
        .map((feature) => ({
            coordinates: feature.geometry.coordinates,
            canoe: feature.properties?.canoe === 'portage' ? 'portage' : 'yes',
        }));
}

/**
 * Builds a graph of the route network. Nodes are clustered segment
 * endpoints; each waypoint is inserted by splitting the nearest edge at its
 * closest point on the route.
 */
function buildRouteGraph(segments, waypoints) {
    const preparedSegments = segments.map((segment) => {
        const cumulative = computeCumulativeDistances(segment.coordinates);
        return {
            ...segment,
            cumulative,
            length: cumulative.at(-1),
        };
    });

    const nodeCoordinates = [];
    const nodeTouchCount = [];
    function getNodeId(coordinates) {
        for (let i = 0; i < nodeCoordinates.length; i++) {
            if (haversineDistance(nodeCoordinates[i], coordinates) <= NODE_TOLERANCE_M) {
                nodeTouchCount[i] += 1;
                return i;
            }
        }
        nodeCoordinates.push(coordinates);
        nodeTouchCount.push(1);
        return nodeCoordinates.length - 1;
    }

    preparedSegments.forEach((segment) => {
        segment.startNode = getNodeId(segment.coordinates[0]);
        segment.endNode = getNodeId(segment.coordinates.at(-1));
    });

    const danglingNodeIds = nodeTouchCount.reduce((ids, count, id) => {
        if (count === 1) {
            ids.push(id);
        }
        return ids;
    }, []);

    const insertions = waypoints.map((waypoint) =>
        findClosestPointOnRoute(waypoint.coordinates, preparedSegments),
    );

    const insertionsBySegment = new Map();
    insertions.forEach((insertion, waypointIndex) => {
        if (!insertionsBySegment.has(insertion.segmentIndex)) {
            insertionsBySegment.set(insertion.segmentIndex, []);
        }
        insertionsBySegment.get(insertion.segmentIndex).push({
            ...insertion,
            waypointIndex,
        });
    });

    const edges = [];
    const waypointNodeId = new Array(waypoints.length);

    preparedSegments.forEach((segment, segmentIndex) => {
        const segmentInsertions = (insertionsBySegment.get(segmentIndex) || [])
            .slice()
            .sort((a, b) => a.distanceAlong - b.distanceAlong);

        const points = [
            { distanceAlong: 0, nodeId: segment.startNode },
            ...segmentInsertions.map((insertion) => {
                const nodeId = nodeCoordinates.push(insertion.point) - 1;
                waypointNodeId[insertion.waypointIndex] = nodeId;
                return { distanceAlong: insertion.distanceAlong, nodeId };
            }),
            { distanceAlong: segment.length, nodeId: segment.endNode },
        ];

        for (let i = 0; i < points.length - 1; i++) {
            if (points[i].nodeId === points[i + 1].nodeId) {
                continue;
            }
            // A waypoint can project onto a point that's effectively at (or
            // past, due to floating point) an existing node, giving a
            // zero/negative-length gap. Still add the edge (clamped to 0)
            // rather than dropping it, otherwise the waypoint's inserted
            // node would be left disconnected from the rest of the segment.
            const length = Math.max(0, points[i + 1].distanceAlong - points[i].distanceAlong);
            edges.push({
                from: points[i].nodeId,
                to: points[i + 1].nodeId,
                length,
                canoe: segment.canoe,
            });
        }
    });

    return { edges, waypointNodeId, danglingNodeIds, nodeCoordinates };
}

function computeCumulativeDistances(coordinates) {
    const cumulative = [0];
    for (let i = 0; i < coordinates.length - 1; i++) {
        cumulative.push(
            cumulative[i] + haversineDistance(coordinates[i], coordinates[i + 1]),
        );
    }
    return cumulative;
}

function findClosestPointOnRoute(point, preparedSegments) {
    let best = { distanceFromPoint: Infinity };

    preparedSegments.forEach((segment, segmentIndex) => {
        for (let i = 0; i < segment.coordinates.length - 1; i++) {
            const start = segment.coordinates[i];
            const end = segment.coordinates[i + 1];
            const projection = projectPointOnSegment(point, start, end);
            const distanceFromPoint = haversineDistance(point, projection.point);

            if (distanceFromPoint < best.distanceFromPoint) {
                const distanceAlong =
                    segment.cumulative[i] +
                    projection.t * (segment.cumulative[i + 1] - segment.cumulative[i]);
                best = {
                    distanceFromPoint,
                    segmentIndex,
                    distanceAlong,
                    point: projection.point,
                };
            }
        }
    });

    return best;
}

function projectPointOnSegment(point, start, end) {
    const dx = end[0] - start[0];
    const dy = end[1] - start[1];

    if (dx === 0 && dy === 0) {
        return { point: start, t: 0 };
    }

    let t =
        ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) /
        (dx * dx + dy * dy);
    t = Math.max(0, Math.min(1, t));

    return { point: [start[0] + dx * t, start[1] + dy * t], t };
}

/**
 * Some routes only reach an access point via an unmapped stretch of open
 * water (e.g. paddling across the launch lake). Any dead end left in the
 * network is assumed to connect back to whichever access point is closer,
 * which is what lets a route's outbound and inbound legs share the same
 * "spur" and lets loops close properly.
 */
function connectDanglingEndsToAccess(graph, access) {
    const { startNodeId, endNodeId, startCoordinates, endCoordinates } = access;

    graph.danglingNodeIds.forEach((nodeId) => {
        if (nodeId === startNodeId || nodeId === endNodeId) {
            return;
        }

        const coordinates = graph.nodeCoordinates[nodeId];
        const distanceToStart = haversineDistance(startCoordinates, coordinates);
        const distanceToEnd = haversineDistance(endCoordinates, coordinates);
        const useStart = distanceToStart <= distanceToEnd;

        graph.edges.push({
            from: useStart ? startNodeId : endNodeId,
            to: nodeId,
            length: useStart ? distanceToStart : distanceToEnd,
            canoe: 'yes',
        });
    });
}

/**
 * Finds the shortest path for a single day. Middle days are not allowed to
 * pass through an access point that isn't one of that day's own endpoints;
 * if excluding it leaves no path (the route network can't otherwise connect
 * those waypoints), we fall back to allowing it. Returns null if the two
 * waypoints aren't connected at all, even allowing access points.
 */
function findDayPath(edges, fromNodeId, toNodeId, excludeNodeIds) {
    if (excludeNodeIds.length > 0) {
        const restrictedPath = shortestPath(edges, fromNodeId, toNodeId, excludeNodeIds);
        if (restrictedPath) {
            return restrictedPath;
        }
    }

    return shortestPath(edges, fromNodeId, toNodeId, []);
}

function shortestPath(edges, startId, endId, excludeNodeIds) {
    const excluded = new Set(excludeNodeIds);
    const adjacency = new Map();
    edges.forEach((edge) => {
        if (excluded.has(edge.from) || excluded.has(edge.to)) {
            return;
        }
        if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
        if (!adjacency.has(edge.to)) adjacency.set(edge.to, []);
        adjacency.get(edge.from).push({ to: edge.to, edge });
        adjacency.get(edge.to).push({ to: edge.from, edge });
    });

    const distances = new Map([[startId, 0]]);
    const previous = new Map();
    const visited = new Set();
    const queue = [[0, startId]];

    while (queue.length > 0) {
        queue.sort((a, b) => a[0] - b[0]);
        const [distance, nodeId] = queue.shift();

        if (visited.has(nodeId)) {
            continue;
        }
        visited.add(nodeId);

        if (nodeId === endId) {
            break;
        }

        (adjacency.get(nodeId) || []).forEach(({ to, edge }) => {
            const newDistance = distance + edge.length;
            if (newDistance < (distances.get(to) ?? Infinity)) {
                distances.set(to, newDistance);
                previous.set(to, { from: nodeId, edge });
                queue.push([newDistance, to]);
            }
        });
    }

    if (!distances.has(endId)) {
        return null;
    }

    const path = [];
    let current = endId;
    while (current !== startId) {
        const step = previous.get(current);
        if (!step) {
            return null;
        }
        path.unshift(step.edge);
        current = step.from;
    }

    return path;
}

function summarizePath(path) {
    let paddleLengthM = 0;
    let portageLengthM = 0;
    let portageCount = 0;
    let previousCanoe = null;

    path.forEach((edge) => {
        if (edge.canoe === 'portage') {
            portageLengthM += edge.length;
            if (previousCanoe !== 'portage') {
                portageCount += 1;
            }
        } else {
            paddleLengthM += edge.length;
        }
        previousCanoe = edge.canoe;
    });

    return { paddleLengthM, portageLengthM, portageCount };
}

function roundKm(lengthM) {
    return Math.round((lengthM / 1000) * 10) / 10;
}
