import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const docsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../docs');

export default defineConfig({
  // Required for the sitemap integration and canonical URLs; GitHub Pages
  // serves the site under this host and the /pi-mistral-native/ subpath.
  site: 'https://awerner.github.io',
  base: '/pi-mistral-native/',
  integrations: [
    starlight({
      title: 'pi-mistral-native',
      description:
        'Mistral-specific, optimized integration for the pi coding agent — not just chat.',
      logo: {
        src: './src/assets/logo.svg',
      },
      favicon: '/favicon.svg',
      customCss: ['./src/styles/custom.css'],
      components: {
        // Renders the ADR lifecycle badge (Trial/Accepted/Superseded) above
        // the page body; a plain ContentPanel is kept for non-ADR pages.
        ContentPanel: './src/components/AdrStatusContentPanel.astro',
      },
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/awerner/pi-mistral-native' },
      ],
      sidebar: sidebarConfig(),
    }),
  ],
});

// The sidebar mirrors the repository's four documentation layers. ADR
// entries are derived from the docs directory at config load so page
// numbers, order and suffixes follow the source of truth without being
// re-listed here by hand.
function sidebarConfig() {
  return [
    { label: 'Getting started', items: [{ label: 'Welcome', link: '/' }] },
    {
      label: 'Features',
      items: [
        'stream',
        'catalog',
        'auth',
        'knowledge-tools',
        'server-tools',
        'configuration',
      ].map((slug) => entry(slug)),
    },
    { label: 'Design', items: [entry('design-tokens')] },
    {
      label: 'Developer',
      items: [entry('development'), entry('testing'), entry('publishing'), entry('hosting')],
    },
    {
      label: 'Decisions',
      items: [
        {
          label: 'Architecture ADRs',
          items: [entry('adr', 'Index'), ...adrEntries(docsRoot, 'adr')],
        },
      ],
    },
  ];
}

// The ADR sidebar derives from the docs directory: every numbered ADR file
// becomes an entry in numeric order, and a series with no ADRs fails the
// build (the index route would point at an empty section).
function adrEntries(docsRoot, dir) {
  const absolute = path.join(docsRoot, dir);
  const files = readdirSync(absolute)
    .filter((f) => /^\d{4}-.*\.md$/.test(f))
    .sort();
  if (files.length === 0) {
    throw new Error(`No ADR files found in ${absolute}`);
  }
  return files.map((f) => entry(`${dir}/${f.replace(/\.md$/, '')}`));
}

// Sidebar entries reference collection entries by slug (the loader's
// docs-path mapping), so a renamed docs file fails the build here loudly.
function entry(slug, label) {
  return { slug, ...(label ? { label } : {}) };
}
