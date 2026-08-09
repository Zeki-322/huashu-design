import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function repoPath(...parts) {
  return path.join(root, ...parts);
}

async function tempDir(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

function withManifest(html, manifest) {
  return html.replace(
    /window\.DECK_MANIFEST = \[[\s\S]*?\];/,
    'window.DECK_MANIFEST = ' + JSON.stringify(manifest, null, 2) + ';',
  );
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    ...options,
  });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(' ')}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}

test('deck gallery fails safely without complete thumbs and ignores invalid hashes', async () => {
  const dir = await tempDir('deck-index-regression-');
  const slidesDir = path.join(dir, 'slides');
  await fsp.mkdir(slidesDir);
  await fsp.writeFile(path.join(slidesDir, '01.html'), '<!doctype html><title>slide</title><body>Slide</body>');

  const deckIndex = await fsp.readFile(repoPath('assets', 'deck_index.html'), 'utf8');
  const index = path.join(dir, 'index.html');
  await fsp.writeFile(index, withManifest(deckIndex, [{ file: 'slides/01.html', label: 'One' }]));

  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto('file://' + index + '?ov=gallery', { waitUntil: 'load' });
    await page.waitForFunction(() => document.body.dataset.mode === 'overview');
    const fallback = await page.evaluate(() => ({
      ov: document.body.dataset.ov,
      hash: location.hash,
      galleryCards: document.querySelectorAll('#gallery .card').length,
      galleryIframes: document.querySelectorAll('#ov-gallery iframe').length,
    }));
    assert.deepEqual(fallback, {
      ov: 'grid',
      hash: '',
      galleryCards: 0,
      galleryIframes: 0,
    });

    await page.goto('file://' + index + '?ov=grid#999', { waitUntil: 'load' });
    await page.waitForFunction(() => document.body.dataset.mode === 'overview');
    const invalidHash = await page.evaluate(() => ({
      mode: document.body.dataset.mode,
      hash: location.hash,
      frameSrc: document.getElementById('frame').getAttribute('src'),
    }));
    assert.deepEqual(invalidHash, {
      mode: 'overview',
      hash: '#999',
      frameSrc: 'about:blank',
    });
  } finally {
    await browser.close();
  }
});

test('entering present mode tears down heavy overview DOM', async () => {
  const dir = await tempDir('deck-present-regression-');
  const slidesDir = path.join(dir, 'slides');
  await fsp.mkdir(slidesDir);
  await fsp.writeFile(path.join(slidesDir, '01.html'), '<!doctype html><title>slide</title><body>Slide</body>');

  const deckIndex = await fsp.readFile(repoPath('assets', 'deck_index.html'), 'utf8');
  const index = path.join(dir, 'index.html');
  await fsp.writeFile(index, withManifest(deckIndex, [{ file: 'slides/01.html', label: 'One', thumb: 'thumbs/01.jpg' }]));

  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto('file://' + index + '?ov=gallery', { waitUntil: 'load' });
    await page.waitForFunction(() => document.querySelectorAll('#gallery .card').length > 0);
    await page.evaluate(() => document.querySelector('#gallery .card').click());
    await page.waitForFunction(() => document.body.dataset.mode === 'present');
    const state = await page.evaluate(() => ({
      mode: document.body.dataset.mode,
      galleryCards: document.querySelectorAll('#gallery .card').length,
      wallCards: document.querySelectorAll('#wall .card').length,
    }));
    assert.deepEqual(state, { mode: 'present', galleryCards: 0, wallCards: 0 });
  } finally {
    await browser.close();
  }
});

test('video renderers do not hide generic content class names', async () => {
  for (const file of ['render-video.js', 'render-video-seek.js']) {
    const source = await fsp.readFile(repoPath('scripts', file), 'utf8');
    for (const selector of ['.masthead', '.kicker', '.title', '.footer']) {
      assert.equal(source.includes(selector), false, `${file} must not hide ${selector}`);
    }
  }
});

test('seek renderer rejects non-frozen seek pages and removes stale MP4', async () => {
  const dir = await tempDir('seek-handshake-regression-');
  const html = path.join(dir, 'bad-seek.html');
  const stale = path.join(dir, 'bad-seek.mp4');
  await fsp.writeFile(html, '<!doctype html><body><script>window.__ready=true;window.__seek=function(){};</script>bad seek</body>');
  await fsp.writeFile(stale, 'stale mp4');

  const result = spawnSync(process.execPath, [
    repoPath('scripts', 'render-video-seek.js'),
    html,
    '--duration=0.01',
    '--fps=1',
    '--readytimeout=0.2',
    '--concurrency=1',
  ], { cwd: root, encoding: 'utf8' });

  assert.notEqual(result.status, 0, 'bad handshake must fail');
  assert.match(result.stderr + result.stdout, /冻结 seek-render|__seekRenderReady|Timeout/);
  assert.equal(fs.existsSync(stale), false, 'stale MP4 must be removed on failure');
});

test('ducking voiceover mix remains audible after the opening half-second', { skip: !hasFfmpeg() }, async () => {
  const dir = await tempDir('voiceover-mix-regression-');
  const video = path.join(dir, 'video.mp4');
  const voice = path.join(dir, 'voice.mp3');
  const bgm = path.join(dir, 'bgm.mp3');
  const out = path.join(dir, 'out.mp4');

  run('ffmpeg', [
    '-y',
    '-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=25:d=2',
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=mono:sample_rate=44100',
    '-shortest',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    video,
  ]);
  run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=2', '-c:a', 'mp3', voice]);
  run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=0.5', '-c:a', 'mp3', bgm]);

  run('bash', [repoPath('scripts', 'mix-voiceover.sh'), video, '--voiceover=' + voice, '--bgm=' + bgm, '--out=' + out]);

  const duration = Number(run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    out,
  ]).stdout.trim());
  assert.ok(duration >= 1.8 && duration <= 2.2, `mixed output should keep video duration, got ${duration}`);

  const probe = spawnSync('ffmpeg', [
    '-v', 'info',
    '-ss', '1',
    '-t', '0.5',
    '-i', out,
    '-af', 'volumedetect',
    '-f', 'null',
    '-',
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(probe.status, 0, probe.stderr);
  const mean = /mean_volume:\s*(-?\d+(?:\.\d+)?) dB/.exec(probe.stderr);
  assert.ok(mean, probe.stderr);
  assert.ok(Number(mean[1]) > -50, `audio should not fade to silence after 1s, got ${mean[1]} dB`);
});

test('export safeguards fail closed instead of leaving stale partial outputs', async () => {
  const pptx = await fsp.readFile(repoPath('scripts', 'export_deck_pptx.mjs'), 'utf8');
  assert.match(pptx, /--allow-partial/);
  assert.match(pptx, /await fs\.rm\(outFile, \{ force: true \}\)/);
  assert.match(pptx, /默认不生成部分 PPTX/);

  const thumbs = await fsp.readFile(repoPath('scripts', 'gen_deck_thumbs.mjs'), 'utf8');
  assert.match(thumbs, /failures\.length/);
  assert.match(thumbs, /fs\.rmSync\(out, \{ force: true \}\)/);
  assert.match(thumbs, /process\.exit\(1\)/);
});

function hasFfmpeg() {
  return spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).status === 0
    && spawnSync('ffprobe', ['-version'], { encoding: 'utf8' }).status === 0;
}
