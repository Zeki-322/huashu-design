import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE_PATH = execFileSync('npm', ['root'], { cwd: ROOT, encoding: 'utf8' }).trim();

function tmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `huashu-${name}-`));
}

function runNode(args, options = {}) {
  return spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH, ...(options.env || {}) },
    ...options,
  });
}

function deckHtmlWithManifest(manifest) {
  const html = fs.readFileSync(path.join(ROOT, 'assets/deck_index.html'), 'utf8');
  return html.replace(
    /window\.DECK_MANIFEST = \[[\s\S]*?\];/,
    `window.DECK_MANIFEST = ${JSON.stringify(manifest, null, 2)};`,
  );
}

test('deck gallery fails closed to grid when thumbnails are missing', async () => {
  const dir = tmpDir('deck-gallery');
  const slidesDir = path.join(dir, 'slides');
  fs.mkdirSync(slidesDir);
  fs.writeFileSync(path.join(slidesDir, '01.html'), '<!doctype html><html><body>one</body></html>');
  fs.writeFileSync(path.join(slidesDir, '02.html'), '<!doctype html><html><body>two</body></html>');
  fs.writeFileSync(path.join(dir, 'index.html'), deckHtmlWithManifest([
    { file: 'slides/01.html', label: 'One' },
    { file: 'slides/02.html', label: 'Two' },
  ]));

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto(`file://${path.join(dir, 'index.html')}?ov=gallery`);
    await page.waitForFunction(() => document.body.dataset.mode === 'overview' && document.body.dataset.ov === 'grid');

    const overview = await page.evaluate(() => ({
      mode: document.body.dataset.mode,
      ov: document.body.dataset.ov,
      hash: location.hash,
      frameSrc: document.getElementById('frame').getAttribute('src'),
      gridCards: document.querySelectorAll('#wall .card').length,
      galleryCards: document.querySelectorAll('#gallery .card').length,
      galleryIframes: document.querySelectorAll('#gallery iframe').length,
    }));
    assert.deepEqual(overview, {
      mode: 'overview',
      ov: 'grid',
      hash: '',
      frameSrc: 'about:blank',
      gridCards: 2,
      galleryCards: 0,
      galleryIframes: 0,
    });

    await page.evaluate(() => document.querySelector('#wall .card').click());
    await page.waitForFunction(() => document.body.dataset.mode === 'present');
    const present = await page.evaluate(() => ({
      hash: location.hash,
      gridCards: document.querySelectorAll('#wall .card').length,
      galleryCards: document.querySelectorAll('#gallery .card').length,
    }));
    assert.deepEqual(present, { hash: '#1', gridCards: 0, galleryCards: 0 });
  } finally {
    await browser.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deck ignores invalid hash instead of entering present mode', async () => {
  const dir = tmpDir('deck-hash');
  const slidesDir = path.join(dir, 'slides');
  fs.mkdirSync(slidesDir);
  fs.writeFileSync(path.join(slidesDir, '01.html'), '<!doctype html><html><body>one</body></html>');
  fs.writeFileSync(path.join(dir, 'index.html'), deckHtmlWithManifest([
    { file: 'slides/01.html', label: 'One' },
  ]));

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto(`file://${path.join(dir, 'index.html')}#99`);
    await page.waitForFunction(() => document.body.dataset.mode === 'overview');
    const state = await page.evaluate(() => ({
      mode: document.body.dataset.mode,
      hash: location.hash,
      frameSrc: document.getElementById('frame').getAttribute('src'),
    }));
    assert.deepEqual(state, { mode: 'overview', hash: '#99', frameSrc: 'about:blank' });
  } finally {
    await browser.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('thumbnail generation removes stale output and fails on invalid parameters', () => {
  const dir = tmpDir('thumbs');
  const slidesDir = path.join(dir, 'slides');
  const outDir = path.join(dir, 'thumbs');
  fs.mkdirSync(slidesDir);
  fs.mkdirSync(outDir);
  fs.writeFileSync(path.join(slidesDir, '01.html'), '<!doctype html><html><body>one</body></html>');
  const stale = path.join(outDir, '01.jpg');
  fs.writeFileSync(stale, 'stale');

  const result = runNode([
    path.join(ROOT, 'scripts/gen_deck_thumbs.mjs'),
    '--slides', slidesDir,
    '--out', outDir,
    '--width', '0',
  ]);
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(stale), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('PPTX export removes stale output on conversion failures unless partial export is explicit', () => {
  const dir = tmpDir('pptx');
  const slidesDir = path.join(dir, 'slides');
  fs.mkdirSync(slidesDir);
  fs.writeFileSync(
    path.join(slidesDir, '01-bad.html'),
    '<!doctype html><html><body style="width:400px;height:400px"><p style="font-size:80px">bad</p></body></html>',
  );
  const out = path.join(dir, 'deck.pptx');
  fs.writeFileSync(out, 'stale');

  const result = runNode([
    path.join(ROOT, 'scripts/export_deck_pptx.mjs'),
    '--slides', slidesDir,
    '--out', out,
  ]);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.existsSync(out), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('seek renderer requires frozen-clock readiness and removes stale mp4', () => {
  const dir = tmpDir('seek');
  const html = path.join(dir, 'bad.html');
  const staleMp4 = path.join(dir, 'bad.mp4');
  fs.writeFileSync(html, `<!doctype html><html><body><script>
    window.__ready = true;
    window.__seek = function () {};
  </script></body></html>`);
  fs.writeFileSync(staleMp4, 'stale');

  const result = runNode([
    path.join(ROOT, 'scripts/render-video-seek.js'),
    html,
    '--duration=0.01',
    '--fps=1',
    '--readytimeout=0.2',
    '--concurrency=1',
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /__seek|__ready|__seekRenderReady/);
  assert.equal(fs.existsSync(staleMp4), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('recording chrome hiding does not target generic content classes', () => {
  for (const script of ['render-video.js', 'render-video-seek.js']) {
    const source = fs.readFileSync(path.join(ROOT, 'scripts', script), 'utf8');
    for (const selector of ['.masthead', '.kicker', '.title', '.footer']) {
      assert.equal(source.includes(selector), false, `${script} must not hide ${selector}`);
    }
  }
});

test('voiceover ducking keeps voice audible beyond the first half second', () => {
  const source = fs.readFileSync(path.join(ROOT, 'scripts/mix-voiceover.sh'), 'utf8');
  assert.match(source, /asplit=2\[voice_mix\]\[voice_sc\]/);
  assert.equal(source.includes('afade=t=out:st=0'), false);
  assert.match(source, /atrim=0:\$\{VIDEO_DURATION\}/);
});

test('image fetcher de-duplicates truncated output names', () => {
  const source = fs.readFileSync(path.join(ROOT, 'scripts/fetch_images.py'), 'utf8');
  assert.match(source, /def _unique_path/);
  assert.match(source, /while candidate in used or os\.path\.exists\(candidate\):/);
});
