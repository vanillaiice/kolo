/** Content collections. Blog posts live in `src/content/blog/{en,fr}/<slug>.mdx`; the same slug in both folders marks a translation. */
import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const blog = defineCollection({
  loader: glob({ pattern: '{en,fr}/*.{md,mdx}', base: './src/content/blog' }),
  schema: z.object({
    title: z.string().min(1),
    /** One or two sentences for the post list, search results, social cards and RSS. */
    description: z.string().min(1),
    date: z.coerce.date(),
    updated: z.coerce.date().optional(),
    /** Drafts appear only on the dev server. */
    draft: z.boolean().default(false),
  }),
});

export const collections = { blog };
