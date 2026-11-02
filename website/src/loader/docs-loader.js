// Starlight docs-collection loader that ingests the repository documentation
// from ../../../docs (single source of truth). The ingested files are never
// modified on disk: frontmatter injection, ADR status parsing and .md link
// rewriting all happen in memory here.
//
// Route mapping:
//   docs/stream.md           -> slug `stream`             -> /stream/
//   docs/adr/0002-x.md       -> slug `adr/0002-x`         -> /adr/0002-x/
//   docs/adr/README.md       -> slug `adr`                -> /adr/
//   docs/adr/process/0007-x  -> slug `adr/process/0007-x` -> /adr/process/0007-x/
//
// README.md at the repository root is NOT ingested (the site landing page is
// site-authored and derives from it instead).
//
// The loader passes config.base through to the link rewriter so rewritten
// routes carry the deployment base (GitHub Pages serves the site under
// /pi-mistral-native/; Astro rewrites its own URLs but not raw markdown).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  buildFrontmatter,
  docsPathToSlug,
  rewriteLinks,
} from './helpers.js';

const DOCS_ROOT = fileURLToPath(new URL('../../../docs', import.meta.url));

async function* walkMarkdown(dir) {
  const dirents = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of dirents) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkMarkdown(entryPath);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      yield entryPath;
    }
  }
}

export function docsLoader() {
  return {
    name: 'pi-mistral-native-docs-loader',
    async load({ config, store, logger, renderMarkdown, parseData, generateDigest }) {
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
        const body = rewriteLinks(raw, docsPath, config.base);
        const frontmatter = buildFrontmatter(docsPath, raw);
        const slug = docsPathToSlug(docsPath);

        // parseData validates against the Starlight docs schema declared in
        // src/content.config.ts (which extends it with the ADR badge fields).
        const data = await parseData({ id: slug, data: frontmatter, filePath });
        const rendered = await renderMarkdown(body, {
          fileURL: docsStandinUrl(filePath, config),
        });
        store.set({
          id: slug,
          data,
          filePath: path.relative(fileURLToPath(config.root), filePath),
          // The digest covers the file body, the slug and the base: the
          // slug and the base both feed link rewriting, so a mapping or
          // base change must invalidate the entry even when the file
          // content itself is unchanged.
          digest: generateDigest(raw + slug + config.base),
          rendered,
        });
      }
      logger.info(`Ingested ${entries.length} docs pages from ${DOCS_ROOT}`);
    },
  };
}

// Astro's markdown renderer resolves relative image paths against the
// file URL and treats out-of-root files as unknown. The ingested docs live
// outside the site project, so a URL under <siteRoot>/docs/ (a virtual
// location that never exists on disk) stands in; every relative path the
// renderer would resolve is one the loader or the asset sync handles.
// Must be a URL object (not a string): Expressive Code reads
// file.url.protocol to decide how to resolve the code-block locale.
function docsStandinUrl(filePath, config) {
  const relFromDocs = path.relative(DOCS_ROOT, filePath).split(path.sep).join('/');
  const rootUrl = pathToFileURL(fileURLToPath(config.root)).href;
  return new URL(`./docs/${relFromDocs}`, rootUrl);
}
