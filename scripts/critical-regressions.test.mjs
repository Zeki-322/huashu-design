import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, stat, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nodeBin = process.execPath;

async function makeTempDir(prefix) {
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function assertMissing(file) {
  await assert.rejects(() => stat(file), { code: 'ENOENT' });
}

function runNode(args, options = {}) {
  return spawnSync(nodeBin, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: path.join(repoRoot, 'node_modules') },
    ...options,
  });
}

function hideChromeCss(source) {
  const match = source.match(/const HIDE_CHROME_CSS = `([\s\S]*?)`;/);
  assert.ok(match, 'HIDE_CHROME_CSS block should exist');
  return match[1];
}

test('deck_index falls back to grid when gallery is forced without complete thumbnails', async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(pathToFileURL(path.join(repoRoot, 'assets/deck_index.html')).href + '?ov=gallery');
    await page.waitForFunction(() => document.body.dataset.mode === 'overview');
    await page.waitForTimeout(100);

    const state = await page.evaluate(() => ({
      overview: document.body.dataset.ov,
      galleryCards: document.querySelectorAll('#gallery .card').length,
      galleryIframes: document.querySelectorAll('#ov-gallery iframe').length,
      gridIframes: document.querySelectorAll('#ov-grid iframe').length,
    }));

    assert.equal(state.overview, 'grid');
    assert.equal(state.galleryCards, 0);
    assert.equal(state.galleryIframes, 0);
    assert.equal(state.gridIframes, 1);
  } finally {
    await browser.close();
  }
});

test('deck_index tears down overview iframes when entering present mode', async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(pathToFileURL(path.join(repoRoot, 'assets/deck_index.html')).href + '?ov=grid');
    await page.waitForFunction(() => document.querySelectorAll('#ov-grid iframe').length > 0);
    await page.click('#startBtn');
    await page.waitForFunction(() => document.body.dataset.mode === 'present');

    const state = await page.evaluate(() => ({
      wallChildren: document.querySelector('#wall').children.length,
      galleryChildren: document.querySelector('#gallery').children.length,
      presentSrc: document.querySelector('#frame').getAttribute('src'),
    }));

    assert.equal(state.wallChildren, 0);
    assert.equal(state.galleryChildren, 0);
    assert.equal(state.presentSrc, 'slides/01-cover.html');
  } finally {
    await browser.close();
  }
});

test('thumbnail generation exits non-zero and removes stale thumb on per-slide failure', async () => {
  const dir = await makeTempDir('huashu-thumbs-');
  try {
    const slidesDir = path.join(dir, 'slides');
    const outDir = path.join(dir, 'thumbs');
    await mkdir(slidesDir);
    await writeFile(path.join(slidesDir, 'bad.html'), '<!doctype html><html><body>bad thumb</body></html>');
    await mkdir(outDir);
    const staleThumb = path.join(outDir, 'bad.jpg');
    await writeFile(staleThumb, 'stale');

    const result = runNode([
      'scripts/gen_deck_thumbs.mjs',
      '--slides', slidesDir,
      '--out', outDir,
      '--width', '-1',
    ]);

    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    await assertMissing(staleThumb);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('PPTX export fails closed and removes stale output unless partial export is explicit', async () => {
  const dir = await makeTempDir('huashu-pptx-');
  try {
    const slidesDir = path.join(dir, 'slides');
    await mkdir(slidesDir);
    await writeFile(path.join(slidesDir, '01-invalid.html'), `<!doctype html>
<html><head><style>body{width:960px;height:540px;margin:0}.box{position:absolute;left:0;top:0}</style></head>
<body><div class="box">unwrapped text fails html2pptx validation</div></body></html>`);
    const outFile = path.join(dir, 'stale.pptx');
    await writeFile(outFile, 'stale');

    const result = runNode([
      'scripts/export_deck_pptx.mjs',
      '--slides', slidesDir,
      '--out', outFile,
    ]);

    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    await assertMissing(outFile);
    assert.equal(existsSync(outFile.replace(/\.pptx$/i, '') + `.tmp-${result.pid}.pptx`), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('video chrome hiding does not remove generic content class names', async () => {
  for (const rel of ['scripts/render-video.js', 'scripts/render-video-seek.js']) {
    const source = await readFile(path.join(repoRoot, rel), 'utf8');
    const css = hideChromeCss(source);
    for (const selector of ['.title', '.kicker', '.masthead', '.footer']) {
      assert.equal(css.includes(selector), false, `${rel} should not hide ${selector}`);
    }
  }
});

test('seek renderer fails closed on unsafe handshakes and incomplete frame capture', async () => {
  const source = await readFile(path.join(repoRoot, 'scripts/render-video-seek.js'), 'utf8');

  assert.match(source, /window\.__seekRenderReady === true/);
  assert.match(source, /page\.waitForFunction\([\s\S]*null,\s*\{\s*timeout: READY_TIMEOUT \* 1000\s*\}/);
  assert.match(source, /Math\.max\(1, Math\.ceil\(FPS \* DURATION\)\)/);
  assert.match(source, /pngCount !== TOTAL_FRAMES/);
  assert.match(source, /'-start_number', '0'/);
  assert.match(source, /fs\.rmSync\(MP4_OUT, \{ force: true \}\)/);

  const stageSource = await readFile(path.join(repoRoot, 'assets/animations.jsx'), 'utf8');
  const narrationSource = await readFile(path.join(repoRoot, 'assets/narration_stage.jsx'), 'utf8');
  assert.match(stageSource, /window\.__seekRenderReady = true/);
  assert.match(narrationSource, /window\.__seekRenderReady = true/);
});
