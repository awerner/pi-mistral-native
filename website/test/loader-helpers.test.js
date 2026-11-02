import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFrontmatter,
  docsPathToSlug,
  extractAdrStatus,
  extractDescription,
  extractTitle,
  isAdrPage,
  rewriteLinks,
  stripInlineMarkdown,
  transformDocsFile,
} from '../src/loader/helpers.js';

test('docsPathToSlug maps docs paths to site route slugs', () => {
  assert.equal(docsPathToSlug('docs/stream.md'), 'stream');
  assert.equal(docsPathToSlug('docs/adr/0002-mistral-native-provider-for-pi.md'), 'adr/0002-mistral-native-provider-for-pi');
  assert.equal(docsPathToSlug('docs/adr/process/0007-adr-taxonomy.md'), 'adr/process/0007-adr-taxonomy');
  assert.equal(docsPathToSlug('docs/adr/README.md'), 'adr');
  assert.equal(docsPathToSlug('docs/adr/process/README.md'), 'adr/process');
  // The repo README maps to the landing page (site-authored, slug-less).
  assert.equal(docsPathToSlug('README.md'), '');
});

test('docsPathToSlug rejects paths outside docs/ (other than the repo README)', () => {
  assert.throws(() => docsPathToSlug('extensions/mistral.ts'), /Not a docs path/);
  assert.throws(() => docsPathToSlug('website/src/pages/index.astro'), /Not a docs path/);
});

test('extractTitle returns the first level-1 heading text', () => {
  assert.equal(extractTitle('# Chat streaming (`mistral-chat`)\n\nbody'), 'Chat streaming (`mistral-chat`)');
  assert.equal(extractTitle('## Not a title\n\n# Real title'), 'Real title');
  assert.equal(extractTitle('no heading here'), null);
});

test('stripInlineMarkdown removes emphasis, code spans and link syntax', () => {
  assert.equal(stripInlineMarkdown('**bold** and *italic*'), 'bold and italic');
  assert.equal(stripInlineMarkdown('`code` spans'), 'code spans');
  assert.equal(stripInlineMarkdown('[label](target.md)'), 'label');
  assert.equal(stripInlineMarkdown('[`docs/x.md`](../docs/x.md) stays'), 'docs/x.md stays');
});

test('extractDescription returns the first non-heading paragraph as plain text', () => {
  const body = [
    '# Title',
    '',
    'This is the **first** paragraph with a [link](x.md) and `code`.',
    '',
    'Second paragraph.',
  ].join('\n');
  assert.equal(extractDescription(body), 'This is the first paragraph with a link and code.');
});

test('extractDescription skips lists, tables, quotes and fenced code', () => {
  const body = [
    '# Title',
    '',
    '```bash',
    'npm install',
    '```',
    '',
    '- list item',
    '| a | b |',
    '> quote',
    '1. numbered',
    '',
    'The real first paragraph.',
  ].join('\n');
  assert.equal(extractDescription(body), 'The real first paragraph.');
});

test('extractDescription truncates around 200 characters on a word boundary', () => {
  const long = 'word '.repeat(60).trim();
  const result = extractDescription(`# T\n\n${long}`);
  assert.ok(result.length <= 201, `expected <= 201 chars, got ${result.length}`);
  assert.ok(result.endsWith('…'));
  assert.ok(!result.endsWith(' …'), 'no trailing space before the ellipsis');
});

test('extractAdrStatus parses the ADR status line', () => {
  assert.deepEqual(extractAdrStatus('- **Status**: Trial'), { status: 'trial' });
  assert.deepEqual(extractAdrStatus('- **Status**: Accepted'), { status: 'accepted' });
  assert.deepEqual(extractAdrStatus('- **Status**: Superseded by 0003'), {
    status: 'superseded',
    supersededBy: '0003',
  });
  assert.equal(extractAdrStatus('no status line'), null);
});

test('extractAdrStatus accepts case variants of the superseded form', () => {
  // The ADR template and index narrative spell the form in running prose, so
  // any casing must parse (the regex is case-insensitive by contract).
  assert.deepEqual(extractAdrStatus('- **Status**: superseded by 0012'), {
    status: 'superseded',
    supersededBy: '0012',
  });
  assert.deepEqual(extractAdrStatus('- **Status**: SUPERSEDED BY 0012'), {
    status: 'superseded',
    supersededBy: '0012',
  });
});

test('isAdrPage recognizes ADR directories', () => {
  assert.equal(isAdrPage('docs/adr/0002-x.md'), true);
  assert.equal(isAdrPage('docs/adr/process/0007-x.md'), true);
  assert.equal(isAdrPage('docs/stream.md'), false);
});

test('buildFrontmatter injects title and description', () => {
  const fm = buildFrontmatter(
    'docs/stream.md',
    '# Chat streaming\n\nFirst paragraph of the doc.',
  );
  assert.equal(fm.title, 'Chat streaming');
  assert.equal(fm.description, 'First paragraph of the doc.');
  assert.equal(fm.adrStatus, undefined);
});

test('buildFrontmatter adds ADR status fields only for ADR pages', () => {
  const adrBody = '# 0002. Title\n\n- **Status**: Trial\n- **Date**: 2026-10-30\n\n## Context\n\nText.';
  const adrFm = buildFrontmatter('docs/adr/0002-title.md', adrBody);
  assert.equal(adrFm.adrStatus, 'trial');
  assert.equal(adrFm.supersededBy, undefined);

  const nonAdrFm = buildFrontmatter('docs/stream.md', adrBody);
  assert.equal(nonAdrFm.adrStatus, undefined);
});

test('buildFrontmatter includes supersededBy for superseded ADRs', () => {
  const fm = buildFrontmatter('docs/adr/0001-old.md', '# 0001. Old\n\n- **Status**: Superseded by 0009\n\nBody.');
  assert.equal(fm.adrStatus, 'superseded');
  assert.equal(fm.supersededBy, '0009');
});

test('rewriteLinks rewrites same-directory .md links', () => {
  const body = 'See [configuration.md](configuration.md) for details.';
  assert.equal(
    rewriteLinks(body, 'docs/stream.md'),
    'See [configuration.md](/configuration/) for details.',
  );
});

test('rewriteLinks rewrites links into the adr directories', () => {
  assert.equal(
    rewriteLinks('See [0003](0003-vendored-openapi-spec.md).', 'docs/adr/0002-x.md'),
    'See [0003](/adr/0003-vendored-openapi-spec/).',
  );
  assert.equal(
    rewriteLinks('See [process](adr/process/0005-x.md).', 'docs/stream.md'),
    'See [process](/adr/process/0005-x/).',
  );
});

test('rewriteLinks resolves relative paths from docs/adr', () => {
  assert.equal(
    rewriteLinks('Index: [process/0007](process/0007-adr-taxonomy.md).', 'docs/adr/README.md'),
    'Index: [process/0007](/adr/process/0007-adr-taxonomy/).',
  );
  assert.equal(
    rewriteLinks('Up: [docs index](../README.md).', 'docs/adr/README.md'),
    'Up: [docs index](/).',
  );
});

test('rewriteLinks resolves the README Quickstart link to the landing page', () => {
  assert.equal(
    rewriteLinks('[README](../README.md#quickstart).', 'docs/stream.md'),
    '[README](/#quickstart).',
  );
});

test('rewriteLinks preserves anchors', () => {
  assert.equal(
    rewriteLinks('[rates](catalog.md#family-rate-card-default_rates).', 'docs/stream.md'),
    '[rates](/catalog/#family-rate-card-default_rates).',
  );
});

test('rewriteLinks keeps links to repo-root assets that the site ships', () => {
  const body = 'Banner: [svg](../assets/banner.svg) and [html](../assets/banner-source.html).';
  // ../assets/… from docs/design-tokens.md escapes docs/ but resolves to the
  // repository assets synced onto the site root, so it keeps its link form.
  assert.equal(rewriteLinks(body, 'docs/design-tokens.md'), body);
  const inside = 'See [the schema](config/mistral-native.json).';
  assert.equal(rewriteLinks(inside, 'docs/stream.md'), inside);
});

test('rewriteLinks strips non-.md relative links that resolve above the docs tree', () => {
  // Artifacts outside docs/ (e.g. the vendored spec) are not shipped on the
  // site and have no route: the link markup goes, the visible label stays as
  // plain text — a dead link is worse than no link.
  const body = 'Vendored [OpenAPI spec](../../vendor/mistral-openapi.yaml), ADR [0003](0003-vendored-openapi-spec.md).';
  assert.equal(
    rewriteLinks(body, 'docs/adr/0014-x.md'),
    'Vendored OpenAPI spec, ADR [0003](/adr/0003-vendored-openapi-spec/).',
  );
  assert.equal(
    rewriteLinks('[ci](../.forgejo/workflows/ci.yaml)', 'docs/development.md'),
    'ci',
  );
  assert.equal(
    rewriteLinks('[manifests](../deploy/website.yaml)', 'docs/development.md'),
    'manifests',
  );
  assert.equal(
    rewriteLinks('[badge](../../workflow/badge.svg)', 'docs/adr/0002-x.md'),
    'badge',
  );
});

test('rewriteLinks leaves absolute URLs and site-absolute links untouched', () => {
  const body = 'See [pi](https://pi.dev) and [root](/stream/).';
  assert.equal(rewriteLinks(body, 'docs/stream.md'), body);
});

test('rewriteLinks leaves .md links outside the mapped surface untouched', () => {
  // A .md link resolving somewhere without a site route stays as-is rather
  // than emitting a broken absolute link.
  const body = 'See [other](../../outside/thing.md).';
  assert.equal(rewriteLinks(body, 'docs/adr/0002-x.md'), body);
});

test('rewriteLinks never rewrites links inside fenced code blocks', () => {
  const body = [
    'Text with a real [link](0005-documentation-structure-and-adr-citation.md).',
    '',
    '```markdown',
    'Use the literal form: [ADR 0004 — Title](../0004-api-key-credential-chain-without-mistral-oauth.md).',
    '```',
    '',
    'After the fence: [0008](0008-reference-discipline.md).',
  ].join('\n');
  const result = rewriteLinks(body, 'docs/adr/process/0005-x.md');
  assert.ok(result.includes('](../0004-api-key-credential-chain-without-mistral-oauth.md)'),
    'fenced link must keep its literal .md target');
  assert.ok(!result.includes('](/adr/0004-'), 'fenced link must not become a site route');
  assert.ok(result.includes('](/adr/process/0005-documentation-structure-and-adr-citation/)'),
    'link before the fence is rewritten');
  assert.ok(result.includes('](/adr/process/0008-reference-discipline/)'),
    'link after the fence is rewritten');
});

test('rewriteLinks keeps non-.md text replacement out of fenced code blocks', () => {
  const body = '```text\nsee [spec](../vendor/mistral-openapi.yaml)\n```';
  assert.equal(rewriteLinks(body, 'docs/adr/0014-x.md'), body);
});

test('rewriteLinks does not toggle fences on backticks inside code spans', () => {
  const body = 'Use ``` `markdown` ``` fences: [catalog](catalog.md).';
  const result = rewriteLinks(body, 'docs/stream.md');
  assert.ok(result.includes('](/catalog/)'),
    'a fence-looking code span must not suppress rewriting');
});

test('transformDocsFile combines frontmatter injection and link rewriting', () => {
  const raw = '# 0007. Taxonomy\n\n- **Status**: Trial\n\nSee [0008](0008-reference-discipline.md).';
  const result = transformDocsFile('docs/adr/process/0007-adr-taxonomy.md', raw);
  assert.equal(result.frontmatter.title, '0007. Taxonomy');
  assert.equal(result.frontmatter.adrStatus, 'trial');
  assert.ok(result.body.includes('](/adr/process/0008-reference-discipline/)'));
  assert.ok(!result.body.includes('](0008-'), 'raw .md link must be rewritten');
});
