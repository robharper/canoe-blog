import { defineCollection, z } from 'astro:content';

const tripsCollection = defineCollection({
	type: 'content',
	schema: ({ image }) => z.object({
		title: z.string(),
		date: z.date(),
		location: z.string(),
		excerpt: z.string(),
		coverImage: image(),
		mapImage: image().optional(),
		geojson: z.string().optional(),
		mapCenter: z.array(z.number()).length(2).optional(),
	}),
});

export const collections = {
	'trips': tripsCollection,
};
