import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFrontmatter,
  docsPathToSlug,
  dropFirstH1,
  extractAdrStatus,
  extractDescription,
  extractTitle,
  formatTitleHtml,
  isAdrPage,
  rewriteLinks,
  stripInlineMarkdown,
  transformDocsFile,
  withBase,
} from '../src/loader/helpers.js';

test('docsPathToSlug maps docs paths to site route slugs', () => {
  assert.equal(docsPathToSlug('docs/stream.md'), 'stream');
  assert.equal(docsPathToSlug('docs/dev/adr/0002-mistral-native-provider-for-pi.md'), 'dev/adr/0002-mistral-native-provider-for-pi');
  assert.equal(docsPathToSlug('docs/dev/adr/process/0007-adr-taxonomy.md'), 'dev/adr/process/0007-adr-taxonomy');
  assert.equal(docsPathToSlug('docs/dev/adr/README.md'), 'dev/adr');
  assert.equal(docsPathToSlug('docs/dev/adr/process/README.md'), 'dev/adr/process');
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

test('extractTitle skips level-1 headings inside fenced code blocks', () => {
  const body = [
    '# Real title',
    '',
    '```markdown',
    '# not a title',
    '```',
    '',
    'Body text.',
  ].join('\n');
  assert.equal(extractTitle(body), 'Real title');
  // A fenced `# ` line before any real heading is not the title either.
  assert.equal(extractTitle('```text\n# not a title\n```\n\n# The real one'), 'The real one');
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
  assert.equal(isAdrPage('docs/dev/adr/0002-x.md'), true);
  assert.equal(isAdrPage('docs/dev/adr/process/0007-x.md'), true);
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

test('buildFrontmatter strips inline markdown from the title and emits matching titleHtml', () => {
  const fm = buildFrontmatter('docs/stream.md', '# Chat streaming (`mistral-chat`)\n\nBody.');
  assert.equal(fm.title, 'Chat streaming (mistral-chat)');
  assert.equal(fm.titleHtml, 'Chat streaming (<code>mistral-chat</code>)');
});

test('buildFrontmatter adds ADR status fields only for ADR pages', () => {
  const adrBody = '# 0002. Title\n\n- **Status**: Trial\n- **Date**: 2026-10-30\n\n## Context\n\nText.';
  const adrFm = buildFrontmatter('docs/dev/adr/0002-title.md', adrBody);
  assert.equal(adrFm.adrStatus, 'trial');
  assert.equal(adrFm.supersededBy, undefined);

  const nonAdrFm = buildFrontmatter('docs/stream.md', adrBody);
  assert.equal(nonAdrFm.adrStatus, undefined);
});

test('buildFrontmatter includes supersededBy for superseded ADRs', () => {
  const fm = buildFrontmatter('docs/dev/adr/0001-old.md', '# 0001. Old\n\n- **Status**: Superseded by 0009\n\nBody.');
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
    rewriteLinks('See [0003](0003-vendored-openapi-spec.md).', 'docs/dev/adr/0002-x.md'),
    'See [0003](/dev/adr/0003-vendored-openapi-spec/).',
  );
  assert.equal(
    rewriteLinks('See [process](dev/adr/process/0005-x.md).', 'docs/stream.md'),
    'See [process](/dev/adr/process/0005-x/).',
  );
});

test('rewriteLinks resolves relative paths from docs/dev/adr', () => {
  assert.equal(
    rewriteLinks('Index: [process/0007](process/0007-adr-taxonomy.md).', 'docs/dev/adr/README.md'),
    'Index: [process/0007](/dev/adr/process/0007-adr-taxonomy/).',
  );
  assert.equal(
    rewriteLinks('Up: [docs index](../../../README.md).', 'docs/dev/adr/README.md'),
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
  const body = 'Banner: [svg](../../assets/banner.svg) and [html](../../assets/banner-source.html).';
  // ../../assets/… from docs/dev/design-tokens.md escapes docs/ but resolves
  // to the repository assets synced onto the site root, so it keeps its
  // link form.
  assert.equal(rewriteLinks(body, 'docs/dev/design-tokens.md'), body);
  const inside = 'See [the schema](config/mistral-native.json).';
  assert.equal(rewriteLinks(inside, 'docs/stream.md'), inside);
});

test('rewriteLinks strips non-.md relative links that resolve above the docs tree', () => {
  // Artifacts outside docs/ (e.g. the vendored spec) are not shipped on the
  // site and have no route: the link markup goes, the visible label stays as
  // plain text — a dead link is worse than no link.
  const body = 'Vendored [OpenAPI spec](../../../vendor/mistral-openapi.yaml), ADR [0003](0003-vendored-openapi-spec.md).';
  assert.equal(
    rewriteLinks(body, 'docs/dev/adr/0014-x.md'),
    'Vendored OpenAPI spec, ADR [0003](/dev/adr/0003-vendored-openapi-spec/).',
  );
  assert.equal(
    rewriteLinks('[ci](../../.github/workflows/ci.yml)', 'docs/dev/development.md'),
    'ci',
  );
  assert.equal(
    rewriteLinks('[config](../../website/astro.config.mjs)', 'docs/dev/development.md'),
    'config',
  );
  assert.equal(
    rewriteLinks('[badge](../../../workflow/badge.svg)', 'docs/dev/adr/0002-x.md'),
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
  const body = 'See [other](../../../outside/thing.md).';
  assert.equal(rewriteLinks(body, 'docs/dev/adr/0002-x.md'), body);
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
  const result = rewriteLinks(body, 'docs/dev/adr/process/0005-x.md');
  assert.ok(result.includes('](../0004-api-key-credential-chain-without-mistral-oauth.md)'),
    'fenced link must keep its literal .md target');
  assert.ok(!result.includes('](/dev/adr/0004-'), 'fenced link must not become a site route');
  assert.ok(result.includes('](/dev/adr/process/0005-documentation-structure-and-adr-citation/)'),
    'link before the fence is rewritten');
  assert.ok(result.includes('](/dev/adr/process/0008-reference-discipline/)'),
    'link after the fence is rewritten');
});

test('rewriteLinks keeps non-.md text replacement out of fenced code blocks', () => {
  const body = '```text\nsee [spec](../../../vendor/mistral-openapi.yaml)\n```';
  assert.equal(rewriteLinks(body, 'docs/dev/adr/0014-x.md'), body);
});

test('rewriteLinks does not toggle fences on backticks inside code spans', () => {
  const body = 'Use ``` `markdown` ``` fences: [catalog](catalog.md).';
  const result = rewriteLinks(body, 'docs/stream.md');
  assert.ok(result.includes('](/catalog/)'),
    'a fence-looking code span must not suppress rewriting');
});

test('transformDocsFile combines frontmatter injection and link rewriting', () => {
  const raw = '# 0007. Taxonomy\n\n- **Status**: Trial\n\nSee [0008](0008-reference-discipline.md).';
  const result = transformDocsFile('docs/dev/adr/process/0007-adr-taxonomy.md', raw);
  assert.equal(result.frontmatter.title, '0007. Taxonomy');
  assert.equal(result.frontmatter.adrStatus, 'trial');
  assert.ok(result.body.includes('](/dev/adr/process/0008-reference-discipline/)'));
  assert.ok(!result.body.includes('](0008-'), 'raw .md link must be rewritten');
});

test('withBase prefixes the deployment base onto site-absolute routes', () => {
  // Dev/plain-Node default: the root base leaves routes unchanged.
  assert.equal(withBase('/stream/'), '/stream/');
  assert.equal(withBase('/'), '/');
  assert.equal(withBase('/stream/', '/'), '/stream/');
  assert.equal(withBase('/stream/', ''), '/stream/');
  // GitHub Pages subpath base.
  assert.equal(withBase('/stream/', '/pi-mistral-native/'), '/pi-mistral-native/stream/');
  // Landing-page route must not gain a double slash.
  assert.equal(withBase('/', '/pi-mistral-native/'), '/pi-mistral-native/');
  // Anchors ride along on the route.
  assert.equal(
    withBase('/catalog/#family-rate-card-default_rates', '/pi-mistral-native/'),
    '/pi-mistral-native/catalog/#family-rate-card-default_rates',
  );
  assert.equal(withBase('/#quickstart', '/pi-mistral-native/'), '/pi-mistral-native/#quickstart');
  // A base without a trailing slash is normalized.
  assert.equal(withBase('/stream/', '/pi-mistral-native'), '/pi-mistral-native/stream/');
  // Non-route values (absolute URLs, relative paths) pass through untouched.
  assert.equal(withBase('https://pi.dev', '/pi-mistral-native/'), 'https://pi.dev');
  assert.equal(withBase('assets/banner.svg', '/pi-mistral-native/'), 'assets/banner.svg');
});

test('rewriteLinks emits base-aware routes when a base is passed', () => {
  // Doc-page .md link (docs/stream.md -> configuration.md).
  assert.equal(
    rewriteLinks('See [configuration.md](configuration.md).', 'docs/stream.md', '/pi-mistral-native/'),
    'See [configuration.md](/pi-mistral-native/configuration/).',
  );
  // ADR-relative link (docs/dev/adr/0002-x.md -> 0003-....md).
  assert.equal(
    rewriteLinks('See [0003](0003-vendored-openapi-spec.md).', 'docs/dev/adr/0002-x.md', '/pi-mistral-native/'),
    'See [0003](/pi-mistral-native/dev/adr/0003-vendored-openapi-spec/).',
  );
  // Landing-page Quickstart link from a docs page.
  assert.equal(
    rewriteLinks('[README](../README.md#quickstart).', 'docs/stream.md', '/pi-mistral-native/'),
    '[README](/pi-mistral-native/#quickstart).',
  );
  // Anchors are preserved under the base.
  assert.equal(
    rewriteLinks('[rates](catalog.md#family-rate-card-default_rates).', 'docs/stream.md', '/pi-mistral-native/'),
    '[rates](/pi-mistral-native/catalog/#family-rate-card-default_rates).',
  );
});

test('rewriteLinks leaves site-absolute links and absolute URLs alone even with a base', () => {
  // Authors write site-absolute links deliberately; the base must not be
  // double-prefixed, and stripping/removal behavior is base-independent.
  const body = 'See [pi](https://pi.dev) and [root](/stream/).';
  assert.equal(rewriteLinks(body, 'docs/stream.md', '/pi-mistral-native/'), body);
  assert.equal(
    rewriteLinks('[ci](../../.github/workflows/ci.yml)', 'docs/dev/development.md', '/pi-mistral-native/'),
    'ci',
  );
});

test('rewriteLinks keeps fenced-code links literal with a base set', () => {
  const body = '```markdown\n[ADR 0004](../0004-x.md)\n```\n\nReal [0008](0008-x.md).';
  const result = rewriteLinks(body, 'docs/dev/adr/process/0007-x.md', '/pi-mistral-native/');
  assert.ok(result.includes('](../0004-x.md)'), 'fenced link keeps its literal .md target');
  assert.ok(result.includes('](/pi-mistral-native/dev/adr/process/0008-x/)'),
    'link outside the fence is base-aware rewritten');
});

test('transformDocsFile flows the base through to the link rewriter', () => {
  const raw = '# 0007. Taxonomy\n\n- **Status**: Trial\n\nSee [0008](0008-reference-discipline.md).';
  const result = transformDocsFile('docs/dev/adr/process/0007-adr-taxonomy.md', raw, '/pi-mistral-native/');
  assert.equal(result.frontmatter.adrStatus, 'trial');
  assert.ok(result.body.includes('](/pi-mistral-native/dev/adr/process/0008-reference-discipline/)'));
});

test('formatTitleHtml converts inline markdown to inline HTML', () => {
  assert.equal(formatTitleHtml('**bold** title'), '<strong>bold</strong> title');
  assert.equal(formatTitleHtml('*em* title'), '<em>em</em> title');
  assert.equal(formatTitleHtml('[label](target.md) title'), 'label title');
  assert.equal(formatTitleHtml('Chat streaming (`mistral-chat`)'), 'Chat streaming (<code>mistral-chat</code>)');
});

test('formatTitleHtml HTML-escapes before converting markdown', () => {
  assert.equal(formatTitleHtml('a < b & "c"'), 'a &lt; b &amp; &quot;c&quot;');
  // A code span containing markup stays escaped inside the <code> element.
  assert.equal(formatTitleHtml('Use `<x>` here'), 'Use <code>&lt;x&gt;</code> here');
  // No constructs, no escapes needed: plain text passes through.
  assert.equal(formatTitleHtml('Plain title'), 'Plain title');
});

test('dropFirstH1 removes only the first level-1 heading line', () => {
  const body = '# First\n\nBody line.\n\n# Second\n\nTail.';
  assert.equal(dropFirstH1(body), '\nBody line.\n\n# Second\n\nTail.');
  // The remaining H1 survives as a heading line.
  assert.match(dropFirstH1(body), /^#\s/m);
});

test('dropFirstH1 leaves a body without a level-1 heading unchanged', () => {
  const body = '## Only an H2\n\nBody.';
  assert.equal(dropFirstH1(body), body);
});

test('dropFirstH1 never drops a level-1 heading inside a fenced code block', () => {
  const body = [
    '```markdown',
    '# not a heading',
    '```',
    '',
    '# Real heading',
    '',
    'Body.',
  ].join('\n');
  const result = dropFirstH1(body);
  assert.ok(result.includes('# not a heading'), 'fenced line is content and stays');
  assert.ok(!result.includes('# Real heading'), 'the real H1 outside the fence is dropped');
  // Everything except the dropped line is byte-identical.
  assert.equal(result, body.split('\n').toSpliced(4, 1).join('\n'));
});

test('dropFirstH1 keeps every other line byte-identical', () => {
  const body = '#  Title with odd spacing  \n\n\n- item\n| a | b |\n> quote';
  const result = dropFirstH1(body);
  assert.equal(result, '\n\n- item\n| a | b |\n> quote');
});

test('transformDocsFile drops the first H1 from the body but keeps it in the title', () => {
  const raw = '# Chat streaming (`mistral-chat`)\n\nSee [configuration.md](configuration.md) for details.';
  const result = transformDocsFile('docs/stream.md', raw);
  assert.ok(!result.body.includes('# Chat streaming'), 'no level-1 heading line remains in the body');
  assert.ok(!/^#[^#]/m.test(result.body), 'no level-1 heading line remains in the body');
  assert.equal(result.frontmatter.title, 'Chat streaming (mistral-chat)');
  assert.equal(result.frontmatter.titleHtml, 'Chat streaming (<code>mistral-chat</code>)');
  assert.equal(
    result.body,
    '\nSee [configuration.md](/configuration/) for details.',
    'links are still rewritten after the H1 drop',
  );
});
