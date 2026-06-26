import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { resolveDeckSlides } from './deck_manifest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

test('deck_index falls back to grid when gallery thumbnails are incomplete', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-index-'));
  const slidesDir = path.join(tmp, 'slides');
  fs.mkdirSync(slidesDir);
  for (let i = 1; i <= 12; i++) {
    write(path.join(slidesDir, `${String(i).padStart(2, '0')}.html`), '<!doctype html><body>slide</body>');
  }

  const manifest = Array.from({ length: 12 }, (_, i) => {
    const n = String(i + 1).padStart(2, '0');
    return `{ file: "slides/${n}.html", label: "Slide ${n}" }`;
  }).join(',\n    ');
  const html = read('assets/deck_index.html')
    .replace(/window\.DECK_MANIFEST = \[[\s\S]*?\];/, `window.DECK_MANIFEST = [\n    ${manifest}\n  ];`)
    .replace('// window.DECK_OVERVIEW = \'grid\';', 'window.DECK_OVERVIEW = \'gallery\';');
  write(path.join(tmp, 'index.html'), html);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto('file://' + path.join(tmp, 'index.html'));
  await page.waitForFunction(() => document.body.dataset.mode === 'overview');

  assert.equal(await page.locator('body').getAttribute('data-ov'), 'grid');
  assert.equal(await page.locator('#ov-gallery iframe').count(), 0);
  assert.equal(await page.locator('#ov-grid iframe').count(), 12);
  assert.equal(new URL(page.url()).hash, '');

  await page.click('#startBtn');
  await page.waitForFunction(() => document.body.dataset.mode === 'present' && location.hash === '#1');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.body.dataset.mode === 'overview' && location.hash === '');
  await browser.close();
});

test('resolveDeckSlides follows DECK_MANIFEST order instead of directory order', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-manifest-'));
  write(path.join(tmp, 'slides', '01.html'), '<!doctype html><body>one</body>');
  write(path.join(tmp, 'slides', '02.html'), '<!doctype html><body>two</body>');
  write(path.join(tmp, 'index.html'), `<!doctype html><script>
    window.DECK_MANIFEST = [
      { file: "slides/02.html", label: "Second" },
      { file: "slides/01.html", label: "First" },
    ];
  </script>`);

  const slides = await resolveDeckSlides(path.join(tmp, 'slides'));
  assert.deepEqual(slides.map(s => s.file), ['02.html', '01.html']);
});

test('video export chrome hiding avoids generic content class names', () => {
  for (const rel of ['scripts/render-video.js', 'scripts/render-video-seek.js']) {
    const source = read(rel);
    assert.doesNotMatch(source, /^\s*\.title\s*,/m, `${rel} must not hide .title`);
    assert.doesNotMatch(source, /^\s*\.kicker\s*,/m, `${rel} must not hide .kicker`);
    assert.doesNotMatch(source, /^\s*\.masthead\s*,/m, `${rel} must not hide .masthead`);
    assert.doesNotMatch(source, /^\s*\.footer\s*,/m, `${rel} must not hide .footer`);
  }
});

test('seek renderer requires safe handshake and exact frame coverage', () => {
  const source = read('scripts/render-video-seek.js');
  assert.match(source, /__seekRenderReady === true/);
  assert.match(source, /pngCount !== TOTAL_FRAMES/);
  assert.match(source, /missingFrames\.length/);
  assert.match(source, /'-start_number', '0'/);
  assert.match(source, /cleanupArtifacts\(\);/);
});

test('seek renderer rejects legacy __seek without frozen-clock handshake', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seek-legacy-'));
  const html = path.join(tmp, 'legacy.html');
  write(html, `<!doctype html>
    <body><script>
      window.__ready = true;
      window.__seek = function () {};
    </script></body>`);

  assert.throws(
    () => execFileSync(process.execPath, [
      path.join(ROOT, 'scripts/render-video-seek.js'),
      html,
      '--duration=1',
      '--fps=1',
      '--width=80',
      '--height=45',
      '--readytimeout=0.2',
      '--keep-chrome',
    ], {
      cwd: ROOT,
      env: { ...process.env, NODE_PATH: path.join(ROOT, 'node_modules') },
      stdio: 'pipe',
      timeout: 15000,
    }),
    /__seekRenderReady|Timeout/,
  );
  assert.equal(fs.existsSync(path.join(tmp, 'legacy.mp4')), false);
});

test('PPTX exporter defaults to fail-closed on partial conversion errors', () => {
  const source = read('scripts/export_deck_pptx.mjs');
  assert.match(source, /--allow-partial/);
  assert.match(source, /await fs\.rm\(outFile, \{ force: true \}\)/);
  assert.match(source, /process\.exit\(1\)/);
});

test('thumbnail generation exits non-zero on any failed slide', () => {
  const source = read('scripts/gen_deck_thumbs.mjs');
  assert.match(source, /let failed = 0/);
  assert.match(source, /if \(failed\) process\.exit\(1\)/);
});
