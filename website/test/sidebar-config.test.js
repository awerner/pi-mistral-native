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

test('the top-level sidebar is exactly Getting started, Features, Developer', () => {
  const sidebar = sidebarConfig();
  assert.ok(Array.isArray(sidebar));
  assert.deepEqual(
    sidebar.map((group) => group.label),
    ['Getting started', 'Features', 'Developer'],
  );
  // All top-level entries are groups, not links.
  for (const group of sidebar) {
    assert.ok(Array.isArray(group.items), `group ${group.label} has items`);
  }
});

test('the Developer group carries the dev docs and design-tokens', () => {
  const developer = sidebarConfig().find((g) => g.label === 'Developer');
  assert.ok(developer, 'Developer group exists');
  const slugs = developer.items.filter((i) => i.slug).map((i) => i.slug);
  for (const slug of ['development', 'testing', 'publishing', 'hosting', 'design-tokens']) {
    assert.ok(slugs.includes(slug), `Developer links ${slug}`);
  }
});

test('the Developer group nests an Architecture ADRs subgroup with ADR entries', () => {
  const developer = sidebarConfig().find((g) => g.label === 'Developer');
  const subgroups = developer.items.filter((i) => Array.isArray(i.items));
  assert.equal(subgroups.length, 1, 'exactly one subgroup inside Developer');
  const adrGroup = subgroups[0];
  assert.equal(adrGroup.label, 'Architecture ADRs');
  assert.ok(adrGroup.items.length > 1, 'the ADR subgroup is non-empty beyond the Index');
  assert.deepEqual(
    adrGroup.items[0],
    { slug: 'adr', label: 'Index' },
    'the first ADR subgroup item is the Index entry',
  );
  // The entries following the Index are numbered ADR pages (never a
  // hard-coded count — the directory is the source of truth).
  const adrEntries = adrGroup.items.slice(1);
  assert.ok(adrEntries.length > 0, 'ADR entries follow the Index');
  for (const item of adrEntries) {
    assert.match(item.slug, /^adr\//, 'ADR entry slugs sit under adr/');
    assert.equal(item.label, undefined, 'ADR entry labels derive from page titles');
  }
});
