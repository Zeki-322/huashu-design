import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const require = createRequire(import.meta.url);

test('deck overview falls back to grid when gallery thumbs are incomplete', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const url = pathToFileURL(path.join(root, 'assets/deck_index.html')).href + '?ov=gallery';
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => document.body.dataset.mode === 'overview');
    const state = await page.evaluate(() => ({
      ov: document.body.dataset.ov,
      hash: location.hash,
      galleryCards: document.querySelectorAll('#ov-gallery .card').length,
      galleryIframes: document.querySelectorAll('#ov-gallery iframe').length,
    }));
    assert.deepEqual(state, {
      ov: 'grid',
      hash: '',
      galleryCards: 0,
      galleryIframes: 0,
    });
  } finally {
    await browser.close();
  }
});

test('thumbnail generator rejects invalid output dimensions before writing stale files', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-thumbs-'));
  try {
    const slides = path.join(tmp, 'slides');
    const out = path.join(tmp, 'thumbs');
    fs.mkdirSync(slides);
    fs.writeFileSync(path.join(slides, '01.html'), '<!doctype html><title>slide</title>');
    const result = spawnSync(process.execPath, [
      path.join(root, 'scripts/gen_deck_thumbs.mjs'),
      '--slides', slides,
      '--out', out,
      '--width', '0',
    ], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /参数无效/);
    assert.equal(fs.existsSync(path.join(out, '01.jpg')), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('renderers do not hide generic content class names', () => {
  for (const file of ['scripts/render-video.js', 'scripts/render-video-seek.js']) {
    const src = read(file);
    assert.equal(src.includes('.masthead, .kicker, .title'), false, file);
    assert.equal(src.includes('.footer,'), false, file);
  }
});

test('seek renderer fails closed unless frozen-clock handshake and exact frames are present', () => {
  const src = read('scripts/render-video-seek.js');
  assert.match(src, /window\.__seekRenderReady === true/);
  assert.match(src, /Math\.max\(1, Math\.ceil\(FPS \* DURATION\)\)/);
  assert.match(src, /pngCount !== TOTAL_FRAMES/);
  assert.match(src, /'-start_number', '0'/);
  assert.match(src, /fs\.rmSync\(MP4_OUT, \{ force: true \}\)/);
});

test('PPTX export fails closed on partial slide conversion unless explicitly allowed', () => {
  const src = read('scripts/export_deck_pptx.mjs');
  assert.match(src, /allow-partial/);
  assert.match(src, /默认不生成缺页 PPTX/);
  assert.match(src, /await fs\.rm\(outFile, \{ force: true \}\)/);
});

test('html2pptx rejects high-risk image formats before pptxgenjs parses them', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'html2pptx-image-'));
  try {
    const slidePath = path.join(tmp, 'slide.html');
    fs.writeFileSync(slidePath, `<!doctype html>
      <html><body style="width:1280px;height:720px;margin:0">
        <img src="payload.jxl" style="position:absolute;left:10px;top:10px;width:100px;height:80px">
      </body></html>`);

    const pptxgen = require('pptxgenjs');
    const html2pptx = require(path.join(root, 'scripts/html2pptx.js'));
    const pres = new pptxgen();
    pres.layout = 'LAYOUT_WIDE';
    await assert.rejects(
      () => html2pptx(slidePath, pres),
      /unsupported image format "\.jxl"/,
    );

    fs.writeFileSync(path.join(tmp, 'payload.png'), Buffer.from('00000018667479706865696300000000', 'hex'));
    fs.writeFileSync(slidePath, `<!doctype html>
      <html><body style="width:1280px;height:720px;margin:0">
        <img src="payload.png" style="position:absolute;left:10px;top:10px;width:100px;height:80px">
      </body></html>`);
    const presWithSpoofedImage = new pptxgen();
    presWithSpoofedImage.layout = 'LAYOUT_WIDE';
    await assert.rejects(
      () => html2pptx(slidePath, presWithSpoofedImage),
      /image bytes do not match "\.png"/,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('voiceover and narration wrappers keep successful exports audible and successful', () => {
  const mix = read('scripts/mix-voiceover.sh');
  assert.match(mix, /asplit=2\[voice_sc\]\[voice_mix\]/);
  assert.equal(mix.includes('afade=t=out:st=0'), false);

  const narration = read('scripts/render-narration.sh');
  assert.match(narration, /npm root\)/);
  assert.match(narration, /if \[ -n "\$KEEP_SILENT" \]; then/);
});

test('modified scripts pass syntax checks', () => {
  for (const file of [
    'scripts/gen_deck_thumbs.mjs',
    'scripts/export_deck_pptx.mjs',
  ]) {
    execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'pipe' });
  }
  for (const file of [
    'scripts/html2pptx.js',
    'scripts/render-video.js',
    'scripts/render-video-seek.js',
  ]) {
    execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'pipe' });
  }
  execFileSync('bash', ['-n', path.join(root, 'scripts/mix-voiceover.sh')], { stdio: 'pipe' });
  execFileSync('bash', ['-n', path.join(root, 'scripts/render-narration.sh')], { stdio: 'pipe' });
});
