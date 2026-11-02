#!/usr/bin/env node
// Copies the repository assets/ into the site's public dir so that ingested
// docs (e.g. docs/design-tokens.md) can reference ../assets/… without the
// site duplicating the files in a source location. The synced output is
// tracked in the repository, so it must be refreshed (via this script on
// any build) whenever the source assets change; the sync runs on every
// dev/build/preview.
import { cpSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const source = join(root, 'assets');
const target = join(root, 'website', 'public', 'assets');

mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });
console.log('Synced assets/ into website/public/assets/');
