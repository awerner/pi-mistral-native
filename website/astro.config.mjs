import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import { satteri } from '@astrojs/markdown-satteri';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { dropFirstH1Plugin } from './src/loader/drop-first-h1-plugin.js';

const docsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../docs');

export default defineConfig({
  // Required for the sitemap integration and canonical URLs; GitHub Pages
  // serves the site under this host and the /pi-mistral-native/ subpath.
  site: 'https://awerner.github.io',
  base: '/pi-mistral-native/',
  vite: {
    resolve: {
      alias: [
        {
          // The ingested docs live outside the site project (../../docs), so
          // their bare imports cannot resolve through the site's node_modules
          // by directory walk — map the Starlight component entry point to
          // the site-local package explicitly (absolute path, so Vite treats
          // it as the one canonical module). The regex matches ONLY the bare
          // specifier: subpath imports such as
          // `@astrojs/starlight/components/StarlightPage.astro` keep their
          // normal package-exports resolution.
          find: /^@astrojs\/starlight\/components$/,
          replacement: fileURLToPath(
            new URL('./node_modules/@astrojs/starlight/dist/components.ts', import.meta.url)
          ),
        },
        {
          // Site-local components for ingested MDX (base-aware LinkCard etc.):
          // a stable specifier the docs can import without knowing the site's
          // internal layout.
          find: /^@site\/components$/,
          replacement: fileURLToPath(new URL('./src/components/index.ts', import.meta.url)),
        },
      ],
    },
  },
  markdown: {
    // Sätteri with container directives enabled: Starlight's aside plugin
    // (`:::caution[Title]` blocks) runs on top of this processor. The
    // drop-first-H1 plugin removes the ingested docs' own H1 at compile
    // time — the PageTitle component renders the page title (the loader
    // derives it from that same H1), so the body must not carry a second
    // one. It runs on both the Markdown and the MDX pipeline.
    processor: satteri({
      features: { directive: true },
      mdastPlugins: [dropFirstH1Plugin()],
    }),
  },
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
        // Renders the page H1 from the loader-provided titleHtml so inline
        // markdown (code spans) in ingested doc titles keeps its formatting.
        PageTitle: './src/components/PageTitle.astro',
      },
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/awerner/pi-mistral-native' },
      ],
      // The ingested docs live outside the site project (../../docs), so
      // Starlight's Markdown transforms (asides, heading links) must run on
      // them too — the default only covers src/content/docs.
      markdown: {
        processedDirs: ['../docs'],
      },
      sidebar: sidebarConfig(),
    }),
  ],
});

// Named export for the config test: Astro reads only the default export
// from a config module, so this extra surface is inert for the build and
// lets tests assert on the exact sidebar shape the integration receives.
export { sidebarConfig };

// The sidebar mirrors the Diátaxis structure (ADR 0023, D1/D2): five
// top-level groups, one page type per group. ADR entries are derived from
// the docs directory at config load so their numbers, order and suffixes
// follow the source of truth without being re-listed here by hand.
function sidebarConfig() {
  return [
    {
      label: 'Get started',
      items: [entry('get-started', 'Welcome'), entry('get-started/first-session')],
    },
    {
      label: 'How-to guides',
      items: [
        entry('how-to/set-up-api-key'),
        entry('how-to/change-a-setting'),
        entry('how-to/use-a-region'),
        entry('how-to/override-for-one-project'),
        entry('how-to/keep-secrets-out-of-the-config-file'),
        entry('how-to/route-through-a-gateway'),
        entry('how-to/use-a-mistral-agent'),
        entry('how-to/set-your-own-prices'),
        entry('how-to/enable-connectors'),
        entry('how-to/query-your-documents'),
        entry('how-to/search-the-web'),
        entry('how-to/run-code-with-the-code-interpreter'),
        entry('how-to/fix-a-configuration-error'),
      ],
    },
    {
      label: 'Reference',
      items: [
        entry('configuration', 'Configuration keys'),
        entry('reference/config-files'),
        entry('reference/environment-variables'),
        entry('reference/commands'),
        entry('reference/tools'),
        entry('reference/region-routing'),
        entry('reference/credential-chain'),
        entry('reference/rate-card'),
        entry('reference/max-output-mapping'),
        entry('reference/config-error-messages'),
      ],
    },
    {
      label: 'Concepts',
      items: [
        entry('concepts/config-layers'),
        entry('concepts/regions'),
        entry('concepts/tools'),
        entry('concepts/models-and-costs'),
        entry('concepts/chat-streaming'),
      ],
    },
    {
      label: 'Contributing',
      items: [
        entry('contributing/development'),
        entry('contributing/testing'),
        entry('contributing/publishing'),
        entry('contributing/hosting'),
        entry('contributing/design-tokens'),
        entry('contributing/internals'),
        {
          label: 'Architecture ADRs',
          items: [entry('dev/adr', 'Index'), ...adrEntries(docsRoot, 'dev/adr')],
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
