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
	}),
});

export const collections = {
	'trips': tripsCollection,
};
