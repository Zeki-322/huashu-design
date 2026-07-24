import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const deckIndexPath = path.join(repoRoot, 'assets', 'deck_index.html');
const genThumbsPath = path.join(repoRoot, 'scripts', 'gen_deck_thumbs.mjs');

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'huashu-critical-'));
}

async function writeDeckFixture(items) {
  const dir = await makeTempDir();
  const slidesDir = path.join(dir, 'slides');
  await fs.mkdir(slidesDir, { recursive: true });
  for (const item of items) {
    const slidePath = path.join(dir, item.file);
    await fs.mkdir(path.dirname(slidePath), { recursive: true });
    await fs.writeFile(slidePath, '<!doctype html><meta charset="utf-8"><title>slide</title><body>slide</body>');
  }

  const source = await fs.readFile(deckIndexPath, 'utf8');
  const html = source.replace(
    /window\.DECK_MANIFEST = \[[\s\S]*?\];/,
    `window.DECK_MANIFEST = ${JSON.stringify(items, null, 2)};`,
  );
  const indexPath = path.join(dir, 'index.html');
  await fs.writeFile(indexPath, html);
  return { dir, indexPath };
}

async function withBrowser(fn) {
  const browser = await chromium.launch();
  try {
    await fn(browser);
  } finally {
    await browser.close();
  }
}

function runNode(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('deck_index forced gallery without complete thumbs falls back to grid without gallery iframes', async () => {
  const items = Array.from({ length: 18 }, (_, i) => ({
    file: `slides/${String(i + 1).padStart(2, '0')}.html`,
    label: `Slide ${i + 1}`,
  }));
  const { indexPath } = await writeDeckFixture(items);

  await withBrowser(async browser => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto(`${pathToFileURL(indexPath).href}?ov=gallery`, { waitUntil: 'load' });
    await page.waitForFunction(
      expected => document.body.dataset.mode === 'overview'
        && document.body.dataset.ov === 'grid'
        && document.querySelectorAll('#wall .card').length === expected,
      items.length,
    );
    const state = await page.evaluate(() => ({
      mode: document.body.dataset.mode,
      ov: document.body.dataset.ov,
      wallCards: document.querySelectorAll('#wall .card').length,
      galleryCards: document.querySelectorAll('#gallery .card').length,
      galleryIframes: document.querySelectorAll('#ov-gallery iframe').length,
      hash: location.hash,
    }));

    assert.deepEqual(state, {
      mode: 'overview',
      ov: 'grid',
      wallCards: items.length,
      galleryCards: 0,
      galleryIframes: 0,
      hash: '',
    });
  });
});

test('deck_index clears overview DOM when entering present mode', async () => {
  const items = Array.from({ length: 8 }, (_, i) => ({
    file: `slides/${String(i + 1).padStart(2, '0')}.html`,
    label: `Slide ${i + 1}`,
  }));
  const { indexPath } = await writeDeckFixture(items);

  await withBrowser(async browser => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto(`${pathToFileURL(indexPath).href}?ov=grid`, { waitUntil: 'load' });
    await page.waitForFunction(
      expected => document.querySelectorAll('#wall .card').length === expected,
      items.length,
    );
    await page.click('#startBtn');
    await page.waitForFunction(() => document.body.dataset.mode === 'present' && location.hash === '#1');
    const state = await page.evaluate(() => ({
      mode: document.body.dataset.mode,
      wallCards: document.querySelectorAll('#wall .card').length,
      galleryCards: document.querySelectorAll('#gallery .card').length,
      galleryIframes: document.querySelectorAll('#ov-gallery iframe').length,
      frameSrc: document.getElementById('frame').getAttribute('src'),
    }));

    assert.deepEqual(state, {
      mode: 'present',
      wallCards: 0,
      galleryCards: 0,
      galleryIframes: 0,
      frameSrc: items[0].file,
    });
  });
});

test('gen_deck_thumbs exits nonzero and removes stale output when a slide fails', async () => {
  const dir = await makeTempDir();
  const slidesDir = path.join(dir, 'slides');
  const thumbsDir = path.join(dir, 'thumbs');
  await fs.mkdir(slidesDir, { recursive: true });
  await fs.mkdir(thumbsDir, { recursive: true });
  await fs.writeFile(path.join(slidesDir, '01-bad.html'), '<!doctype html><title>bad</title>');
  const staleThumb = path.join(thumbsDir, '01-bad.jpg');
  await fs.writeFile(staleThumb, 'stale');

  const result = await runNode([
    genThumbsPath,
    '--slides', slidesDir,
    '--out', thumbsDir,
    '--width', '0',
  ]);

  assert.notEqual(result.code, 0, `expected failure, got stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  await assert.rejects(fs.stat(staleThumb), { code: 'ENOENT' });
  assert.match(result.stderr, /缩略图生成失败/);
});
