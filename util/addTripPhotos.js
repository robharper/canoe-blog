#!/usr/bin/env node
// Scans a trip's image folder (src/assets/images/trips/<slug>/) and adds a
// <Photo> element for any image that doesn't already have one in the trip's
// content file. Reuses an existing `import` for an image if one is present
// but unused. Converts .md files to .mdx when a <Photo> is added, since JSX
// components only render in .mdx.
//
// Usage:
//   node util/addTripPhotos.js [slug|--all] [--dry-run]
//   node util/addTripPhotos.js                # interactive picker
//   node util/addTripPhotos.js 2023-mouse      # single trip
//   node util/addTripPhotos.js --all           # every trip
//   node util/addTripPhotos.js --all --dry-run # preview only, no writes

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
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

/** Figures out which images in the trip's folder still need a <Photo> element. */
function planForTrip(trip) {
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

	const importRegex = /^import\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"]\s*;?\s*$/gm;
	const importsByBasename = new Map();
	const usedNames = new Set();
	let hasPhotoImport = false;
	let match;
	while ((match = importRegex.exec(content))) {
		const [, varName, importPath] = match;
		usedNames.add(varName);
		if (/Photo\.astro$/.test(importPath)) {
			hasPhotoImport = true;
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
		const existingVarName = importsByBasename.get(file);
		if (existingVarName) {
			missing.push({ file, varName: existingVarName, needsImport: false });
		} else {
			missing.push({ file, varName: toVariableName(file, usedNames), needsImport: true });
		}
	}

	return { trip, content, missing, hasPhotoImport };
}

function applyPlan(plan, { dryRun }) {
	const { trip, content, missing, hasPhotoImport } = plan;

	const newImportLines = [];
	if (!hasPhotoImport) {
		newImportLines.push(`import Photo from '../../components/Photo.astro';`);
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
	const photoBlocks = missing.map(
		(item) =>
			`<Photo src={${item.varName}} alt="A photo from the ${escapedTitle} trip">\n  TODO: Add a caption for this photo.\n</Photo>`
	);
	updated = `${updated.replace(/\s+$/, '')}\n\n${photoBlocks.join('\n\n')}\n`;

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
		const plan = planForTrip(trip);
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
		console.log(`${trip.slug}: added ${result.addedCount} <Photo> element(s)${renameNote}`);
		for (const file of result.addedFiles) console.log(`    + ${file}`);
	}

	console.log(`\nDone. ${totalAdded} <Photo> element(s) across ${totalChanged} trip(s) changed.`);
}

main().catch((err) => {
	console.error(`\nError: ${err.message}`);
	process.exitCode = 1;
});
