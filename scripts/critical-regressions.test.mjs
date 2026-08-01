#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

async function tempDir(prefix) {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    cwd: opts.cwd || repoRoot,
    env: { ...process.env, ...(opts.env || {}) },
    encoding: 'utf8',
    timeout: opts.timeout || 30000,
  });
}

test('deck gallery without complete thumbs falls back to grid and releases overview DOM on present', async () => {
  const dir = await tempDir('deck-index-');
  const slidesDir = path.join(dir, 'slides');
  await fsp.mkdir(slidesDir);
  const manifest = [];
  for (let i = 1; i <= 18; i++) {
    const file = `slides/${String(i).padStart(2, '0')}.html`;
    manifest.push({ file, label: `Slide ${i}` });
    await fsp.writeFile(path.join(dir, file), '<!doctype html><body style="margin:0;width:1920px;height:1080px;background:#fff"></body>');
  }

  const source = await fsp.readFile(path.join(repoRoot, 'assets/deck_index.html'), 'utf8');
  const html = source.replace(
    /window\.DECK_MANIFEST = \[[\s\S]*?\];/,
    `window.DECK_MANIFEST = ${JSON.stringify(manifest)};`,
  );
  const indexPath = path.join(dir, 'index.html');
  await fsp.writeFile(indexPath, html);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto('file://' + indexPath + '?ov=gallery', { waitUntil: 'load' });
    await page.waitForFunction(() =>
      document.body.dataset.ov === 'grid' &&
      document.querySelectorAll('#wall .card').length === 18,
    null, { timeout: 5000 });

    assert.deepEqual(await page.evaluate(() => ({
      ov: document.body.dataset.ov,
      hash: location.hash,
      galleryCards: document.querySelectorAll('#gallery .card').length,
      galleryIframes: document.querySelectorAll('#gallery iframe').length,
      wallCards: document.querySelectorAll('#wall .card').length,
    })), {
      ov: 'grid',
      hash: '',
      galleryCards: 0,
      galleryIframes: 0,
      wallCards: 18,
    });

    await page.click('#startBtn');
    await page.waitForFunction(() => document.body.dataset.mode === 'present');
    const presentState = await page.evaluate(() => ({
      wallCards: document.querySelectorAll('#wall .card').length,
      galleryCards: document.querySelectorAll('#gallery .card').length,
      frame: document.querySelector('#frame').getAttribute('src'),
    }));
    assert.equal(presentState.wallCards, 0);
    assert.equal(presentState.galleryCards, 0);
    assert.match(presentState.frame, /slides\/01\.html$/);
  } finally {
    await browser.close();
  }
});

test('gen_deck_thumbs rejects invalid dimensions before creating outputs', async () => {
  const dir = await tempDir('deck-thumbs-');
  await fsp.mkdir(path.join(dir, 'slides'));
  await fsp.writeFile(path.join(dir, 'slides/01.html'), '<!doctype html><body></body>');
  const result = run('node', [
    path.join(repoRoot, 'scripts/gen_deck_thumbs.mjs'),
    '--slides', 'slides',
    '--out', 'thumbs',
    '--width', '0',
  ], { cwd: dir });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /无效 --width/);
  assert.equal(fs.existsSync(path.join(dir, 'thumbs/01.jpg')), false);
});

test('export_deck_pptx removes stale output and fails on partial slide conversion by default', async () => {
  const dir = await tempDir('deck-pptx-');
  const slidesDir = path.join(dir, 'slides');
  await fsp.mkdir(slidesDir);
  await fsp.writeFile(path.join(slidesDir, '01-good.html'), `<!doctype html>
    <html><body style="margin:0;width:1280px;height:720px"><p style="font-size:24px">ok</p></body></html>`);
  await fsp.writeFile(path.join(slidesDir, '02-bad.html'), `<!doctype html>
    <html><body style="margin:0;width:800px;height:600px"><p style="font-size:24px">bad</p></body></html>`);
  const out = path.join(dir, 'deck.pptx');
  await fsp.writeFile(out, 'stale');

  const result = run('node', [
    path.join(repoRoot, 'scripts/export_deck_pptx.mjs'),
    '--slides', slidesDir,
    '--out', out,
  ], { timeout: 60000 });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /默认禁止生成部分成功的 PPTX|全部失败/);
  assert.equal(fs.existsSync(out), false);
});

test('render-video-seek requires frozen seek handshake and removes stale mp4 on failure', async () => {
  const dir = await tempDir('seek-handshake-');
  const html = path.join(dir, 'bad.html');
  const mp4 = path.join(dir, 'bad.mp4');
  await fsp.writeFile(html, '<!doctype html><script>window.__ready=true; window.__seek=function(){};</script><body></body>');
  await fsp.writeFile(mp4, 'stale');

  const result = run('node', [
    path.join(repoRoot, 'scripts/render-video-seek.js'),
    html,
    '--duration=0.01',
    '--fps=1',
    '--concurrency=1',
    '--readytimeout=0.2',
  ], { timeout: 30000 });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /__seekRenderReady|冻结 seek 渲染握手/);
  assert.equal(fs.existsSync(mp4), false);
});

test('video exporters do not hide generic content class names', async () => {
  for (const rel of ['scripts/render-video.js', 'scripts/render-video-seek.js']) {
    const src = await fsp.readFile(path.join(repoRoot, rel), 'utf8');
    assert.doesNotMatch(src, /\.masthead,\s*\.kicker,\s*\.title/);
    assert.doesNotMatch(src, /\.footer,/);
  }
});

test('voiceover ducking keeps audio audible after the first second', async (t) => {
  if (run('ffmpeg', ['-version']).status !== 0) {
    t.skip('ffmpeg is not available');
    return;
  }

  const dir = await tempDir('voiceover-mix-');
  const video = path.join(dir, 'video.mp4');
  const voice = path.join(dir, 'voice.mp3');
  const bgm = path.join(dir, 'bgm.mp3');
  const out = path.join(dir, 'out.mp4');

  assert.equal(run('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:d=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video,
  ], { timeout: 30000 }).status, 0);
  assert.equal(run('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-q:a', '4', voice,
  ], { timeout: 30000 }).status, 0);
  assert.equal(run('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=2',
    '-q:a', '4', bgm,
  ], { timeout: 30000 }).status, 0);

  const mixed = run('bash', [
    path.join(repoRoot, 'scripts/mix-voiceover.sh'),
    video,
    '--voiceover=' + voice,
    '--bgm=' + bgm,
    '--out=' + out,
  ], { timeout: 30000 });
  assert.equal(mixed.status, 0, mixed.stderr + mixed.stdout);

  const probe = run('ffmpeg', [
    '-ss', '1',
    '-t', '0.4',
    '-i', out,
    '-af', 'volumedetect',
    '-f', 'null',
    '-',
  ], { timeout: 30000 });
  assert.equal(probe.status, 0);
  const m = (probe.stderr + probe.stdout).match(/mean_volume:\s*(-?\d+(?:\.\d+)?) dB/);
  assert.ok(m, probe.stderr + probe.stdout);
  assert.ok(Number(m[1]) > -60, 'mixed audio should not be faded to silence after 1s');
});
