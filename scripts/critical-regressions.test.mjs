import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function withTempDir(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'huashu-critical-'));
  try {
    return await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

test('deck gallery without complete thumbnails fails safe to grid and tears down overview DOM', { timeout: 30000 }, async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  try {
    await page.goto('file://' + path.join(repoRoot, 'assets/deck_index.html') + '?ov=gallery', { waitUntil: 'load' });
    await page.waitForFunction(() => document.body.dataset.mode === 'overview' && document.body.dataset.ov === 'grid');
    const overview = await page.evaluate(() => ({
      ov: document.body.dataset.ov,
      hash: location.hash,
      galleryCards: document.querySelectorAll('#ov-gallery .card').length,
      galleryIframes: document.querySelectorAll('#ov-gallery iframe').length,
      gridCards: document.querySelectorAll('#ov-grid .card').length,
    }));
    assert.deepEqual(overview, { ov: 'grid', hash: '', galleryCards: 0, galleryIframes: 0, gridCards: 1 });

    await page.click('#startBtn');
    await page.waitForFunction(() => document.body.dataset.mode === 'present');
    const present = await page.evaluate(() => ({
      wallCards: document.querySelectorAll('#ov-grid .card').length,
      galleryCards: document.querySelectorAll('#ov-gallery .card').length,
    }));
    assert.deepEqual(present, { wallCards: 0, galleryCards: 0 });
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
});

test('PPTX export fails closed and removes stale output on partial conversion failure', { timeout: 60000 }, async () => {
  await withTempDir(async (dir) => {
    const slides = path.join(dir, 'slides');
    await fsp.mkdir(slides);
    await fsp.writeFile(path.join(slides, '01-ok.html'), `<!doctype html><html><body style="width:1280px;height:720px;margin:0"><p style="font-size:24px">ok</p></body></html>`);
    await fsp.writeFile(path.join(slides, '02-overflow.html'), `<!doctype html><html><body style="width:1280px;height:720px;margin:0"><p style="font-size:24px;margin-top:760px">overflow</p></body></html>`);
    const out = path.join(dir, 'deck.pptx');
    await fsp.writeFile(out, 'stale');

    const result = spawnSync(process.execPath, [
      path.join(repoRoot, 'scripts/export_deck_pptx.mjs'),
      '--slides', slides,
      '--out', out,
    ], { cwd: repoRoot, encoding: 'utf8' });

    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.equal(fs.existsSync(out), false, 'stale or partial PPTX output should be removed');
    assert.match(result.stderr, /默认禁止部分成功|全部失败/);
  });
});

test('seek renderer rejects non-frozen seek pages and removes stale MP4', { timeout: 30000 }, async () => {
  await withTempDir(async (dir) => {
    const html = path.join(dir, 'bad-seek.html');
    await fsp.writeFile(html, `<!doctype html><html><body><script>window.__ready = true; window.__seek = () => {};</script></body></html>`);
    const out = path.join(dir, 'bad-seek.mp4');
    await fsp.writeFile(out, 'stale');

    const result = spawnSync(process.execPath, [
      path.join(repoRoot, 'scripts/render-video-seek.js'),
      html,
      '--duration=0.1',
      '--fps=1',
      '--width=16',
      '--height=16',
      '--readytimeout=0.2',
      '--concurrency=1',
    ], { cwd: repoRoot, encoding: 'utf8' });

    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.equal(fs.existsSync(out), false, 'stale MP4 output should be removed on seek handshake failure');
    assert.match(result.stderr, /__seekRenderReady|冻结 seek 渲染握手|Timeout/);
  });
});

test('export scripts keep critical fail-closed invariants', async () => {
  const renderVideo = await fsp.readFile(path.join(repoRoot, 'scripts/render-video.js'), 'utf8');
  const renderSeek = await fsp.readFile(path.join(repoRoot, 'scripts/render-video-seek.js'), 'utf8');
  const renderNarration = await fsp.readFile(path.join(repoRoot, 'scripts/render-narration.sh'), 'utf8');
  const mixVoiceover = await fsp.readFile(path.join(repoRoot, 'scripts/mix-voiceover.sh'), 'utf8');
  const thumbs = await fsp.readFile(path.join(repoRoot, 'scripts/gen_deck_thumbs.mjs'), 'utf8');

  for (const source of [renderVideo, renderSeek]) {
    assert.doesNotMatch(source, /\.(masthead|kicker|title|footer),/, 'generic content class names must not be hidden');
  }
  assert.match(renderSeek, /__seekRenderReady/);
  assert.match(renderSeek, /Math\.max\(1,\s*Math\.ceil\(FPS \* DURATION\)\)/);
  assert.match(renderSeek, /pngCount !== TOTAL_FRAMES/);
  assert.match(renderSeek, /'-start_number', '0'/);
  assert.match(renderNarration, /LOCAL_NODE_PATH=/);
  assert.doesNotMatch(renderNarration, /npm root -g/);
  assert.doesNotMatch(mixVoiceover, /afade=t=out:st=0/);
  assert.match(mixVoiceover, /asplit=2/);
  assert.match(thumbs, /ok !== files\.length/);
  assert.match(thumbs, /fs\.rmSync\(out, \{ force: true \}\)/);
});
