import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { glob } from 'astro/loaders';

const tripsCollection = defineCollection({
	loader: glob({ pattern: '**/*.{md,mdx}', base: "./src/content/trips" }),
	schema: ({ image }) => z.object({
		title: z.string(),
		date: z.date(),
		location: z.string(),
		excerpt: z.string(),
		coverImage: image(),
		mapImage: image().optional(),
		geojson: z.string().optional(),
		mapCenter: z.array(z.number()).length(2).optional(),
		portageCount: z.number().optional(),
		outAndBack: z.boolean().optional().default(false),
		// When true, TripLayout skips its automatic full-trip daily breakdown
		// so the trip's markdown/MDX body can render each day's stats inline
		// (via <TripDailyDetails day={n} days={dailyStats} />) alongside that
		// day's narrative instead.
		inlineDailyDetails: z.boolean().optional().default(false),
		waypointNames: z.object({
			start: z.string().optional(),
			end: z.string().optional(),
			campsites: z.record(z.coerce.number(), z.string()).optional(),
		}).optional(),
	}),
});

export const collections = {
	'trips': tripsCollection,
};
