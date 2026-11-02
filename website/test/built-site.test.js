// Built-site check: runs AFTER `npm run build`. Scans dist/**/*.html and
// fails when any href escapes the deployment base — Astro rewrites its own
// URLs, but hand-written hrefs and loader-rewritten markdown links must
// carry the base themselves (GitHub Pages serves the site from a subpath).
//
// Skips when dist/ is absent so the unit suite (`npm test`) stays green
// before a build; `npm run test:dist` sets REQUIRE_DIST=1 so the check fails
// loudly instead of skipping when nothing was built.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const websiteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(websiteRoot, 'dist');

async function walkHtml(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walkHtml(entryPath)));
    else if (entry.isFile() && entry.name.endsWith('.html')) files.push(entryPath);
  }
  return files;
}

test('built site keeps every absolute href under the deployment base', {
  skip: !existsSync(distDir) && process.env.REQUIRE_DIST !== '1' &&
    'dist/ not built yet — run npm run build first',
}, async () => {
  assert.ok(existsSync(distDir), 'dist/ not built — run npm run build before this check');
  const { default: config } = await import('../astro.config.mjs');
  const base = config.base ?? '/';
  const basePrefix = base === '/' ? '/' : base.endsWith('/') ? base : `${base}/`;

  const files = await walkHtml(distDir);
  assert.ok(files.length > 0, 'no built HTML pages found under dist/');

  const escapees = [];
  for (const file of files) {
    const html = await fs.readFile(file, 'utf8');
    for (const match of html.matchAll(/(?:href|src)="([^"]*)"/g)) {
      const target = match[1];
      // Site-absolute routes must carry the base; scheme URLs, protocol-
      // relative targets and page-internal anchors are fine. basePrefix
      // always ends in '/', so the prefix match is segment-boundary safe:
      // a base without a trailing slash cannot let '/pi-mistral-native-evil/'
      // pass as under the base.
      if (target.startsWith('/') && !target.startsWith('//') && !target.startsWith(basePrefix)) {
        escapees.push(`${path.relative(websiteRoot, file)}: ${target}`);
      }
    }
  }
  // Every href in the landed pages either points outside the site by
  // scheme or anchor, or sits under the base — no domain-root 404s.
  assert.deepEqual(escapees, [], `hrefs escaping ${JSON.stringify(basePrefix)}:\n${escapees.join('\n')}`);
});

test('every built page renders exactly one h1', {
  skip: !existsSync(distDir) && process.env.REQUIRE_DIST !== '1' &&
    'dist/ not built yet — run npm run build first',
}, async () => {
  assert.ok(existsSync(distDir), 'dist/ not built — run npm run build before this check');

  const files = await walkHtml(distDir);
  assert.ok(files.length > 0, 'no built HTML pages found under dist/');

  const wrong = [];
  for (const file of files) {
    const html = await fs.readFile(file, 'utf8');
    const count = [...html.matchAll(/<h1[\s>]/g)].length;
    if (count !== 1) {
      wrong.push(`${path.relative(websiteRoot, file)}: ${count} h1 elements`);
    }
  }
  // The Starlight page title renders the h1; the ingested doc's own first
  // H1 is dropped by the loader, so a doc page must never carry two.
  assert.deepEqual(wrong, [], `pages without exactly one h1:\n${wrong.join('\n')}`);
});

test('rendered sidebar labels contain no literal backticks', {
  skip: !existsSync(distDir) && process.env.REQUIRE_DIST !== '1' &&
    'dist/ not built yet — run npm run build first',
}, async () => {
  assert.ok(existsSync(distDir), 'dist/ not built — run npm run build before this check');

  const files = await walkHtml(distDir);
  assert.ok(files.length > 0, 'no built HTML pages found under dist/');

  const offenders = [];
  for (const file of files) {
    const html = await fs.readFile(file, 'utf8');
    const nav = html.match(/<nav class="sidebar[\s\S]*?<\/nav>/);
    // Starlight's PageFrame ships the mobile-menu popover <script> inside
    // the sidebar nav; its compiled code uses template literals, so scripts
    // are stripped — the check targets the rendered labels, not Starlight's
    // own code.
    const labels = nav && nav[0].replace(/<script\b[\s\S]*?<\/script>/g, '');
    if (labels && labels.includes('`')) {
      offenders.push(path.relative(websiteRoot, file));
    }
  }
  // Sidebar labels are plain text (the frontmatter title has inline
  // markdown stripped); a literal backtick means a raw title leaked
  // through unstripped.
  assert.deepEqual(offenders, [], `sidebar backticks in:\n${offenders.join('\n')}`);
});
