// Sidebar-config check: dynamic-imports astro.config.mjs — the same module
// Astro loads — so the ADR loud-fail guard runs transitively at import (the
// config builds its sidebar through sidebarConfig()/adrEntries() at module
// top level, and a series with no ADR files fails the build here loudly).
// The sidebar itself is exported as a named extra (Astro reads only the
// default export from a config module), so the test asserts on the exact
// shape the Starlight integration receives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import config, { sidebarConfig } from '../astro.config.mjs';

test('astro.config.mjs registers Starlight and defines the sidebar', () => {
  assert.ok(config.integrations.some((i) => i.name === '@astrojs/starlight'));
});

test('the top-level sidebar is exactly the five Diátaxis groups', () => {
  const sidebar = sidebarConfig();
  assert.ok(Array.isArray(sidebar));
  assert.deepEqual(
    sidebar.map((group) => group.label),
    ['Get started', 'How-to guides', 'Reference', 'Concepts', 'Contributing'],
  );
  // All top-level entries are groups, not links.
  for (const group of sidebar) {
    assert.ok(Array.isArray(group.items), `group ${group.label} has items`);
  }
});

test('Get started carries Welcome and Your first Mistral session', () => {
  const group = sidebarConfig().find((g) => g.label === 'Get started');
  assert.ok(group, 'Get started group exists');
  assert.deepEqual(group.items, [
    { slug: 'get-started', label: 'Welcome' },
    { slug: 'get-started/first-session' },
  ]);
});

test('How-to guides carries the thirteen task pages', () => {
  const group = sidebarConfig().find((g) => g.label === 'How-to guides');
  assert.ok(group, 'How-to guides group exists');
  const slugs = group.items.map((i) => i.slug);
  assert.deepEqual(slugs, [
    'how-to/set-up-api-key',
    'how-to/change-a-setting',
    'how-to/use-a-region',
    'how-to/override-for-one-project',
    'how-to/keep-secrets-out-of-the-config-file',
    'how-to/route-through-a-gateway',
    'how-to/use-a-mistral-agent',
    'how-to/set-your-own-prices',
    'how-to/enable-connectors',
    'how-to/query-your-documents',
    'how-to/search-the-web',
    'how-to/run-code-with-the-code-interpreter',
    'how-to/fix-a-configuration-error',
  ]);
});

test('Reference carries Configuration keys at its head', () => {
  const group = sidebarConfig().find((g) => g.label === 'Reference');
  assert.ok(group, 'Reference group exists');
  const slugs = group.items.map((i) => i.slug);
  assert.deepEqual(slugs, [
    'configuration',
    'reference/config-files',
    'reference/environment-variables',
    'reference/commands',
    'reference/tools',
    'reference/region-routing',
    'reference/credential-chain',
    'reference/rate-card',
    'reference/max-output-mapping',
    'reference/config-error-messages',
  ]);
  // The URL exception: Configuration keys is labeled, the rest derive from
  // their page titles.
  assert.deepEqual(group.items[0], { slug: 'configuration', label: 'Configuration keys' });
});

test('Concepts carries the five explanation pages', () => {
  const group = sidebarConfig().find((g) => g.label === 'Concepts');
  assert.ok(group, 'Concepts group exists');
  assert.deepEqual(group.items.map((i) => i.slug), [
    'concepts/config-layers',
    'concepts/regions',
    'concepts/tools',
    'concepts/models-and-costs',
    'concepts/chat-streaming',
  ]);
});

test('Contributing carries the dev docs, Internals and the ADR subgroup', () => {
  const group = sidebarConfig().find((g) => g.label === 'Contributing');
  assert.ok(group, 'Contributing group exists');
  const slugs = group.items.filter((i) => i.slug).map((i) => i.slug);
  for (const slug of [
    'contributing/development',
    'contributing/testing',
    'contributing/publishing',
    'contributing/hosting',
    'contributing/design-tokens',
    'contributing/internals',
  ]) {
    assert.ok(slugs.includes(slug), `Contributing links ${slug}`);
  }
});

test('Contributing nests an Architecture ADRs subgroup with ADR entries', () => {
  const group = sidebarConfig().find((g) => g.label === 'Contributing');
  const subgroups = group.items.filter((i) => Array.isArray(i.items));
  assert.equal(subgroups.length, 1, 'exactly one subgroup inside Contributing');
  const adrGroup = subgroups[0];
  assert.equal(adrGroup.label, 'Architecture ADRs');
  assert.ok(adrGroup.items.length > 1, 'the ADR subgroup is non-empty beyond the Index');
  assert.deepEqual(
    adrGroup.items[0],
    { slug: 'dev/adr', label: 'Index' },
    'the first ADR subgroup item is the Index entry',
  );
  // The entries following the Index are numbered ADR pages (never a
  // hard-coded count — the directory is the source of truth).
  const adrEntries = adrGroup.items.slice(1);
  assert.ok(adrEntries.length > 0, 'ADR entries follow the Index');
  for (const item of adrEntries) {
    assert.match(item.slug, /^dev\/adr\//, 'ADR entry slugs sit under dev/adr/');
    assert.equal(item.label, undefined, 'ADR entry labels derive from page titles');
  }
});
