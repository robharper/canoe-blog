#!/usr/bin/env node
// Scans a trip's image folder (src/assets/images/trips/<slug>/) and adds a
// <Photo> element for any image that doesn't already have one in the trip's
// content file. Reuses an existing `import` for an image if one is present
// but unused. Converts .md files to .mdx when a <Photo> is added, since JSX
// components only render in .mdx.
//
// New photos are grouped by capture date, read from each image's EXIF
// DateTimeOriginal/CreateDate tag. Each unique date (in chronological order)
// becomes "Day N" — a heading plus a <TripDailyDetails day={N}> — matching
// the `inlineDailyDetails` convention used elsewhere in the site (see
// src/content/trips/2026-smoke-porc-louisa-head.mdx). Day numbers are based
// on *all* dated photos in the folder, not just the ones being added, so
// they stay stable across repeated runs as more photos are added over time.
// Photos with no readable EXIF date (common for re-exported/shared images —
// file modification times aren't used since they aren't preserved by git)
// are appended separately, ungrouped, with a warning.
//
// Usage:
//   node util/addTripPhotos/addTripPhotos.js [slug|--all] [--dry-run]
//   node util/addTripPhotos/addTripPhotos.js                # interactive picker
//   node util/addTripPhotos/addTripPhotos.js 2023-mouse      # single trip
//   node util/addTripPhotos/addTripPhotos.js --all           # every trip
//   node util/addTripPhotos/addTripPhotos.js --all --dry-run # preview only, no writes

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath } from 'node:url';
import exifr from 'exifr';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TRIPS_DIR = path.join(REPO_ROOT, 'src', 'content', 'trips');
const IMAGES_ROOT = path.join(REPO_ROOT, 'src', 'assets', 'images', 'trips');
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.tiff']);

function listTrips() {
	return fs
		.readdirSync(TRIPS_DIR)
		.filter((f) => /\.(md|mdx)$/.test(f))
		.map((file) => {
			const slug = file.replace(/\.(md|mdx)$/, '');
			const filePath = path.join(TRIPS_DIR, file);
			const raw = fs.readFileSync(filePath, 'utf8');
			const titleMatch = raw.match(/^title:\s*"?(.*?)"?\s*$/m);
			return { slug, file, path: filePath, title: titleMatch ? titleMatch[1] : slug };
		})
		.sort((a, b) => a.slug.localeCompare(b.slug));
}

function getFrontmatter(content) {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	return match ? { block: match[1], raw: match[0] } : null;
}

function setFrontmatterFlag(content, key, value) {
	const frontmatter = getFrontmatter(content);
	if (!frontmatter) return content;
	const lineRegex = new RegExp(`^${key}:\\s*.*$`, 'm');
	const newLine = `${key}: ${value}`;
	const block = lineRegex.test(frontmatter.block)
		? frontmatter.block.replace(lineRegex, newLine)
		: `${frontmatter.block}\n${newLine}`;
	return `---\n${block}\n---\n${content.slice(frontmatter.raw.length)}`;
}

/** Derives a readable camelCase import identifier from a filename, avoiding collisions. */
function toVariableName(filename, usedNames) {
	const base = path.parse(filename).name;
	const words = base.replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
	let candidate = words
		.map((word, i) => (i === 0 ? word.toLowerCase() : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()))
		.join('');

	if (!candidate || candidate.length > 40) candidate = 'photo';
	if (/^[0-9]/.test(candidate)) candidate = `img${candidate.charAt(0).toUpperCase()}${candidate.slice(1)}`;

	let name = candidate;
	let n = 2;
	while (usedNames.has(name)) {
		name = `${candidate}${n}`;
		n += 1;
	}
	usedNames.add(name);
	return name;
}

/** Reads a photo's capture date from EXIF (DateTimeOriginal, falling back to CreateDate). Returns null if unavailable. */
async function readCaptureDate(filePath) {
	try {
		const tags = await exifr.parse(filePath, { pick: ['DateTimeOriginal', 'CreateDate'] });
		const date = tags?.DateTimeOriginal ?? tags?.CreateDate;
		return date instanceof Date && !Number.isNaN(date.getTime()) ? date : null;
	} catch {
		return null;
	}
}

function dateKey(date) {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function formatDate(date) {
	return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

/** Figures out which images in the trip's folder still need a <Photo> element, and their day numbers. */
async function planForTrip(trip) {
	const content = fs.readFileSync(trip.path, 'utf8');
	const frontmatter = getFrontmatter(content);
	const coverMatch = frontmatter?.block.match(/^coverImage:\s*["']?([^"'\n]+)["']?\s*$/m);
	const coverBasename = coverMatch ? path.basename(coverMatch[1]) : null;

	const imagesDir = path.join(IMAGES_ROOT, trip.slug);
	if (!fs.existsSync(imagesDir)) {
		return { trip, error: `no image directory at ${path.relative(REPO_ROOT, imagesDir)}` };
	}

	const imageFiles = fs
		.readdirSync(imagesDir)
		.filter((f) => IMAGE_EXTENSIONS.has(path.extname(f).toLowerCase()))
		.sort();

	// Day numbers are derived from every dated photo in the folder (not just
	// the ones missing a <Photo>) so they stay stable as photos are added
	// across multiple runs.
	const dateByFile = new Map();
	for (const file of imageFiles) {
		dateByFile.set(file, await readCaptureDate(path.join(imagesDir, file)));
	}
	const uniqueDateKeys = [...new Set([...dateByFile.values()].filter(Boolean).map(dateKey))].sort();
	const dayNumberByDateKey = new Map(uniqueDateKeys.map((key, i) => [key, i + 1]));

	const importRegex = /^import\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"]\s*;?\s*$/gm;
	const importsByBasename = new Map();
	const usedNames = new Set();
	let hasPhotoImport = false;
	let hasTripDailyDetailsImport = false;
	let match;
	while ((match = importRegex.exec(content))) {
		const [, varName, importPath] = match;
		usedNames.add(varName);
		if (/Photo\.astro$/.test(importPath)) {
			hasPhotoImport = true;
			continue;
		}
		if (/TripDailyDetails\.astro$/.test(importPath)) {
			hasTripDailyDetailsImport = true;
			continue;
		}
		const base = path.basename(importPath);
		if (!importsByBasename.has(base)) importsByBasename.set(base, varName);
	}

	const photoUsageRegex = /<Photo\b[^>]*\bsrc=\{\s*([A-Za-z_$][\w$]*)\s*\}/g;
	const varNamesUsedInPhoto = new Set();
	while ((match = photoUsageRegex.exec(content))) {
		varNamesUsedInPhoto.add(match[1]);
	}

	const basenameByVarName = new Map();
	for (const [base, varName] of importsByBasename) basenameByVarName.set(varName, base);

	const coveredBasenames = new Set();
	for (const varName of varNamesUsedInPhoto) {
		const base = basenameByVarName.get(varName);
		if (base) coveredBasenames.add(base);
	}

	const missing = [];
	for (const file of imageFiles) {
		if (file === coverBasename) continue;
		if (coveredBasenames.has(file)) continue;
		const date = dateByFile.get(file);
		const day = date ? dayNumberByDateKey.get(dateKey(date)) : null;
		const existingVarName = importsByBasename.get(file);
		if (existingVarName) {
			missing.push({ file, varName: existingVarName, needsImport: false, date, day });
		} else {
			missing.push({ file, varName: toVariableName(file, usedNames), needsImport: true, date, day });
		}
	}

	return { trip, content, missing, hasPhotoImport, hasTripDailyDetailsImport };
}

function buildPhotoBlock(item, escapedTitle) {
	return `<Photo src={${item.varName}} alt="A photo from the ${escapedTitle} trip">\n  TODO: Add a caption for this photo.\n</Photo>`;
}

function applyPlan(plan, { dryRun }) {
	const { trip, content, missing, hasPhotoImport, hasTripDailyDetailsImport } = plan;

	const dated = missing.filter((item) => item.day != null);
	const undated = missing.filter((item) => item.day == null);

	const dayGroups = new Map();
	for (const item of dated) {
		if (!dayGroups.has(item.day)) dayGroups.set(item.day, []);
		dayGroups.get(item.day).push(item);
	}
	const sortedDays = [...dayGroups.keys()].sort((a, b) => a - b);
	for (const day of sortedDays) {
		dayGroups.get(day).sort((a, b) => a.date - b.date || a.file.localeCompare(b.file));
	}

	const newImportLines = [];
	if (!hasPhotoImport) {
		newImportLines.push(`import Photo from '../../components/Photo.astro';`);
	}
	if (sortedDays.length > 0 && !hasTripDailyDetailsImport) {
		newImportLines.push(`import TripDailyDetails from '../../components/TripDailyDetails.astro';`);
	}
	for (const item of missing) {
		if (item.needsImport) {
			newImportLines.push(`import ${item.varName} from '/src/assets/images/trips/${trip.slug}/${item.file}';`);
		}
	}

	let updated = content;
	if (newImportLines.length > 0) {
		const importLineRegex = /^import .+$/gm;
		let lastImportEnd = null;
		let m;
		while ((m = importLineRegex.exec(updated))) {
			lastImportEnd = m.index + m[0].length;
		}
		if (lastImportEnd !== null) {
			updated = `${updated.slice(0, lastImportEnd)}\n${newImportLines.join('\n')}${updated.slice(lastImportEnd)}`;
		} else {
			const frontmatter = getFrontmatter(updated);
			const insertAt = frontmatter ? frontmatter.raw.length : 0;
			const prefix = updated.slice(0, insertAt);
			const rest = updated.slice(insertAt).replace(/^\n+/, '');
			updated = `${prefix}\n${newImportLines.join('\n')}\n\n${rest}`;
		}
	}

	const escapedTitle = trip.title.replace(/"/g, "'");
	const sections = [];

	for (const day of sortedDays) {
		const items = dayGroups.get(day);
		const label = formatDate(items[0].date);
		const photoBlocks = items.map((item) => buildPhotoBlock(item, escapedTitle)).join('\n\n');
		sections.push(
			`## Day ${day}: ${label}\n\n<TripDailyDetails day={${day}} days={props.dailyStats} showHeader={false} />\n\n${photoBlocks}`
		);
	}

	if (undated.length > 0) {
		const photoBlocks = undated.map((item) => buildPhotoBlock(item, escapedTitle)).join('\n\n');
		// Only add a separating heading when there's day-grouped content above to set it apart from.
		sections.push(sortedDays.length > 0 ? `## Additional Photos\n\n${photoBlocks}` : photoBlocks);
	}

	updated = `${updated.replace(/\s+$/, '')}\n\n${sections.join('\n\n')}\n`;

	if (sortedDays.length > 0) {
		updated = setFrontmatterFlag(updated, 'inlineDailyDetails', 'true');
	}

	const renamed = path.extname(trip.path) === '.md';
	const finalPath = renamed ? trip.path.replace(/\.md$/, '.mdx') : trip.path;

	if (!dryRun) {
		fs.writeFileSync(finalPath, updated);
		if (renamed) fs.unlinkSync(trip.path);
	}

	return {
		changed: true,
		renamed,
		finalPath,
		addedCount: missing.length,
		addedFiles: missing.map((item) => item.file),
		dayCount: sortedDays.length,
		undatedFiles: undated.map((item) => item.file),
	};
}

async function resolveSelection(trips, arg) {
	if (arg === '--all') return trips;
	if (arg) {
		const trip = trips.find((t) => t.slug === arg);
		if (!trip) throw new Error(`No trip found with slug "${arg}"`);
		return [trip];
	}

	const rl = readline.createInterface({ input, output });
	try {
		console.log('\nTrips:\n');
		trips.forEach((t, i) => console.log(`  ${String(i + 1).padStart(2, ' ')}. ${t.slug} — ${t.title}`));
		console.log(`  ${String(trips.length + 1).padStart(2, ' ')}. All trips`);
		const answer = (await rl.question('\nSelect a trip (number or slug), or "all": ')).trim();
		if (answer.toLowerCase() === 'all' || Number(answer) === trips.length + 1) return trips;
		const trip = trips[Number(answer) - 1] ?? trips.find((t) => t.slug === answer);
		if (!trip) throw new Error(`Could not find a trip matching "${answer}"`);
		return [trip];
	} finally {
		rl.close();
	}
}

async function main() {
	const rawArgs = process.argv.slice(2);
	const dryRun = rawArgs.includes('--dry-run');
	const arg = rawArgs.find((a) => a !== '--dry-run');

	const trips = listTrips();
	const selected = await resolveSelection(trips, arg);

	if (dryRun) console.log('\n(dry run — no files will be changed)');

	let totalAdded = 0;
	let totalChanged = 0;
	for (const trip of selected) {
		const plan = await planForTrip(trip);
		if (plan.error) {
			console.log(`${trip.slug}: skipped (${plan.error})`);
			continue;
		}
		if (plan.missing.length === 0) {
			console.log(`${trip.slug}: up to date`);
			continue;
		}

		const result = applyPlan(plan, { dryRun });
		totalAdded += result.addedCount;
		totalChanged += 1;
		const renameNote = result.renamed ? ` (renamed ${trip.file} -> ${path.basename(result.finalPath)})` : '';
		console.log(`${trip.slug}: added ${result.addedCount} <Photo> element(s) across ${result.dayCount} day(s)${renameNote}`);
		for (const item of plan.missing) {
			const dayNote = item.day != null ? `day ${item.day}` : 'no EXIF date';
			console.log(`    + ${item.file} (${dayNote})`);
		}
		if (result.undatedFiles.length > 0) {
			console.log(
				`    ! ${result.undatedFiles.length} photo(s) had no readable capture date and were added ungrouped — consider placing them manually.`
			);
		}
	}

	console.log(`\nDone. ${totalAdded} <Photo> element(s) across ${totalChanged} trip(s) changed.`);
}

main().catch((err) => {
	console.error(`\nError: ${err.message}`);
	process.exitCode = 1;
});
