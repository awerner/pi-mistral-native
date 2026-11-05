import { defineCollection } from 'astro:content';
import { docsSchema, i18nSchema } from '@astrojs/starlight/schema';
import { i18nLoader } from '@astrojs/starlight/loaders';
import { z } from 'astro/zod';
import { docsLoader } from './loader/docs-loader.js';

// The docs collection is fed by the ingestion loader, not a directory inside
// the site: schema fields beyond Starlight's defaults carry the ADR badge
// data the loader extracts in memory.
//
// `type` is the page's Diátaxis type (ADR 0023, D1): required on EVERY page,
// validated as an enum — a missing or invalid value fails the build. ADR
// pages are `concept`; the loader derives it for them.
const docs = defineCollection({
  loader: docsLoader(),
  schema: docsSchema({
    extend: z.object({
      type: z.enum(['tutorial', 'how-to', 'reference', 'concept']),
      adrStatus: z.enum(['trial', 'accepted', 'superseded']).optional(),
      supersededBy: z.string().optional(),
      // HTML-escaped inline form of the title (code spans etc.); the plain
      // title drives sidebar labels, <title> and og:title.
      titleHtml: z.string().optional(),
    }),
  }),
});

// The i18n collection is English-only with an empty built-in-override file so
// the translation system has a collection to read.
const i18n = defineCollection({ loader: i18nLoader(), schema: i18nSchema() });

export const collections = { docs, i18n };
