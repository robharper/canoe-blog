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
 * @typedef {Object} WaypointNames
 * @property {string} [start] Display name for the put-in access point
 * @property {string} [end] Display name for the take-out access point (one-way trips)
 * @property {Record<number, string>} [campsites] Display names keyed by campsite night number
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
 * A trip with exactly one campsite is a one-night out-and-back: since the
 * outbound and return legs are the same journey rather than independently
 * routable days, this case is instead computed from the network's graph
 * structure directly (see calculateOutAndBackDailyStats) rather than by
 * shortest-pathing between waypoints. The whole mapped network is known to
 * have been travelled (there and back), so this doesn't require - or use -
 * an access_point feature at all.
 *
 * @param {Object} geojson
 * @param {string} [context] Optional label (e.g. trip title/slug) included
 *   in console warnings to make it easier to find which trip's data needs
 *   fixing when a day's route can't be found.
 * @param {WaypointNames} [waypointNames] Optional display names from trip
 *   front matter for access points and campsite nights.
 * @returns {DayStats[]|null}
 */
export function calculateDailyTripStats(geojson, context = 'trip', waypointNames = {}) {
    if (!geojson?.features?.length) {
        return null;
    }

    const campsites = findCampsites(geojson);
    if (campsites.length === 0) {
        console.warn(
            `[dailyTripStats] ${context}: no camp_site Point features found ` +
                `(properties.tourism must be "camp_site"). Skipping daily breakdown.`,
        );
        return null;
    }

    const segments = extractRouteSegments(geojson);
    if (segments.length === 0) {
        console.warn(`[dailyTripStats] ${context}: no route LineString features found. Skipping daily breakdown.`);
        return null;
    }

    // A one-night trip's single campsite is reached and left by the same
    // route there and back, so the whole mapped network is known to have
    // been travelled - no access_point feature is needed to work out how.
    if (campsites.length === 1) {
        return calculateOutAndBackDailyStats(segments, campsites[0], context, waypointNames);
    }

    const accessPoints = findAccessPoints(geojson);
    if (!accessPoints) {
        console.warn(
            `[dailyTripStats] ${context}: no access_point Point feature found ` +
                `(properties.tourism must be "access_point"). Skipping daily breakdown.`,
        );
        return null;
    }

    const startLabel =
        waypointNames.start ?? (accessPoints.isLoop ? 'Access point' : 'Start');
    const endLabel =
        waypointNames.end ?? (accessPoints.isLoop ? 'Access point' : 'End');

    const waypoints = [
        { label: startLabel, coordinates: accessPoints.start },
        ...campsites.map((campsite) => ({
            label: getCampsiteLabel(campsite.night, waypointNames),
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

    // Order matters: bridge genuinely disconnected pieces of the network
    // together first, at their cheapest real connection points, before
    // adding the access-point shortcuts below. Doing it in the other order
    // would let a long "dangling end -> access" shortcut prematurely union
    // two components, masking a much shorter bridge between them that the
    // MST pass would otherwise have found.
    connectDisconnectedComponents(graph, context);
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
function getCampsiteLabel(night, waypointNames) {
    const name = waypointNames?.campsites?.[night];
    return name ?? `Campsite ${night}`;
}

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
    const campsiteFeatures = geojson.features.filter(
        (feature) =>
            feature.geometry?.type === 'Point' && feature.properties?.tourism === 'camp_site',
    );

    // A "night" label only exists to order/disambiguate multiple camps; a
    // one-night trip's single campsite doesn't need one.
    if (campsiteFeatures.length === 1) {
        return [{ coordinates: campsiteFeatures[0].geometry.coordinates, night: 1 }];
    }

    return campsiteFeatures
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
            coordinates: collapseOutAndBackTrail(feature.geometry.coordinates),
            canoe: feature.properties?.canoe === 'portage' ? 'portage' : 'yes',
        }));
}

/**
 * Some portage trails are mapped as a GPS "there and back" track: walk out
 * to the far end, then retrace the exact same points back to the start.
 * As a single LineString this starts and ends at the same coordinate, so
 * it collapses to a zero-length loop in the route graph and the trail
 * (and the connection it makes to whatever is at its far end) is lost
 * entirely. Detect the mirror-image pattern around the track's middle
 * point and keep just the outbound half, so the trail's true one-way
 * length and destination are preserved.
 */
function collapseOutAndBackTrail(coordinates) {
    const pointCount = coordinates.length;
    if (pointCount < 5 || pointCount % 2 === 0) {
        return coordinates;
    }

    const middleIndex = (pointCount - 1) / 2;
    for (let i = 0; i < middleIndex; i++) {
        if (haversineDistance(coordinates[i], coordinates[pointCount - 1 - i]) > NODE_TOLERANCE_M) {
            return coordinates;
        }
    }

    return coordinates.slice(0, middleIndex + 1);
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
    function getNodeId(coordinates) {
        for (let i = 0; i < nodeCoordinates.length; i++) {
            if (haversineDistance(nodeCoordinates[i], coordinates) <= NODE_TOLERANCE_M) {
                return i;
            }
        }
        nodeCoordinates.push(coordinates);
        return nodeCoordinates.length - 1;
    }

    preparedSegments.forEach((segment) => {
        segment.startNode = getNodeId(segment.coordinates[0]);
        segment.endNode = getNodeId(segment.coordinates.at(-1));
    });

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

    return { edges, waypointNodeId, nodeCoordinates };
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

function computeNodeDegrees(graph) {
    const degree = new Array(graph.nodeCoordinates.length).fill(0);
    graph.edges.forEach((edge) => {
        degree[edge.from] += 1;
        degree[edge.to] += 1;
    });
    return degree;
}

/**
 * Some routes only reach an access point via an unmapped stretch of open
 * water (e.g. paddling across the launch lake, or the last bit of a spur
 * that wasn't drawn all the way to the put-in). Any dead end left in the
 * network - even one that's already reachable from access via a long way
 * around the rest of the network - is given a direct, straight-line edge
 * back to whichever access point is closer. This is what lets a route's
 * outbound and inbound legs share the same "spur" and lets loops close
 * properly; Dijkstra will only ever use it when it's actually the shortest
 * option, so it's harmless to add even when a shorter path already exists.
 */
function connectDanglingEndsToAccess(graph, access) {
    const { startNodeId, endNodeId, startCoordinates, endCoordinates } = access;
    const degree = computeNodeDegrees(graph);

    graph.nodeCoordinates.forEach((coordinates, nodeId) => {
        if (degree[nodeId] !== 1 || nodeId === startNodeId || nodeId === endNodeId) {
            return;
        }

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

// Above this distance, a bridge between two disconnected pieces of the
// route network is unlikely to represent a real, paddleable gap (e.g. a
// short unmapped crossing of the launch lake) and more likely means a
// LineString is missing from the source data entirely. We still add the
// bridge (so the trip can compute at all / the plausibility check can
// reject it with a useful reason) but log it so it can be tracked down.
const SUSPICIOUS_BRIDGE_DISTANCE_M = 300;

/**
 * The mapped route network is often split into several disconnected pieces:
 * a paddle across the launch lake that wasn't drawn as its own line, a
 * campsite's little bay that's a separate LineString from the main lake, an
 * out-and-back spur that should close back on the access point, etc.
 *
 * Rather than only bridging dead ends back to the trip's access point(s),
 * this finds every disconnected piece of the network and joins them
 * together with the shortest possible set of bridges - a minimum spanning
 * tree over every node in the graph - so a campsite stranded on its own
 * little island of LineStrings (which may itself be a small closed loop
 * with no degree-1 "dead end" of its own, e.g. a duplicated or looping
 * portage trail) connects at its nearest real gap, possibly via one or more
 * other stranded islands, instead of being routed all the way back to
 * access as one long straight-line "shortcut".
 */
function connectDisconnectedComponents(graph, context) {
    const parent = new Map();
    function find(id) {
        let root = id;
        while (parent.has(root) && parent.get(root) !== root) {
            root = parent.get(root);
        }
        parent.set(id, root);
        return root;
    }
    function union(a, b) {
        const rootA = find(a);
        const rootB = find(b);
        if (rootA === rootB) {
            return false;
        }
        parent.set(rootA, rootB);
        return true;
    }

    graph.nodeCoordinates.forEach((_, id) => {
        if (!parent.has(id)) {
            parent.set(id, id);
        }
    });
    graph.edges.forEach((edge) => union(edge.from, edge.to));

    // Every node is a candidate bridge endpoint. A stranded island can be a
    // small loop where every node already has degree >= 2 within its own
    // island, so restricting candidates to degree-1 "dead ends" would miss
    // it entirely; considering all nodes (and only ever bridging pairs that
    // aren't already in the same component) reliably finds the true
    // nearest gap between any two disconnected pieces.
    const candidates = graph.nodeCoordinates.map((_, id) => id);

    const candidatePairs = [];
    for (let i = 0; i < candidates.length; i++) {
        for (let j = i + 1; j < candidates.length; j++) {
            const a = candidates[i];
            const b = candidates[j];
            if (find(a) === find(b)) {
                continue;
            }
            candidatePairs.push({
                a,
                b,
                distance: haversineDistance(graph.nodeCoordinates[a], graph.nodeCoordinates[b]),
            });
        }
    }
    candidatePairs.sort((pairA, pairB) => pairA.distance - pairB.distance);

    candidatePairs.forEach(({ a, b, distance }) => {
        if (!union(a, b)) {
            return;
        }

        graph.edges.push({ from: a, to: b, length: distance, canoe: 'yes' });

        if (distance > SUSPICIOUS_BRIDGE_DISTANCE_M) {
            console.warn(
                `[dailyTripStats] ${context}: bridged a ${(distance / 1000).toFixed(1)}km gap between ` +
                    `[${graph.nodeCoordinates[a]}] and [${graph.nodeCoordinates[b]}] to keep the route ` +
                    `network connected. This likely means a LineString is missing from the GeoJSON ` +
                    `between these two points.`,
            );
        }
    });
}

/**
 * Computes the two-day breakdown for a one-night out-and-back trip (a
 * single campsite reached and left by the same route, possibly with some
 * paddling/portage loops along the way).
 *
 * The whole mapped network is known to have been travelled there and
 * back, so unlike a multi-night trip this doesn't need to know where
 * access is, or route between waypoints at all. Every edge is first
 * classified as a "spur" (a bridge - the only way across that part of the
 * network, so both days paddle/portage it in full) or part of a "loop"
 * (an alternate route exists around it). Rather than just splitting a
 * loop's total length evenly, each loop is treated as an actual cycle:
 * one of its two arcs (the path between the two points where it attaches
 * to the rest of the network) is assigned to day 1, the other to day 2 -
 * so a day's distance and portage count reflect one real path around the
 * loop, not half of both paths blended together. The longer arc of every
 * loop is assigned to day 1 (the outbound leg) and the shorter arc to
 * day 2 (the return leg).
 *
 * A loop that isn't a simple cycle between exactly two attachment points
 * (e.g. it has a chord, more than two spurs branching off it, or no spur
 * at all) can't be cleanly split into "one path per day" this way; those
 * fall back to the simpler split-the-total-in-half treatment.
 */
function calculateOutAndBackDailyStats(segments, campsite, context, waypointNames) {
    // Inserting the campsite as a real graph node (rather than leaving it
    // as an unattached coordinate) matters when the whole route is one
    // single loop reached by a single spur: the loop only has one real
    // attachment point in that case, but the campsite - wherever it sits
    // on the loop - is exactly where day 1 has to end and day 2 begin, so
    // it acts as the loop's second split point.
    const graph = buildRouteGraph(segments, [{ label: 'campsite', coordinates: campsite.coordinates }]);
    const campsiteNodeId = graph.waypointNodeId[0];
    connectDisconnectedComponents(graph, context);

    const isBridge = findBridgeEdges(graph.edges, graph.nodeCoordinates.length);
    const { cleanLoops, fallbackEdgeIndices } = findLoopArcs(graph, isBridge, campsiteNodeId);
    const edgeDay = assignLoopArcsToDays(graph, isBridge, cleanLoops, fallbackEdgeIndices);

    let day1PaddleM = 0;
    let day2PaddleM = 0;
    let day1PortageM = 0;
    let day2PortageM = 0;
    graph.edges.forEach((edge, edgeIndex) => {
        const day = edgeDay[edgeIndex];
        const day1Length = day === 'both' || day === 'day1' ? edge.length : day === 'split' ? edge.length / 2 : 0;
        const day2Length = day === 'both' || day === 'day2' ? edge.length : day === 'split' ? edge.length / 2 : 0;
        if (edge.canoe === 'portage') {
            day1PortageM += day1Length;
            day2PortageM += day2Length;
        } else {
            day1PaddleM += day1Length;
            day2PaddleM += day2Length;
        }
    });

    let day1PortageCount = 0;
    let day2PortageCount = 0;
    // A portage can't be split fractionally like a length can; crossings
    // that fall back to the even-split treatment are tallied separately so
    // an odd number of them can be rounded (favouring day 1) once at the
    // end, same as an individual loop-less trip would be.
    let splitPortageCrossings = 0;
    groupPortageSegments(graph.edges).forEach((edgeIndices) => {
        const days = new Set(edgeIndices.map((edgeIndex) => edgeDay[edgeIndex]));
        // A single physical portage should only ever fall in one category,
        // but if it somehow straddles two (e.g. a mapping quirk puts part
        // of it on each arc of a loop), fall back to the even-split
        // treatment rather than double-counting or dropping it.
        const day = days.size === 1 ? [...days][0] : 'split';

        if (day === 'both') {
            day1PortageCount += 1;
            day2PortageCount += 1;
        } else if (day === 'day1') {
            day1PortageCount += 1;
        } else if (day === 'day2') {
            day2PortageCount += 1;
        } else {
            splitPortageCrossings += 1;
        }
    });
    // Favour day 1 when the fallback total can't be split evenly.
    day1PortageCount += Math.ceil(splitPortageCrossings / 2);
    day2PortageCount += Math.floor(splitPortageCrossings / 2);

    const startLabel = waypointNames.start ?? 'Access point';
    const endLabel = waypointNames.end ?? 'Access point';
    const campsiteLabel = getCampsiteLabel(campsite.night, waypointNames);

    return [
        {
            day: 1,
            from: startLabel,
            to: campsiteLabel,
            paddleLengthKm: roundKm(day1PaddleM),
            portageLengthKm: roundKm(day1PortageM),
            portageCount: day1PortageCount,
        },
        {
            day: 2,
            from: campsiteLabel,
            to: endLabel,
            paddleLengthKm: roundKm(day2PaddleM),
            portageLengthKm: roundKm(day2PortageM),
            portageCount: day2PortageCount,
        },
    ];
}

/**
 * Finds every "loop" in the route network - a maximal set of non-bridge
 * edges that all lie on cycles together - and, where possible, splits it
 * into two arcs between its two split points. A loop only qualifies for
 * this clean split when every one of its nodes has exactly two internal
 * connections (i.e. it really is one simple ring, not a more tangled mesh
 * of overlapping cycles) and it has exactly two split points; anything
 * else (a lone loop with no spur and no campsite on it, one with three+
 * split points, or one with a chord across it) is returned separately so
 * the caller can fall back to a simpler treatment.
 *
 * A loop's split points are the points where it attaches to the rest of
 * the network (its bridges), plus the campsite node itself if the
 * campsite happens to sit on this particular loop - even a loop with only
 * one real bridge attachment still splits cleanly into a day-1 arc and a
 * day-2 arc around the campsite in that case, the same way a loop with
 * two bridge attachments splits around them.
 *
 * @returns {{
 *   cleanLoops: Array<{ arcA: number[], arcB: number[] }>,
 *   fallbackEdgeIndices: number[],
 * }}
 */
function findLoopArcs(graph, isBridge, campsiteNodeId) {
    const nodeCount = graph.nodeCoordinates.length;
    const parent = Array.from({ length: nodeCount }, (_, index) => index);
    function find(id) {
        let root = id;
        while (parent[root] !== root) {
            root = parent[root];
        }
        parent[id] = root;
        return root;
    }
    function union(a, b) {
        const rootA = find(a);
        const rootB = find(b);
        if (rootA !== rootB) {
            parent[rootA] = rootB;
        }
    }
    graph.edges.forEach((edge, index) => {
        if (!isBridge[index]) {
            union(edge.from, edge.to);
        }
    });

    const componentNodes = new Map();
    for (let node = 0; node < nodeCount; node++) {
        const root = find(node);
        if (!componentNodes.has(root)) {
            componentNodes.set(root, []);
        }
        componentNodes.get(root).push(node);
    }

    const adjacency = Array.from({ length: nodeCount }, () => []);
    graph.edges.forEach((edge, index) => {
        adjacency[edge.from].push({ to: edge.to, edgeIndex: index });
        adjacency[edge.to].push({ to: edge.from, edgeIndex: index });
    });

    const cleanLoops = [];
    const fallbackEdgeIndices = [];

    componentNodes.forEach((nodes) => {
        if (nodes.length < 2) {
            return;
        }

        const nodeSet = new Set(nodes);
        const internalEdges = [];
        const internalDegree = new Map();
        const attachmentNodes = new Set();

        graph.edges.forEach((edge, index) => {
            if (isBridge[index]) {
                if (nodeSet.has(edge.from)) attachmentNodes.add(edge.from);
                if (nodeSet.has(edge.to)) attachmentNodes.add(edge.to);
                return;
            }
            if (nodeSet.has(edge.from) && nodeSet.has(edge.to)) {
                internalEdges.push(index);
                internalDegree.set(edge.from, (internalDegree.get(edge.from) ?? 0) + 1);
                internalDegree.set(edge.to, (internalDegree.get(edge.to) ?? 0) + 1);
            }
        });

        if (nodeSet.has(campsiteNodeId)) {
            attachmentNodes.add(campsiteNodeId);
        }

        const isSimpleCycle = nodes.every((node) => internalDegree.get(node) === 2);

        if (isSimpleCycle && attachmentNodes.size === 2) {
            const [nodeA, nodeB] = [...attachmentNodes];
            const arcA = walkCycleArc(nodeA, nodeB, adjacency, new Set(internalEdges));
            if (arcA && arcA.length < internalEdges.length) {
                const arcASet = new Set(arcA);
                const arcB = internalEdges.filter((index) => !arcASet.has(index));
                cleanLoops.push({ arcA, arcB });
                return;
            }
        }

        fallbackEdgeIndices.push(...internalEdges);
    });

    return { cleanLoops, fallbackEdgeIndices };
}

/**
 * Walks a simple cycle from startNode to endNode using only edges in
 * edgeSet, without reusing an edge. Since every node on a simple cycle has
 * exactly two connections within it, always stepping to whichever
 * connection isn't the one just arrived on traces out one unambiguous arc
 * of the cycle. Returns null if the walk runs out of edges before
 * reaching endNode (which shouldn't happen for a genuine simple cycle).
 */
function walkCycleArc(startNode, endNode, adjacency, edgeSet) {
    const path = [];
    let current = startNode;
    let previousEdgeIndex = -1;

    while (current !== endNode) {
        const next = adjacency[current].find(
            ({ edgeIndex }) => edgeSet.has(edgeIndex) && edgeIndex !== previousEdgeIndex,
        );
        if (!next) {
            return null;
        }
        path.push(next.edgeIndex);
        previousEdgeIndex = next.edgeIndex;
        current = next.to;
    }

    return path;
}

/**
 * Decides, for every edge, which day it counts towards: 'both' (a spur,
 * paddled/portaged in full on both days), 'day1'/'day2' (one specific arc
 * of a clean loop), or 'split' (a loop that couldn't be cleanly split into
 * one path per day, so it's shared evenly between both days instead).
 *
 * For every clean loop, the longer of its two arcs always goes to day 1
 * (the outbound leg) and the shorter arc to day 2 (the return leg).
 */
function assignLoopArcsToDays(graph, isBridge, cleanLoops, fallbackEdgeIndices) {
    const edgeDay = isBridge.map((bridge) => (bridge ? 'both' : 'split'));

    const arcLength = (edgeIndices) =>
        edgeIndices.reduce((sum, edgeIndex) => sum + graph.edges[edgeIndex].length, 0);

    cleanLoops.forEach(({ arcA, arcB }) => {
        const [longerArc, shorterArc] = arcLength(arcA) >= arcLength(arcB) ? [arcA, arcB] : [arcB, arcA];
        longerArc.forEach((edgeIndex) => {
            edgeDay[edgeIndex] = 'day1';
        });
        shorterArc.forEach((edgeIndex) => {
            edgeDay[edgeIndex] = 'day2';
        });
    });

    // Loops that couldn't be cleanly split stay 'split' (the union-find
    // grouping above only walks bridges/loop edges it already classified
    // as bridges, so fallback loop edges are already 'split' by default;
    // this just documents/guards that explicitly).
    fallbackEdgeIndices.forEach((edgeIndex) => {
        edgeDay[edgeIndex] = 'split';
    });

    return edgeDay;
}

/**
 * Finds bridges in the route network graph: edges that don't lie on any
 * cycle, i.e. the only connection between the nodes on either side of them
 * (a paddling or portage "spur"). Any edge that's part of a loop - an
 * alternate route exists around it - is left unmarked.
 *
 * This is the standard low-link DFS bridge-finding algorithm, adapted for
 * a network that can have parallel edges between the same pair of nodes
 * (e.g. two separate portage trails between the same two lakes): it tracks
 * the *edge* used to reach each node, rather than just its parent node, so
 * that a second edge back to the parent is correctly recognised as an
 * alternate route rather than mistaken for retracing the parent edge.
 */
function findBridgeEdges(edges, nodeCount) {
    const adjacency = Array.from({ length: nodeCount }, () => []);
    edges.forEach((edge, edgeIndex) => {
        adjacency[edge.from].push({ to: edge.to, edgeIndex });
        adjacency[edge.to].push({ to: edge.from, edgeIndex });
    });

    const isBridge = new Array(edges.length).fill(false);
    const discovery = new Array(nodeCount).fill(-1);
    const low = new Array(nodeCount).fill(-1);
    let timer = 0;

    function visit(nodeId, parentEdgeIndex) {
        discovery[nodeId] = timer;
        low[nodeId] = timer;
        timer++;

        adjacency[nodeId].forEach(({ to, edgeIndex }) => {
            if (edgeIndex === parentEdgeIndex) {
                return;
            }
            if (discovery[to] === -1) {
                visit(to, edgeIndex);
                low[nodeId] = Math.min(low[nodeId], low[to]);
                if (low[to] > discovery[nodeId]) {
                    isBridge[edgeIndex] = true;
                }
            } else {
                low[nodeId] = Math.min(low[nodeId], discovery[to]);
            }
        });
    }

    for (let nodeId = 0; nodeId < nodeCount; nodeId++) {
        if (discovery[nodeId] === -1) {
            visit(nodeId, -1);
        }
    }

    return isBridge;
}

/**
 * Groups portage edges into physical portage crossings: chains of
 * portage-tagged edges that connect end-to-end. A single mapped portage
 * trail is usually a single edge, but can be split into several if a
 * waypoint happens to land partway along it. Paddle edges are ignored when
 * grouping, so a portage that shares a node with a paddle route doesn't
 * get merged into it.
 */
function groupPortageSegments(edges) {
    const portageEdgeIndices = [];
    edges.forEach((edge, index) => {
        if (edge.canoe === 'portage') {
            portageEdgeIndices.push(index);
        }
    });

    const parent = new Map(portageEdgeIndices.map((index) => [index, index]));
    function find(id) {
        let root = id;
        while (parent.get(root) !== root) {
            root = parent.get(root);
        }
        parent.set(id, root);
        return root;
    }
    function union(a, b) {
        parent.set(find(a), find(b));
    }

    const nodeToPortageEdges = new Map();
    portageEdgeIndices.forEach((index) => {
        const edge = edges[index];
        [edge.from, edge.to].forEach((nodeId) => {
            if (!nodeToPortageEdges.has(nodeId)) {
                nodeToPortageEdges.set(nodeId, []);
            }
            nodeToPortageEdges.get(nodeId).push(index);
        });
    });
    nodeToPortageEdges.forEach((indices) => {
        for (let i = 1; i < indices.length; i++) {
            union(indices[0], indices[i]);
        }
    });

    const groups = new Map();
    portageEdgeIndices.forEach((index) => {
        const root = find(index);
        if (!groups.has(root)) {
            groups.set(root, []);
        }
        groups.get(root).push(index);
    });

    return [...groups.values()];
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
