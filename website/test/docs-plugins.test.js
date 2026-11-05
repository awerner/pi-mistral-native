// Compile-time docs plugins (src/loader/docs-plugins.js): the first-H1 drop
// and .md link rewriting run inside the Sätteri compile for ingested docs
// pages (the deferred render compiles the on-disk file, so the loader cannot
// transform bodies). These tests drive the plugins through the REAL satteri
// pipeline (markdownToHtml) against fixture files, pinning the rendered
// output. The plugins guard on the docs tree; the tests point that guard at
// a fixture tree via the injectable docsRoot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { dropFirstH1Plugin, rewriteLinksPlugin } from '../src/loader/docs-plugins.js';

const DOCS_FIXTURE = mkdtempSync(path.join(tmpdir(), 'docs-plugins-fixture-'));
mkdirSync(path.join(DOCS_FIXTURE, 'how-to'), { recursive: true });
mkdirSync(path.join(DOCS_FIXTURE, 'dev/adr'), { recursive: true });
writeFileSync(path.join(DOCS_FIXTURE, 'how-to', 'a.mdx'), '# A\n\nbody\n');
writeFileSync(path.join(DOCS_FIXTURE, 'dev/adr', '0010-x.md'), '# 0010\n\nbody\n');
const fileURL = (rel) => pathToFileURL(path.join(DOCS_FIXTURE, rel));

test.after(() => rmSync(DOCS_FIXTURE, { recursive: true, force: true }));

const pluginOpts = { docsRoot: DOCS_FIXTURE };

test('the docs plugins export mdast plugin factories', () => {
  const drop = dropFirstH1Plugin(pluginOpts);
  assert.equal(typeof drop.heading, 'function');
  assert.equal(typeof drop.name, 'string');
  const rewrite = rewriteLinksPlugin('/', pluginOpts);
  assert.equal(typeof rewrite.link, 'function');
  assert.equal(typeof rewrite.name, 'string');
});

test('rewriteLinksPlugin rewrites .mdx links to base-prefixed routes', async () => {
  const { markdownToHtml } = await import('satteri');
  const { html } = await markdownToHtml(
    'See [Tools](../reference/tools.mdx) and [ADR](../dev/adr/0010-x.md).',
    { mdastPlugins: [rewriteLinksPlugin('/pi-mistral-native/', pluginOpts)], fileURL: fileURL('how-to/a.mdx') }
  );
  assert.ok(html.includes('href="/pi-mistral-native/reference/tools/"'));
  assert.ok(html.includes('href="/pi-mistral-native/dev/adr/0010-x/"'));
});

test('rewriteLinksPlugin maps the repo README to the landing page', async () => {
  const { markdownToHtml } = await import('satteri');
  const { html } = await markdownToHtml('[Quickstart](../README.md#quickstart)', {
    mdastPlugins: [rewriteLinksPlugin('/pi-mistral-native/', pluginOpts)],
    fileURL: fileURL('how-to/a.mdx'),
  });
  assert.ok(html.includes('href="/pi-mistral-native/#quickstart"'));
});

test('rewriteLinksPlugin strips links that resolve above the docs tree', async () => {
  const { markdownToHtml } = await import('satteri');
  const { html } = await markdownToHtml('Vendored [spec](../../../vendor/openapi.yaml).', {
    mdastPlugins: [rewriteLinksPlugin('/', pluginOpts)],
    fileURL: fileURL('dev/adr/0010-x.md'),
  });
  assert.ok(!html.includes('<a '), 'the link markup is removed');
  assert.ok(html.includes('Vendored spec'), 'the visible label stays as text');
});

test('rewriteLinksPlugin keeps assets links untouched and prefixes site-absolute routes with the base', async () => {
  const { markdownToHtml } = await import('satteri');
  const { html } = await markdownToHtml(
    'See [banner](../../assets/banner.svg) and [root](/reference/tools/) and [web](https://pi.dev).',
    { mdastPlugins: [rewriteLinksPlugin('/pi-mistral-native/', pluginOpts)], fileURL: fileURL('dev/adr/0010-x.md') }
  );
  assert.ok(html.includes('href="../../assets/banner.svg"'));
  assert.ok(html.includes('href="/pi-mistral-native/reference/tools/"'),
    'site-absolute routes gain the deployment base');
  assert.ok(html.includes('href="https://pi.dev"'));
});

test('rewriteLinksPlugin never touches links inside fenced code blocks', async () => {
  const { markdownToHtml } = await import('satteri');
  const { html } = await markdownToHtml(
    '```markdown\n[Literal](../reference/tools.mdx)\n```\n\nReal [Tools](../reference/tools.mdx).',
    { mdastPlugins: [rewriteLinksPlugin('/', pluginOpts)], fileURL: fileURL('how-to/a.mdx') }
  );
  const fenced = html.match(/<pre[\s\S]*?<\/pre>/);
  assert.ok(fenced, 'a fenced code block renders');
  assert.ok(fenced[0].includes('[Literal](../reference/tools.mdx)'),
    'the fenced link keeps its literal form');
  assert.ok(!fenced[0].includes('<a '), 'no anchor is emitted inside the fence');
});

test('dropFirstH1Plugin removes only the first level-1 heading of docs pages', async () => {
  const { markdownToHtml } = await import('satteri');
  const { html } = await markdownToHtml('# Page title\n\n## Section\n\n# Another H1\n\nbody', {
    mdastPlugins: [dropFirstH1Plugin(pluginOpts)],
    fileURL: fileURL('how-to/a.mdx'),
  });
  const h1s = [...html.matchAll(/<h1[^>]*>/g)];
  assert.equal(h1s.length, 1, 'exactly one H1 remains (the second one)');
  assert.ok(html.includes('Another H1'));
  assert.ok(!html.includes('Page title</h1>'));
});

test('dropFirstH1Plugin leaves files outside the docs tree untouched', async () => {
  const { markdownToHtml } = await import('satteri');
  const { html } = await markdownToHtml('# Keep me\n\nbody', {
    mdastPlugins: [dropFirstH1Plugin(pluginOpts)],
    fileURL: pathToFileURL(path.join(DOCS_FIXTURE, '..', 'outside.mdx')),
  });
  assert.ok(html.includes('Keep me'));
});
