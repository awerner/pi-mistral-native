// Ingestion helpers for the Starlight docs collection.
//
// The repository docs (docs/**/*.md) are the single source of truth and
// carry no frontmatter; everything here transforms file content IN MEMORY
// (frontmatter injection, ADR status parsing, .md link rewriting) without
// ever writing back to disk.
//
// Import surfaces:
//   - Node tests import from './src/loader/helpers.js' directly.
//   - astro.config.mjs uses the same plain functions.

/**
 * Resolve a POSIX-style docs-relative path (e.g. `docs/stream.md`,
 * `docs/adr/0002-x.md`, `docs/adr/README.md`) to its site route slug
 * (e.g. `stream`, `adr/0002-x`, `adr`). The repository root README (which the
 * docs link as `../README.md`) maps to the empty slug: the site landing page.
 */
export function docsPathToSlug(docsPath) {
  const posixPath = docsPath.replaceAll('\\', '/');
  if (posixPath === 'README.md') return '';
  if (!posixPath.startsWith('docs/')) {
    throw new Error(`Not a docs path: ${docsPath}`);
  }
  let rest = posixPath.slice('docs/'.length);
  if (rest === 'README.md') return '';
  // docs/<dir>/README.md collapses to the directory route (docs/adr/README.md -> adr).
  if (rest.endsWith('/README.md')) {
    return rest.slice(0, -'/README.md'.length);
  }
  if (rest.endsWith('README.md')) {
    return rest.slice(0, -'README.md'.length).replaceAll(/\/+$/, '');
  }
  if (!rest.endsWith('.md')) {
    throw new Error(`Not a markdown file: ${docsPath}`);
  }
  return rest.slice(0, -'.md'.length);
}

/**
 * Extract the page title: the text content of the first `# ` heading.
 * Returns null when the document has no level-1 heading.
 */
export function extractTitle(body) {
  const match = body.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : null;
}

/**
 * Strip inline markdown (emphasis, code spans, links) to plain text.
 * Only constructs that actually occur in the repository docs are handled;
 * unknown markdown passes through unchanged.
 */
export function stripInlineMarkdown(text) {
  return text
    // [`code`](target) and [label](target) keep the label only
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$1')
    // **bold** and *italic*
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    // `code spans`
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

/**
 * Prefix the Astro base path onto a site-absolute route ('/stream/' →
 * '/pi-mistral-native/stream/' when GitHub Pages serves the site from a
 * subpath). The default base '/' (dev server, plain Node) leaves routes
 * * unchanged; paths that do not start with '/' are returned untouched.
 */
export function withBase(route, base = '/') {
  if (!route.startsWith('/') || base === '/' || base === '') return route;
  const normalizedBase = base.endsWith('/') ? base : `${base}/`;
  return `${normalizedBase}${route.slice(1)}`;
}

/**
 * Extract the description: the plain text of the first non-heading,
 * non-list, non-table, non-fenced-code paragraph. Truncated with an
 * ellipsis around 200 characters. Returns null when no paragraph exists.
 */
export function extractDescription(body) {
  const lines = body.split('\n');
  let inFence = false;
  let paragraph = [];
  const flush = () => {
    if (paragraph.length > 0) {
      const text = stripInlineMarkdown(paragraph.join(' ').replace(/\s+/g, ' '));
      if (text) return text;
    }
    paragraph = [];
    return null;
  };
  for (const line of lines) {
    if (line.trimStart().startsWith('```')) {
      const done = inFence && paragraph.length === 0 ? flush() : null;
      if (done) return truncateDescription(done);
      inFence = !inFence;
      paragraph = [];
      continue;
    }
    if (inFence) continue;
    const trimmed = line.trim();
    if (trimmed === '') {
      const done = flush();
      if (done) return truncateDescription(done);
      continue;
    }
    if (
      trimmed.startsWith('#') ||
      trimmed.startsWith('-') ||
      trimmed.startsWith('* ') ||
      trimmed.startsWith('>') ||
      trimmed.startsWith('|') ||
      /^\d+\./.test(trimmed)
    ) {
      continue;
    }
    paragraph.push(trimmed);
  }
  const done = flush();
  return done ? truncateDescription(done) : null;
}

function truncateDescription(text) {
  if (text.length <= 200) return text;
  // Cut on the last word boundary before 200 characters.
  const cut = text.slice(0, 200);
  const boundary = cut.lastIndexOf(' ');
  return `${(boundary > 120 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
}

/**
 * Parse the ADR status line (`- **Status**: Trial | Accepted | Superseded by
 * NNNN`). Returns one of:
 *   - `{ status: 'trial' | 'accepted' }`
 *   - `{ status: 'superseded', supersededBy: 'NNNN' }`
 *   - `null` when no status line is present.
 */
export function extractAdrStatus(body) {
  const match = body.match(/^- \*\*Status\*\*:\s*(.+)$/m);
  if (!match) return null;
  const value = match[1].trim();
  if (/^superseded by (\d+)$/i.test(value)) {
    return { status: 'superseded', supersededBy: value.match(/^superseded by (\d+)$/i)[1] };
  }
  if (value === 'Accepted') return { status: 'accepted' };
  return { status: 'trial' };
}

/**
 * True when the docs path belongs to the ADR directories (docs/adr/ or
 * docs/adr/process/) — i.e. when the status line carries lifecycle meaning.
 */
export function isAdrPage(docsPath) {
  return /^docs\/adr\/(process\/)?.+\.md$/.test(docsPath);
}

/**
 * Rewrite relative links in a markdown body to their site form:
 *   - `.md` links resolve against the page's docs path and become site
 *     routes (anchors preserved).
 *   - non-.md relative links resolving ABOVE the docs tree (e.g. a docs file
 *     linking `../vendor/…`) have no site route and no shipped artifact, so
 *     the link markup is removed and only the visible label text remains —
 *     a dead link is worse than no link. Repo-root `assets/` is the one
 *     exception: it is synced onto the site root and its links keep working.
 * Links inside fenced code blocks are never touched: code is content and
 * must keep its literal form.
 * Absolute URLs, site-absolute links and non-.md links that stay inside the
 * docs tree (e.g. `../assets/banner.svg`, synced to the site root) are left
 * untouched.
 *
 * `base` is the Astro base path (dev '/' → routes unchanged; build
 * '/pi-mistral-native/' → rewritten routes gain the base prefix). Only the
 * .md-link rewrite branch emits routes, so only it is base-aware —
 * site-absolute links an author wrote deliberately keep their literal form.
 */
export function rewriteLinks(body, docsPath, base = '/') {
  const dir = dirnameOf(docsPath);
  const out = [];
  let inFence = false;
  // Fences open/close with a line starting with ```; a line merely
  // containing ``` (e.g. inside a code span) never toggles the state.
  for (const line of body.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    out.push(rewriteLinksInLine(line, dir, base));
  }
  return out.join('\n');
}

function rewriteLinksInLine(line, dir, base) {
  return line.replace(/\[([^\]]*)\]\(([^)]+)\)/g, (whole, label, target) => {
    if (/^([a-z]+:)?\/\//i.test(target) || target.startsWith('/')) return whole;
    const anchorMatch = target.match(/^(.*?)(#.*)?$/);
    const [, pathPart, anchor = ''] = anchorMatch;
    const resolved = normalize(`${dir}/${pathPart}`);
    // The repo README maps to the landing page; docs-internal targets map to
    // their route slug. Anything else has no site route: .md links stay
    // untouched, non-.md targets resolve outside the shipped site and lose
    // their link markup (the visible label remains as plain text).
    if (pathPart.endsWith('.md') || /\.md$/.test(resolved)) {
      if (resolved !== 'README.md' && !resolved.startsWith('docs/')) return whole;
      const slug = docsPathToSlug(resolved);
      const route = `/${slug}${slug ? '/' : ''}${anchor}`;
      return `[${label}](${withBase(route, base)})`;
    }
    if (resolved.startsWith('docs/')) return whole;
    // assets/ is synced to the site root; every other target above docs/
    // has no shipped artifact, so the link markup goes and the label stays.
    if (resolved.startsWith('assets/')) return whole;
    return label;
  });
}

function dirnameOf(posixPath) {
  const idx = posixPath.lastIndexOf('/');
  return idx === -1 ? '' : posixPath.slice(0, idx);
}

/** Normalize `a/./b`, `a/x/../b` and duplicate-slash segments. */
function normalize(path) {
  const out = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

/**
 * Build the in-memory frontmatter for one ingested docs file.
 * `body` is the raw markdown (without frontmatter).
 */
export function buildFrontmatter(docsPath, body) {
  const frontmatter = {
    title: extractTitle(body) ?? docsPathToSlug(docsPath),
    description: extractDescription(body) ?? undefined,
  };
  if (isAdrPage(docsPath)) {
    const status = extractAdrStatus(body);
    if (status) {
      frontmatter.adrStatus = status.status;
      if (status.supersededBy !== undefined) {
        frontmatter.supersededBy = status.supersededBy;
      }
    }
  }
  return frontmatter;
}

/**
 * Full in-memory transformation for one docs file: returns the frontmatter
 * object and the transformed markdown body (links rewritten, `base` passed
 * through to the link rewriter).
 */
export function transformDocsFile(docsPath, body, base = '/') {
  return {
    frontmatter: buildFrontmatter(docsPath, body),
    body: rewriteLinks(body, docsPath, base),
  };
}
