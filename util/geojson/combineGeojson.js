import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Get the directory name of the current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Define paths relative to the script's location
// Go up one level from 'util' to the project root 'canoe-blog'
const projectRoot = path.resolve(__dirname, '../..');
const inputDir = path.join(projectRoot, 'public', 'geo');
const outputFilePath = path.join(inputDir, 'all.geo.json');

/**
 * Calculates the square of the distance from a point to a line segment.
 */
function getSqSegDist(p, p1, p2) {
    let x = p1[0], y = p1[1],
        dx = p2[0] - x, dy = p2[1] - y;

    if (dx !== 0 || dy !== 0) {
        let t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
        if (t > 1) {
            x = p2[0];
            y = p2[1];
        } else if (t > 0) {
            x += dx * t;
            y += dy * t;
        }
    }
    dx = p[0] - x;
    dy = p[1] - y;
    return dx * dx + dy * dy;
}

/**
 * Douglas-Peucker simplification algorithm.
 */
function simplifyDP(points, sqTolerance) {
    const len = points.length;
    if (len <= 2) return points;

    let maxSqDist = 0;
    let index;

    for (let i = 1; i < len - 1; i++) {
        let sqDist = getSqSegDist(points[i], points[0], points[len - 1]);
        if (sqDist > maxSqDist) {
            index = i;
            maxSqDist = sqDist;
        }
    }

    if (maxSqDist > sqTolerance) {
        const left = simplifyDP(points.slice(0, index + 1), sqTolerance);
        const right = simplifyDP(points.slice(index), sqTolerance);
        return left.slice(0, -1).concat(right);
    }
    return [points[0], points[len - 1]];
}

/**
 * Simplifies an array of coordinates by rounding to 6 decimal places
 * and applying Douglas-Peucker simplification.
 */
function simplifyCoordinates(coords) {
    // 0.00001 degrees is approx 1.1m. 0.00002^2 is ~2.2m tolerance.
    const tolerance = 0.0002;
    const simplified = simplifyDP(coords, tolerance * tolerance);

    const factor = 1000000;
    return simplified.map(([lng, lat]) => [
        Math.round(lng * factor) / factor,
        Math.round(lat * factor) / factor
    ]);
}

function simplifyFeature(feature) {
    if (feature.geometry && feature.geometry.coordinates) {
        const type = feature.geometry.type;
        if (type === 'LineString') {
            feature.geometry.coordinates = simplifyCoordinates(feature.geometry.coordinates);
        } else if (type === 'MultiLineString' || type === 'Polygon') {
            feature.geometry.coordinates = feature.geometry.coordinates.map(simplifyCoordinates);
        } else if (type === 'MultiPolygon') {
            feature.geometry.coordinates = feature.geometry.coordinates.map(p => p.map(simplifyCoordinates));
        }
    }
    return feature;
}

async function combineGeoJSON() {
    console.log(`Starting GeoJSON combination process...`);
    console.log(`  Source directory: ${inputDir}`);
    console.log(`  Destination file: ${outputFilePath}`);

    let allFeatures = [];

    try {
        // Ensure the input directory exists
        if (!fs.existsSync(inputDir)) {
            console.error(`Error: Input directory not found at ${inputDir}`);
            process.exit(1);
        }

        const files = await fs.promises.readdir(inputDir);

        for (const file of files) {
            // Process only .geo.json files and exclude the output file itself
            if (file.endsWith('.geo.json') && file !== 'all.geo.json') {
                const filePath = path.join(inputDir, file);
                console.log(`  Processing: ${file}`);
                const fileContent = await fs.promises.readFile(filePath, 'utf8');
                const geojson = JSON.parse(fileContent);
                const slug = path.basename(file, '.geo.json');

                if (geojson.type === 'FeatureCollection' && Array.isArray(geojson.features)) {
                    const lineFeatures = geojson.features.filter(f =>
                        f.geometry && (f.geometry.type === 'LineString' || f.geometry.type === 'MultiLineString')
                    );
                    allFeatures = allFeatures.concat(lineFeatures.map(f => {
                        f.properties = f.properties || {};
                        f.properties.slug = slug;
                        return simplifyFeature(f);
                    }));
                } else if (geojson.type === 'Feature') {
                    if (geojson.geometry && (geojson.geometry.type === 'LineString' || geojson.geometry.type === 'MultiLineString')) {
                        geojson.properties = geojson.properties || {};
                        geojson.properties.slug = slug;
                        delete geojson.properties.featureGroup;
                        delete geojson.properties.source;                      
                        allFeatures.push(simplifyFeature(geojson));
                    }
                } else {
                    console.warn(`  Skipping ${file}: Not a valid FeatureCollection or Feature.`);
                }
            }
        }

        const combinedGeoJSON = {
            type: 'FeatureCollection',
            features: allFeatures,
        };

        // Ensure the output directory exists before writing (though it should exist if inputDir exists)
        const outputDir = path.dirname(outputFilePath);
        if (!fs.existsSync(outputDir)) {
            await fs.promises.mkdir(outputDir, { recursive: true });
        }

        await fs.promises.writeFile(outputFilePath, JSON.stringify(combinedGeoJSON, null, 2), 'utf8');
        // Save without indentation to further reduce file size
        await fs.promises.writeFile(outputFilePath, JSON.stringify(combinedGeoJSON), 'utf8');
        console.log(`\nSuccessfully combined ${allFeatures.length} features into ${outputFilePath}`);

    } catch (err) {
        console.error(`An unexpected error occurred: ${err.message}`);
        process.exit(1);
    }
}

combineGeoJSON();