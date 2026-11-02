// Inline-whitespace check: runs AFTER `npm run build`. Astro's JSX-style
// template compiler collapses a newline plus indentation between template
// text and an inline element into a single markup-whitespace boundary, which
// drops the inter-word space: "…for the\n<a …>…" renders as "the<a>". This
// walks dist/**/*.html and fails when a lowercase letter directly abuts an
// inline-element tag boundary — evidence of a glued word in built output.
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

// Literal code samples (e.g. `foo<a` as shown in <pre>/<code> markdown, or
// JS inside <script>) may legitimately contain a letter abutting an angle
// bracket. Strip preformatted and executable spans before checking so those
// samples do not mask real template collapses as false negatives, nor
// surface as false positives.
function stripNonProse(html) {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<pre\b[\s\S]*?<\/pre>/gi, '');
}

test('built site keeps inter-word spaces around inline elements', {
  skip: !existsSync(distDir) && process.env.REQUIRE_DIST !== '1' &&
    'dist/ not built yet — run npm run build first',
}, async () => {
  assert.ok(existsSync(distDir), 'dist/ not built — run npm run build before this check');

  const files = await walkHtml(distDir);
  assert.ok(files.length > 0, 'no built HTML pages found under dist/');

  // A lowercase letter directly abutting an inline-element boundary in
  // rendered prose means the whitespace between two words was collapsed away:
  // a letter immediately before an opening tag ("the<a …"), or a closing tag
  // immediately before a letter ("</code>provider").
  const collapse = /[a-z]<(?:a|code|strong|em)[ >]|<\/(?:a|code|strong|em)>[a-z]/g;

  const glued = [];
  for (const file of files) {
    const html = stripNonProse(await fs.readFile(file, 'utf8'));
    for (const match of html.matchAll(collapse)) {
      glued.push(`${path.relative(websiteRoot, file)}: ${match[0]}`);
    }
  }
  assert.deepEqual(glued, [], `text glued to inline elements:\n${glued.join('\n')}`);
});
