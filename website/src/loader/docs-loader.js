// Starlight docs-collection loader that ingests the repository documentation
// from ../../../docs (single source of truth). The ingested files are never
// modified on disk: frontmatter injection, title processing, first-H1 drop
// (the frontmatter title already renders as the page H1) and .md link
// rewriting all happen in memory here.
//
// Route mapping:
//   docs/get-started/index.mdx          -> slug `get-started`          -> /get-started/
//   docs/how-to/use-a-region.mdx       -> slug `how-to/use-a-region`  -> /how-to/use-a-region/
//   docs/configuration.mdx             -> slug `configuration`         -> /configuration/
//   docs/dev/development.mdx           -> slug `dev/development`      -> /dev/development/
//   docs/dev/adr/0002-x.mdx           -> slug `dev/adr/0002-x`       -> /dev/adr/0002-x/
//   docs/dev/adr/README.mdx            -> slug `dev/adr`              -> /dev/adr/
//
// README.md at the repository root is NOT ingested (the site landing page is
// site-authored and derives from it instead).
//
// The pages are MDX (Starlight components — Steps, Tabs, Aside, Badge,
// FileTree, LinkCard — are Astro components, not Markdown), so the loader
// does NOT pre-render bodies. It stores `deferredRender: true` and the real
// on-disk file path; Astro's deferred-render pipeline imports each file
// through Vite, where @astrojs/mdx compiles it and Starlight's components
// resolve. Frontmatter (title, description, type, ADR badge data) is built
// in memory here and validated against the content schema via parseData.
//
// The loader passes config.base through to the link rewriter so rewritten
// routes carry the deployment base (GitHub Pages serves the site under
// /pi-mistral-native/; Astro rewrites its own URLs but not raw markdown).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildFrontmatter,
  docsPathToSlug,
  docsPathToFilePath,
} from './helpers.js';

const DOCS_ROOT = fileURLToPath(new URL('../../../docs', import.meta.url));

async function* walkMarkdown(dir) {
  const dirents = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of dirents) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkMarkdown(entryPath);
    } else if (entry.isFile() && (entry.name.endsWith('.mdx') || entry.name.endsWith('.md'))) {
      // The ADR template is a writing aid, not a published page.
      if (entry.name === 'template.md') continue;
      yield entryPath;
    }
  }
}

export function docsLoader() {
  return {
    name: 'pi-mistral-native-docs-loader',
    async load({ config, store, logger, parseData, generateDigest }) {
      // Full re-scan on every load: clear the store so docs removed from the
      // repository never survive as stale site pages.
      store.clear();
      const entries = [];
      for await (const filePath of walkMarkdown(DOCS_ROOT)) {
        entries.push(filePath);
      }
      entries.sort();

      for (const filePath of entries) {
        const posixPath = filePath.split(path.sep).join('/');
        const docsPath = posixPath.slice(posixPath.indexOf('/docs/') + 1);
        const raw = await fs.readFile(filePath, 'utf8');
        // The body transformations (first-H1 drop, .md link rewriting) moved
        // INTO the compile pipeline (src/loader/docs-plugins.js): with the
        // deferred render, Vite compiles the on-disk file, so the loader's
        // in-memory body never reaches the rendered output. Frontmatter is
        // still built in memory here; the digest stays raw-based so title
        // generation and invalidation are unchanged.
        const frontmatter = buildFrontmatter(docsPath, raw);
        const slug = docsPathToSlug(docsPath);

        // parseData validates against the Starlight docs schema declared in
        // src/content.config.ts — including the required Diátaxis `type` enum,
        // so a page without a valid type fails the build here loudly.
        const data = await parseData({ id: slug, data: frontmatter, filePath });
        store.set({
          id: slug,
          data,
          // The real on-disk file path (relative to the site root): the MDX
          // compiler resolves imports (Starlight components) against it, and
          // Git-based tooling (last-updated, edit links) reads it.
          filePath: docsPathToFilePath(docsPath),
          // Deferred render: the body is compiled by Vite at render time, not
          // pre-rendered here. The digest covers the raw body, the slug and
          // the base (all three feed the rendered output).
          deferredRender: true,
          digest: generateDigest(raw + slug + config.base),
        });
      }
      logger.info(`Ingested ${entries.length} docs pages from ${DOCS_ROOT}`);
    },
  };
}
