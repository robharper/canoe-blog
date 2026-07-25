import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const TRIPS_DIR = path.join(REPO_ROOT, 'src', 'content', 'trips');
const IMAGES_DIR = path.join(REPO_ROOT, 'src', 'assets', 'images', 'trips');

function parseFrontmatter(raw) {
	const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!match) return {};
	const block = match[1];
	const titleMatch = block.match(/^title:\s*"?(.*?)"?\s*$/m);
	const dateMatch = block.match(/^date:\s*(\d{4})-(\d{2})-(\d{2})\s*$/m);
	return {
		title: titleMatch ? titleMatch[1] : undefined,
		date: dateMatch
			? new Date(Date.UTC(Number(dateMatch[1]), Number(dateMatch[2]) - 1, Number(dateMatch[3])))
			: undefined,
	};
}

/** Lists all trips found in src/content/trips, newest first. */
export function listTrips() {
	const files = fs.readdirSync(TRIPS_DIR).filter((f) => /\.(md|mdx)$/.test(f));
	const trips = files.map((file) => {
		const slug = file.replace(/\.(md|mdx)$/, '');
		const raw = fs.readFileSync(path.join(TRIPS_DIR, file), 'utf8');
		const { title, date } = parseFrontmatter(raw);
		return { slug, file, title: title ?? slug, date };
	});
	trips.sort((a, b) => {
		if (!a.date && !b.date) return a.slug.localeCompare(b.slug);
		if (!a.date) return 1;
		if (!b.date) return -1;
		return b.date - a.date;
	});
	return trips;
}

/** Absolute path to the image folder for a trip slug (src/assets/images/trips/<slug>). */
export function tripImagesDir(slug) {
	return path.join(IMAGES_DIR, slug);
}
