// Sätteri mdast plugins for the INGESTED DOCS pages (docs/**, outside the
// site project). Both plugins guard on the docs tree: site-authored pages
// (src/pages/*.astro) and Starlight's own content are never touched.
//
// The docs are compiled by Vite at render time (Astro's deferred-render
// pipeline — see src/loader/docs-loader.js), so body transformations must
// happen inside the Markdown/MDX compile, not in the loader: the loader
// only injects frontmatter and slugs.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { docsPathToSlug } from './helpers.js';

const DOCS_ROOT = fileURLToPath(new URL('../../../docs', import.meta.url));

/**
 * POSIX docs-relative path ('docs/how-to/x.mdx') for a compiled file, or
 * undefined for files outside the docs tree (site pages, Starlight content).
 * `docsRoot` is injectable so tests can point the guard at a fixture tree.
 */
export function makeDocsPathResolver(docsRoot = DOCS_ROOT) {
  const root = docsRoot.endsWith('/') ? docsRoot : `${docsRoot}/`;
  return (fileURL) => {
    if (!fileURL) return undefined;
    const file = fileURLToPath(fileURL);
    if (!file.startsWith(root)) return undefined;
    return `docs/${path.relative(root, file).split(path.sep).join('/')}`;
  };
}

const docsPathOf = makeDocsPathResolver();

/** Normalize `a/./b`, `a/x/../b` and duplicate-slash segments. */
function normalize(p) {
  const out = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

/**
 * Drops the first level-1 heading from ingested docs bodies at compile time.
 * The docs are the single source of truth and their H1 doubles as the page
 * title on GitHub; the site renders the title through the PageTitle component
 * (frontmatter `title`/`titleHtml`, derived by the loader from that same
 * H1), so the body must not carry a second H1.
 */
export function dropFirstH1Plugin({ docsRoot } = {}) {
  const resolveDocsPath = docsRoot ? makeDocsPathResolver(docsRoot) : docsPathOf;
  let dropped = false;
  return {
    name: 'pi-mistral-native-drop-first-h1',
    before() {
      dropped = false;
    },
    heading(node, ctx) {
      if (dropped || node.depth !== 1) return;
      if (!resolveDocsPath(ctx.fileURL)) return;
      dropped = true;
      ctx.removeNode(node);
    },
  };
}

/**
 * Rewrites relative `.md`/`.mdx` links in ingested docs bodies to their site
 * routes at compile time (mirroring the loader's slug mapping):
 *   - links resolving inside the docs tree become `/<slug>/` routes,
 *     anchors preserved, prefixed with the deployment base (GitHub Pages
 *     serves the site under a subpath; Astro rewrites its own URLs but not
 *     hand-written markdown links);
 *   - the repository README maps to the landing page;
 *   - non-.md targets resolving ABOVE the docs tree lose their link markup
 *     (the visible label stays as plain text — a dead link is worse than no
 *     link), except repo-root `assets/`, which is synced onto the site root;
 *   - absolute URLs are left untouched; site-absolute routes gain the
 *     deployment base (the route itself is kept as written).
 *
 * Runs on both the Markdown (ADR pages) and the MDX (section pages)
 * pipelines. Links inside fenced code blocks are never touched: code is
 * content and keeps its literal form (at the mdast level, code blocks are
 * `code` nodes — the `link` visitor cannot fire inside them).
 */
export function rewriteLinksPlugin(base = '/', { docsRoot } = {}) {
  const resolveDocsPath = docsRoot ? makeDocsPathResolver(docsRoot) : docsPathOf;
  return {
    name: 'pi-mistral-native-rewrite-links',
    link(node, ctx) {
      const docsPath = resolveDocsPath(ctx.fileURL);
      if (!docsPath) return;
      const target = node.url ?? '';
      if (/^([a-z]+:)?\/\//i.test(target)) return;
      // Site-absolute routes ('/reference/tools/'): keep the route, gain the
      // deployment base — Astro rewrites its own URLs but not hand-written
      // markdown links, and GitHub Pages serves the site under a subpath.
      if (target.startsWith('/')) {
        if (target.startsWith('//')) return;
        ctx.setProperty(node, 'url', withBase(target, base));
        return;
      }
      const dir = docsPath.slice(0, docsPath.lastIndexOf('/'));
      const anchorMatch = target.match(/^(.*?)(#.*)?$/);
      const [, pathPart, anchor = ''] = anchorMatch;
      const resolved = normalize(`${dir}/${pathPart}`);
      if (/\.mdx?$/.test(resolved)) {
        // The repo README maps to the landing page; docs-internal targets map
        // to their route slug. A .md link resolving somewhere without a site
        // route stays as-is rather than emitting a broken absolute link.
        if (resolved !== 'README.md' && !resolved.startsWith('docs/')) return;
        const slug = docsPathToSlug(resolved);
        const route = `/${slug}${slug ? '/' : ''}${anchor}`;
        ctx.setProperty(node, 'url', withBase(route, base));
        return;
      }
      if (resolved.startsWith('docs/')) return;
      // assets/ is synced to the site root; every other target above docs/
      // has no shipped artifact, so the link markup goes and the label stays.
      if (resolved.startsWith('assets/')) return;
      ctx.replaceNode(node, node.children);
    },
  };
}

/** Prefix the deployment base onto a site-absolute route. */
function withBase(route, base) {
  if (!route.startsWith('/') || base === '/' || base === '') return route;
  const normalizedBase = base.endsWith('/') ? base : `${base}/`;
  return `${normalizedBase}${route.slice(1)}`;
}
