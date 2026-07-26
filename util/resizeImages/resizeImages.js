#!/usr/bin/env node
// Recursively scans src/assets/images/trips/ and downsizes any image whose
// largest dimension exceeds MAX_DIMENSION, overwriting it in place. EXIF
// metadata (capture date, GPS, etc.) is preserved; only the pixel dimensions
// (and, as a side effect, file size) change. Images already at or under the
// limit are left untouched.
//
// Usage:
//   node util/resizeImages/resizeImages.js [--dry-run] [dir]
//   node util/resizeImages/resizeImages.js                        # resize everything under src/assets/images/trips/
//   node util/resizeImages/resizeImages.js --dry-run               # preview only, no writes
//   node util/resizeImages/resizeImages.js 2023-mouse               # only that trip's folder
//   node util/resizeImages/resizeImages.js --dry-run 2023-mouse

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const IMAGES_ROOT = path.join(REPO_ROOT, 'src', 'assets', 'images', 'trips');

const MAX_DIMENSION = 2048;
const RESIZABLE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.tiff', '.avif']);

function listImageFiles(dir) {
	const results = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			results.push(...listImageFiles(fullPath));
		} else if (RESIZABLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
			results.push(fullPath);
		}
	}
	return results;
}

/** Re-encodes the resized pixels in whatever format the source file already is. */
function applyOutputFormat(pipeline, ext) {
	switch (ext) {
		case '.jpg':
		case '.jpeg':
			return pipeline.jpeg({ quality: 92 });
		case '.png':
			return pipeline.png();
		case '.webp':
			return pipeline.webp({ quality: 92 });
		case '.tiff':
			return pipeline.tiff();
		case '.avif':
			return pipeline.avif();
		default:
			return pipeline;
	}
}

/**
 * Resizes a single image in place if it's larger than MAX_DIMENSION.
 * Returns null if the file didn't need resizing, otherwise a stats object.
 */
async function resizeImage(filePath, { dryRun }) {
	const originalBuffer = fs.readFileSync(filePath);
	const metadata = await sharp(originalBuffer).metadata();
	const { width, height } = metadata;

	if (!width || !height || Math.max(width, height) <= MAX_DIMENSION) {
		return null;
	}

	const ext = path.extname(filePath).toLowerCase();
	let pipeline = sharp(originalBuffer, { failOn: 'none' }).resize({
		width: MAX_DIMENSION,
		height: MAX_DIMENSION,
		fit: 'inside',
		withoutEnlargement: true,
	});
	pipeline = applyOutputFormat(pipeline.withMetadata(), ext);
	const resizedBuffer = await pipeline.toBuffer();

	if (!dryRun) {
		const tmpPath = `${filePath}.tmp${process.pid}`;
		fs.writeFileSync(tmpPath, resizedBuffer);
		fs.renameSync(tmpPath, filePath);
	}

	const resizedMeta = await sharp(resizedBuffer).metadata();
	return {
		originalWidth: width,
		originalHeight: height,
		newWidth: resizedMeta.width,
		newHeight: resizedMeta.height,
		originalBytes: originalBuffer.length,
		newBytes: resizedBuffer.length,
	};
}

function formatBytes(bytes) {
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

async function main() {
	const rawArgs = process.argv.slice(2);
	const dryRun = rawArgs.includes('--dry-run');
	const subdir = rawArgs.find((a) => a !== '--dry-run');

	const targetDir = subdir ? path.join(IMAGES_ROOT, subdir) : IMAGES_ROOT;
	if (!fs.existsSync(targetDir)) {
		throw new Error(`No such directory: ${path.relative(REPO_ROOT, targetDir)}`);
	}

	const files = listImageFiles(targetDir).sort();
	console.log(`Scanning ${files.length} image(s) under ${path.relative(REPO_ROOT, targetDir)}...`);
	if (dryRun) console.log('(dry run — no files will be changed)\n');

	let resizedCount = 0;
	let totalOriginalBytes = 0;
	let totalNewBytes = 0;

	for (const file of files) {
		const relPath = path.relative(REPO_ROOT, file);
		try {
			const stats = await resizeImage(file, { dryRun });
			if (!stats) continue;

			resizedCount += 1;
			totalOriginalBytes += stats.originalBytes;
			totalNewBytes += stats.newBytes;

			const dims = `${stats.originalWidth}x${stats.originalHeight} -> ${stats.newWidth}x${stats.newHeight}`;
			const size = `${formatBytes(stats.originalBytes)} -> ${formatBytes(stats.newBytes)}`;
			console.log(`  \u2713 ${relPath}  (${dims}, ${size})`);
		} catch (err) {
			console.error(`  \u2717 ${relPath}: ${err.message}`);
		}
	}

	console.log(
		`\n${dryRun ? 'Would resize' : 'Resized'} ${resizedCount}/${files.length} image(s) exceeding ${MAX_DIMENSION}px.`
	);
	if (resizedCount > 0) {
		const savedBytes = totalOriginalBytes - totalNewBytes;
		const savedPct = ((savedBytes / totalOriginalBytes) * 100).toFixed(0);
		console.log(
			`Total size: ${formatBytes(totalOriginalBytes)} -> ${formatBytes(totalNewBytes)} (saved ${formatBytes(savedBytes)}, ${savedPct}%)`
		);
	}
}

main().catch((err) => {
	console.error(`\nError: ${err.message}`);
	process.exitCode = 1;
});
