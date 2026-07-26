#!/usr/bin/env node
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import open from 'open';

import { getAuthorizedClient } from './lib/auth.js';
import { listTrips, tripImagesDir } from './lib/trips.js';
import {
	createSession,
	waitForSelection,
	listMediaItems,
	downloadMediaFile,
	deleteSession,
} from './lib/picker.js';
import { saveAsJpeg } from './lib/image.js';

const DAYS_WINDOW = 15;

function formatDate(date) {
	return date.toLocaleDateString('en-US', {
		year: 'numeric',
		month: 'long',
		day: 'numeric',
		timeZone: 'UTC',
	});
}

function addDays(date, days) {
	const result = new Date(date);
	result.setUTCDate(result.getUTCDate() + days);
	return result;
}

async function pickTrip(rl, trips) {
	console.log('\nTrips:\n');
	for (const [i, trip] of trips.entries()) {
		const dateLabel = trip.date ? formatDate(trip.date) : 'no date';
		console.log(`  ${String(i + 1).padStart(2, ' ')}. ${trip.slug} — ${trip.title} (${dateLabel})`);
	}
	const answer = (await rl.question('\nSelect a trip (number or slug): ')).trim();
	const trip = trips[Number(answer) - 1] ?? trips.find((t) => t.slug === answer);
	if (!trip) throw new Error(`Could not find a trip matching "${answer}"`);
	return trip;
}

async function main() {
	const rl = readline.createInterface({ input, output });
	let client;
	let sessionId;
	try {
		const trips = listTrips();
		const cliArg = process.argv[2];
		const trip = cliArg ? trips.find((t) => t.slug === cliArg) : await pickTrip(rl, trips);
		if (!trip) throw new Error(`No trip found with slug "${cliArg}"`);
		if (!trip.date) throw new Error(`Trip "${trip.slug}" has no parseable "date" in its front matter.`);

		const rangeStart = addDays(trip.date, -DAYS_WINDOW);
		const rangeEnd = addDays(trip.date, DAYS_WINDOW);

		console.log(`\nTrip: ${trip.title} (${trip.slug})`);
		console.log(`Trip date: ${formatDate(trip.date)}`);
		console.log(`+/- ${DAYS_WINDOW} days: ${formatDate(rangeStart)} to ${formatDate(rangeEnd)}\n`);

		console.log('Authorizing with Google Photos...');
		client = await getAuthorizedClient();

		console.log('Creating a Google Photos picker session...');
		const session = await createSession(client);
		sessionId = session.id;

		console.log('\n--------------------------------------------------------------------');
		console.log('Opening Google Photos. Select the photos for this trip, then tap Done.');
		console.log(`Search "${formatDate(rangeStart)} to ${formatDate(rangeEnd)}" to jump to this date range —`);
		console.log('Google Photos does not let apps pre-filter by date on your behalf.');
		console.log(session.pickerUri);
		console.log('--------------------------------------------------------------------\n');
		await open(session.pickerUri).catch(() => {});

		console.log('Waiting for you to finish selecting photos in the browser...');
		const finishedSession = await waitForSelection(client, session, {
			onPoll: () => process.stdout.write('.'),
		});
		console.log('\nSelection complete. Fetching selected items...');

		const mediaItems = await listMediaItems(client, finishedSession.id);
		const photos = mediaItems.filter((item) => item.type === 'PHOTO');
		const videoCount = mediaItems.length - photos.length;
		if (videoCount > 0) {
			console.log(`Skipping ${videoCount} video(s) — this tool only imports photos.`);
		}
		if (photos.length === 0) {
			console.log('No photos were selected.');
			return;
		}

		const destDir = tripImagesDir(trip.slug);
		console.log(`\nDownloading ${photos.length} photo(s) into ${path.relative(process.cwd(), destDir)}...\n`);

		let saved = 0;
		let replaced = 0;
		for (const item of photos) {
			const { mediaFile } = item;
			try {
				const buffer = await downloadMediaFile(client, mediaFile);
				const result = await saveAsJpeg(buffer, destDir, mediaFile.filename ?? `${item.id}.jpg`);
				console.log(`  ${result.replaced ? '\u21bb replaced' : '\u2713 added'} ${path.basename(result.destPath)}`);
				saved += 1;
				if (result.replaced) replaced += 1;
			} catch (err) {
				console.error(`  \u2717 ${mediaFile.filename}: ${err.message}`);
			}
		}

		console.log(`\nSaved ${saved}/${photos.length} photo(s) to ${destDir}${replaced > 0 ? ` (${replaced} replaced)` : ''}`);
		console.log(`Reference them from src/content/trips/${trip.slug}.md(x), e.g.:`);
		console.log(`  ../../assets/images/trips/${trip.slug}/<filename>.jpg\n`);
	} finally {
		rl.close();
		if (sessionId && client) {
			await deleteSession(client, sessionId).catch(() => {});
		}
	}
}

main().catch((err) => {
	console.error(`\nError: ${err.message}`);
	process.exitCode = 1;
});
