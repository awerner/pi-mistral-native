// Sätteri mdast plugin: drops the first level-1 heading from INGESTED DOCS
// bodies at compile time. The docs are the single source of truth and their
// H1 doubles as the page title on GitHub; the site renders the title through
// the PageTitle component (frontmatter `title`/`titleHtml`, derived by the
// loader from that same H1), so the body must not carry a second H1.
//
// The plugin runs only for files inside the ingested docs tree (the loader's
// DOCS_ROOT); site-authored pages (src/pages/*.astro) are untouched.
import { fileURLToPath } from 'node:url';

const DOCS_ROOT = fileURLToPath(new URL('../../../docs', import.meta.url));

export function dropFirstH1Plugin() {
  return {
    name: 'pi-mistral-native-drop-first-h1',
    heading(node, ctx) {
      // Only the FIRST heading of the document, and only level 1: deeper
      // headings are page content.
      if (node.depth !== 1) return;
      // Only ingested docs pages — never site-authored content.
      const file = ctx.fileURL ? fileURLToPath(ctx.fileURL) : undefined;
      if (!file || !file.startsWith(DOCS_ROOT)) return;
      ctx.removeNode(node);
      // Visitors fire per node; removing the first H1 is enough because the
      // docs carry exactly one H1 (the loader's extractTitle relies on it).
    },
  };
}
