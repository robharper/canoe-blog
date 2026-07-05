import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Setup paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');

const contentDir = path.join(projectRoot, 'src', 'content');
const geoDir = path.join(projectRoot, 'public', 'geo');

/**
 * Recursively finds all markdown files in a directory.
 */
async function getMdFiles(dir) {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const files = await Promise.all(entries.map((res) => {
        const resPath = path.resolve(dir, res.name);
        return res.isDirectory() ? getMdFiles(resPath) : resPath;
    }));
    return Array.prototype.concat(...files).filter(f => f.endsWith('.md'));
}

/**
 * Syncs the geojson file names with the .md file names in the content directory to the public/geo directory.
 * Also updates the .md front matter to point to the new geojson file name.
 */
async function syncGeoFiles() {
    console.log("Starting GeoJSON sync process...");

    if (!fs.existsSync(contentDir)) {
        console.error(`Error: Content directory not found at ${contentDir}`);
        return;
    }

    const mdFiles = await getMdFiles(contentDir);
    console.log(`Found ${mdFiles.length} markdown files to review.`);

    for (const mdPath of mdFiles) {
        const content = await fs.promises.readFile(mdPath, 'utf8');
        const mdFileName = path.basename(mdPath, '.md');

        // Regex to find 'geojson: "/geo/name.geo.json"' or 'route: /geo/name.geo.json'
        // Handles optional quotes and spaces
        const geoRegex = /^(geojson|route):\s*["']?\/geo\/([^"'\s]+\.geo\.json)["']?$/m;
        const match = content.match(geoRegex);

        if (match) {
            const key = match[1];
            const oldGeoName = match[2];
            const newGeoName = `${mdFileName}.geo.json`;

            // Skip if already named correctly
            if (oldGeoName === newGeoName) continue;

            const oldGeoPath = path.join(geoDir, oldGeoName);
            const newGeoPath = path.join(geoDir, newGeoName);

            if (fs.existsSync(oldGeoPath)) {
                console.log(`Processing ${mdFileName}.md:`);
                console.log(`  Renaming: ${oldGeoName} -> ${newGeoName}`);

                try {
                    // Rename the actual file in public/geo/
                    await fs.promises.rename(oldGeoPath, newGeoPath);

                    // Update the reference in the .md front matter
                    const updatedContent = content.replace(geoRegex, `${key}: "/geo/${newGeoName}"`);
                    await fs.promises.writeFile(mdPath, updatedContent, 'utf8');
                    console.log(`  Updated front matter in ${path.basename(mdPath)}`);
                } catch (err) {
                    console.error(`  Error processing ${mdFileName}: ${err.message}`);
                }
            } else {
                console.warn(`  Warning: Referenced file ${oldGeoName} not found in ${geoDir}`);
            }
        }
    }
    console.log("\nSync complete.");
}

syncGeoFiles();