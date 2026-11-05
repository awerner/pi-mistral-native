import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFrontmatter,
  docsPathToFilePath,
  docsPathToSlug,
  docsPathToType,
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
  assert.equal(docsPathToSlug('docs/get-started/index.mdx'), 'get-started');
  assert.equal(docsPathToSlug('docs/how-to/use-a-region.mdx'), 'how-to/use-a-region');
  assert.equal(docsPathToSlug('docs/configuration.mdx'), 'configuration');
  assert.equal(docsPathToSlug('docs/reference/tools.mdx'), 'reference/tools');
  assert.equal(docsPathToSlug('docs/concepts/regions.mdx'), 'concepts/regions');
  assert.equal(docsPathToSlug('docs/contributing/internals.mdx'), 'contributing/internals');
  assert.equal(docsPathToSlug('docs/dev/adr/0002-mistral-native-provider-for-pi.md'), 'dev/adr/0002-mistral-native-provider-for-pi');
  assert.equal(docsPathToSlug('docs/dev/adr/README.md'), 'dev/adr');
  // The repo README maps to the landing page (site-authored, slug-less).
  assert.equal(docsPathToSlug('README.md'), '');
});

test('docsPathToSlug accepts .mdx section pages and .md ADR pages', () => {
  assert.equal(docsPathToSlug('docs/reference/config-files.mdx'), 'reference/config-files');
  assert.equal(docsPathToSlug('docs/dev/adr/0023-documentation-structured-by-diataxis.md'), 'dev/adr/0023-documentation-structured-by-diataxis');
  assert.throws(() => docsPathToSlug('docs/stream.txt'), /Not a docs page/);
});

test('docsPathToFilePath returns the site-root-relative on-disk path for deferred rendering', () => {
  assert.equal(docsPathToFilePath('docs/how-to/use-a-region.mdx'), '../docs/how-to/use-a-region.mdx');
  assert.equal(docsPathToFilePath('docs/dev/adr/0002-x.md'), '../docs/dev/adr/0002-x.md');
  assert.throws(() => docsPathToFilePath('README.md'), /Not a docs path/);
});

test('docsPathToType derives the Diátaxis type from the section folder', () => {
  assert.equal(docsPathToType('docs/get-started/index.mdx'), 'tutorial');
  assert.equal(docsPathToType('docs/how-to/use-a-region.mdx'), 'how-to');
  assert.equal(docsPathToType('docs/configuration.mdx'), 'reference');
  assert.equal(docsPathToType('docs/reference/tools.mdx'), 'reference');
  assert.equal(docsPathToType('docs/concepts/regions.mdx'), 'concept');
  assert.equal(docsPathToType('docs/contributing/internals.mdx'), 'reference');
  assert.equal(docsPathToType('docs/dev/adr/0023-x.md'), 'concept');
  // A page outside any section folder fails loudly — every page needs a type.
  assert.throws(() => docsPathToType('docs/stream.md'), /Cannot derive the Diátaxis page type/);
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
  assert.equal(isAdrPage('docs/dev/adr/0023-x.md'), true);
  assert.equal(isAdrPage('docs/reference/tools.mdx'), false);
  // Contributing docs under docs/contributing/ are not ADR pages.
  assert.equal(isAdrPage('docs/contributing/internals.mdx'), false);
});

test('buildFrontmatter injects title, description and the Diátaxis type', () => {
  const fm = buildFrontmatter(
    'docs/concepts/chat-streaming.mdx',
    '# How chat streaming works\n\nFirst paragraph of the doc.',
  );
  assert.equal(fm.title, 'How chat streaming works');
  assert.equal(fm.description, 'First paragraph of the doc.');
  assert.equal(fm.type, 'concept');
  assert.equal(fm.adrStatus, undefined);
});

test('buildFrontmatter strips inline markdown from the title and emits matching titleHtml', () => {
  const fm = buildFrontmatter('docs/concepts/chat-streaming.mdx', '# How chat streaming works (`mistral-chat`)\n\nBody.');
  assert.equal(fm.title, 'How chat streaming works (mistral-chat)');
  assert.equal(fm.titleHtml, 'How chat streaming works (<code>mistral-chat</code>)');
});

test('buildFrontmatter adds ADR status fields only for ADR pages', () => {
  const adrBody = '# 0002. Title\n\n- **Status**: Trial\n- **Date**: 2026-10-30\n\n## Context\n\nText.';
  const adrFm = buildFrontmatter('docs/dev/adr/0002-title.md', adrBody);
  assert.equal(adrFm.adrStatus, 'trial');
  assert.equal(adrFm.supersededBy, undefined);

  const nonAdrFm = buildFrontmatter('docs/concepts/regions.mdx', adrBody);
  assert.equal(nonAdrFm.adrStatus, undefined);
});

test('buildFrontmatter includes supersededBy for superseded ADRs', () => {
  const fm = buildFrontmatter('docs/dev/adr/0001-old.md', '# 0001. Old\n\n- **Status**: Superseded by 0009\n\nBody.');
  assert.equal(fm.adrStatus, 'superseded');
  assert.equal(fm.supersededBy, '0009');
});

test('rewriteLinks rewrites same-directory .mdx links', () => {
  const body = 'See [Tools](tools.mdx) for details.';
  assert.equal(
    rewriteLinks(body, 'docs/reference/commands.mdx'),
    'See [Tools](/reference/tools/) for details.',
  );
});

test('rewriteLinks rewrites links into the adr directories', () => {
  assert.equal(
    rewriteLinks('See [0003](0003-vendored-openapi-spec.md).', 'docs/dev/adr/0002-x.md'),
    'See [0003](/dev/adr/0003-vendored-openapi-spec/).',
  );
  assert.equal(
    rewriteLinks('See [ADR 0003](../dev/adr/0003-x.md).', 'docs/concepts/regions.mdx'),
    'See [ADR 0003](/dev/adr/0003-x/).',
  );
});

test('rewriteLinks resolves relative paths from docs/dev/adr', () => {
  assert.equal(
    rewriteLinks('Index: [0007](0007-adr-taxonomy.md).', 'docs/dev/adr/README.md'),
    'Index: [0007](/dev/adr/0007-adr-taxonomy/).',
  );
  assert.equal(
    rewriteLinks('Up: [docs index](../../../README.md).', 'docs/dev/adr/README.md'),
    'Up: [docs index](/).',
  );
});

test('rewriteLinks resolves the README Quickstart link to the landing page', () => {
  assert.equal(
    rewriteLinks('[README](../README.md#quickstart).', 'docs/concepts/regions.mdx'),
    '[README](/#quickstart).',
  );
});

test('rewriteLinks preserves anchors', () => {
  assert.equal(
    rewriteLinks('[rates](rate-card.mdx#catch-all).', 'docs/reference/tools.mdx'),
    '[rates](/reference/rate-card/#catch-all).',
  );
});

test('rewriteLinks keeps links to repo-root assets that the site ships', () => {
  const body = 'Banner: [svg](../../assets/banner.svg) and [html](../../assets/banner-source.html).';
  // ../../assets/… from docs/contributing/design-tokens.mdx escapes docs/ but
  // resolves to the repository assets synced onto the site root, so it keeps
  // its link form.
  assert.equal(rewriteLinks(body, 'docs/contributing/design-tokens.mdx'), body);
  const inside = 'See [the schema](config/mistral-native.json).';
  assert.equal(rewriteLinks(inside, 'docs/reference/tools.mdx'), inside);
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
    rewriteLinks('[ci](../../.github/workflows/ci.yml)', 'docs/contributing/development.md'),
    'ci',
  );
  assert.equal(
    rewriteLinks('[config](../../website/astro.config.mjs)', 'docs/contributing/development.md'),
    'config',
  );
  assert.equal(
    rewriteLinks('[badge](../../../workflow/badge.svg)', 'docs/dev/adr/0002-x.md'),
    'badge',
  );
});

test('rewriteLinks leaves absolute URLs and site-absolute links untouched', () => {
  const body = 'See [pi](https://pi.dev) and [root](/reference/tools/).';
  assert.equal(rewriteLinks(body, 'docs/concepts/regions.mdx'), body);
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
  const result = rewriteLinks(body, 'docs/dev/adr/0005-x.md');
  assert.ok(result.includes('](../0004-api-key-credential-chain-without-mistral-oauth.md)'),
    'fenced link must keep its literal .md target');
  assert.ok(!result.includes('](/dev/adr/0004-'), 'fenced link must not become a site route');
  assert.ok(result.includes('](/dev/adr/0005-documentation-structure-and-adr-citation/)'),
    'link before the fence is rewritten');
  assert.ok(result.includes('](/dev/adr/0008-reference-discipline/)'),
    'link after the fence is rewritten');
});

test('rewriteLinks keeps non-.md text replacement out of fenced code blocks', () => {
  const body = '```text\nsee [spec](../../../vendor/mistral-openapi.yaml)\n```';
  assert.equal(rewriteLinks(body, 'docs/dev/adr/0014-x.md'), body);
});

test('rewriteLinks does not toggle fences on backticks inside code spans', () => {
  const body = 'Use ``` `markdown` ``` fences: [rate card](rate-card.mdx).';
  const result = rewriteLinks(body, 'docs/reference/tools.mdx');
  assert.ok(result.includes('](/reference/rate-card/)'),
    'a fence-looking code span must not suppress rewriting');
});

test('transformDocsFile combines frontmatter injection and link rewriting', () => {
  const raw = '# 0007. Taxonomy\n\n- **Status**: Trial\n\nSee [0008](0008-reference-discipline.md).';
  const result = transformDocsFile('docs/dev/adr/0007-adr-taxonomy.md', raw);
  assert.equal(result.frontmatter.title, '0007. Taxonomy');
  assert.equal(result.frontmatter.adrStatus, 'trial');
  assert.ok(result.body.includes('](/dev/adr/0008-reference-discipline/)'));
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
  // Doc-page .mdx link (docs/reference/commands.mdx -> tools.mdx).
  assert.equal(
    rewriteLinks('See [Tools](tools.mdx).', 'docs/reference/commands.mdx', '/pi-mistral-native/'),
    'See [Tools](/pi-mistral-native/reference/tools/).',
  );
  // ADR-relative link (docs/dev/adr/0002-x.md -> 0003-....md).
  assert.equal(
    rewriteLinks('See [0003](0003-vendored-openapi-spec.md).', 'docs/dev/adr/0002-x.md', '/pi-mistral-native/'),
    'See [0003](/pi-mistral-native/dev/adr/0003-vendored-openapi-spec/).',
  );
  // Landing-page Quickstart link from a docs page.
  assert.equal(
    rewriteLinks('[README](../README.md#quickstart).', 'docs/concepts/regions.mdx', '/pi-mistral-native/'),
    '[README](/pi-mistral-native/#quickstart).',
  );
  // Anchors are preserved under the base.
  assert.equal(
    rewriteLinks('[rates](rate-card.mdx#catch-all).', 'docs/reference/tools.mdx', '/pi-mistral-native/'),
    '[rates](/pi-mistral-native/reference/rate-card/#catch-all).',
  );
});

test('rewriteLinks leaves site-absolute links and absolute URLs alone even with a base', () => {
  // Authors write site-absolute links deliberately; the base must not be
  // double-prefixed, and stripping/removal behavior is base-independent.
  const body = 'See [pi](https://pi.dev) and [root](/reference/tools/).';
  assert.equal(rewriteLinks(body, 'docs/concepts/regions.mdx', '/pi-mistral-native/'), body);
  assert.equal(
    rewriteLinks('[ci](../../.github/workflows/ci.yml)', 'docs/contributing/development.md', '/pi-mistral-native/'),
    'ci',
  );
});

test('rewriteLinks keeps fenced-code links literal with a base set', () => {
  const body = '```markdown\n[ADR 0004](../0004-x.md)\n```\n\nReal [0008](0008-x.md).';
  const result = rewriteLinks(body, 'docs/dev/adr/0007-x.md', '/pi-mistral-native/');
  assert.ok(result.includes('](../0004-x.md)'), 'fenced link keeps its literal .md target');
  assert.ok(result.includes('](/pi-mistral-native/dev/adr/0008-x/)'),
    'link outside the fence is base-aware rewritten');
});

test('transformDocsFile flows the base through to the link rewriter', () => {
  const raw = '# 0007. Taxonomy\n\n- **Status**: Trial\n\nSee [0008](0008-reference-discipline.md).';
  const result = transformDocsFile('docs/dev/adr/0007-adr-taxonomy.md', raw, '/pi-mistral-native/');
  assert.equal(result.frontmatter.adrStatus, 'trial');
  assert.ok(result.body.includes('](/pi-mistral-native/dev/adr/0008-reference-discipline/)'));
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
  const raw = '# How chat streaming works (`mistral-chat`)\n\nSee [Tools](../reference/tools.mdx) for details.';
  const result = transformDocsFile('docs/concepts/chat-streaming.mdx', raw);
  assert.ok(!result.body.includes('# Chat streaming'), 'no level-1 heading line remains in the body');
  assert.ok(!/^#[^#]/m.test(result.body), 'no level-1 heading line remains in the body');
  assert.equal(result.frontmatter.title, 'How chat streaming works (mistral-chat)');
  assert.equal(result.frontmatter.titleHtml, 'How chat streaming works (<code>mistral-chat</code>)');
  assert.equal(
    result.body,
    '\nSee [Tools](/reference/tools/) for details.',
    'links are still rewritten after the H1 drop',
  );
});
