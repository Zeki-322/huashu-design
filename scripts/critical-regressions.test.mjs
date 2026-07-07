import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function makeTempDir(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

function runNode(args, options = {}) {
  return spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: path.join(ROOT, 'node_modules') },
    ...options,
  });
}

function runCommand(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    ...options,
  });
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function slideHtml(body) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    html, body { margin: 0; width: 960px; height: 540px; overflow: hidden; font-family: Arial, sans-serif; }
    body { background: #fff; color: #111; }
  </style>
</head>
<body>${body}</body>
</html>`;
}

async function writeDeckIndex(deckDir, manifest) {
  const template = await readFile(path.join(ROOT, 'assets/deck_index.html'), 'utf8');
  const html = template.replace(
    /window\.DECK_MANIFEST = \[[\s\S]*?\];/,
    `window.DECK_MANIFEST = ${JSON.stringify(manifest, null, 2)};`,
  );
  await writeFile(path.join(deckDir, 'index.html'), html);
}

test('deck gallery falls back to grid when manifest thumbs are incomplete', async () => {
  const dir = await makeTempDir('huashu-gallery-missing-thumbs-');
  try {
    const slidesDir = path.join(dir, 'slides');
    await mkdir(slidesDir);
    const manifest = [];
    for (let i = 1; i <= 12; i++) {
      const name = `${String(i).padStart(2, '0')}.html`;
      await writeFile(path.join(slidesDir, name), slideHtml(`<p>Slide ${i}</p>`));
      manifest.push({ file: `slides/${name}`, label: `Slide ${i}` });
    }
    await writeDeckIndex(dir, manifest);

    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    try {
      await page.goto(`${pathToFileURL(path.join(dir, 'index.html')).href}?ov=gallery`, { waitUntil: 'load' });
      await page.waitForFunction(() => document.body.getAttribute('data-ov') === 'grid');
      await page.waitForFunction((n) => document.querySelectorAll('#ov-grid iframe').length === n, manifest.length);

      assert.equal(await page.locator('#ov-grid iframe').count(), manifest.length);
      assert.equal(await page.locator('#ov-gallery iframe').count(), 0);
      assert.equal(await page.locator('#ov-gallery .card').count(), 0);
    } finally {
      await browser.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('deck gallery with complete thumbs never creates iframe tiles', async () => {
  const dir = await makeTempDir('huashu-gallery-thumbs-');
  try {
    const slidesDir = path.join(dir, 'slides');
    const thumbsDir = path.join(dir, 'thumbs');
    await mkdir(slidesDir);
    await mkdir(thumbsDir);
    const manifest = [];
    for (let i = 1; i <= 6; i++) {
      const name = `${String(i).padStart(2, '0')}.html`;
      const thumb = `${String(i).padStart(2, '0')}.jpg`;
      await writeFile(path.join(slidesDir, name), slideHtml(`<p>Slide ${i}</p>`));
      await writeFile(path.join(thumbsDir, thumb), '');
      manifest.push({ file: `slides/${name}`, thumb: `thumbs/${thumb}`, label: `Slide ${i}` });
    }
    await writeDeckIndex(dir, manifest);

    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    try {
      await page.goto(`${pathToFileURL(path.join(dir, 'index.html')).href}?ov=gallery`, { waitUntil: 'load' });
      await page.waitForFunction(() => document.body.getAttribute('data-ov') === 'gallery');
      await page.waitForFunction((n) => document.querySelectorAll('#ov-gallery .thumb-img').length > n, manifest.length);

      assert.equal(await page.locator('#ov-gallery iframe').count(), 0);
      assert.equal(await page.locator('#ov-grid iframe').count(), 0);
    } finally {
      await browser.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('PPTX export fails closed on a partial slide conversion', async () => {
  const dir = await makeTempDir('huashu-pptx-partial-');
  try {
    const slidesDir = path.join(dir, 'slides');
    await mkdir(slidesDir);
    await writeFile(path.join(slidesDir, '01-good.html'), slideHtml('<p style="font-size:24px;margin:40px">Good slide</p>'));
    await writeFile(path.join(slidesDir, '02-bad.html'), slideHtml('<div style="height:2000px">Overflow</div>'));
    const outFile = path.join(dir, 'deck.pptx');
    await writeFile(outFile, 'stale');

    const result = runNode(['scripts/export_deck_pptx.mjs', '--slides', slidesDir, '--out', outFile]);

    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /不完整|转换失败/);
    assert.equal(await exists(outFile), false, 'stale PPTX output should be removed on failure');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('seek renderer rejects pages that do not complete the frozen-clock handshake', async () => {
  const dir = await makeTempDir('huashu-seek-handshake-');
  try {
    const html = path.join(dir, 'bad-seek.html');
    const outFile = path.join(dir, 'bad-seek.mp4');
    await writeFile(html, `<!doctype html>
<html><body><div>bad seek</div><script>
window.__ready = true;
window.__seek = function () {};
</script></body></html>`);
    await writeFile(outFile, 'stale');

    const result = runNode([
      'scripts/render-video-seek.js',
      html,
      '--duration=0.1',
      '--fps=1',
      '--width=64',
      '--height=64',
      '--concurrency=1',
      '--readytimeout=0.2',
    ]);

    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /seek-render 握手|__seekRenderReady/);
    assert.equal(await exists(outFile), false, 'stale MP4 output should be removed on seek-render failure');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('seek renderer succeeds when the frozen-clock handshake is complete', async () => {
  const dir = await makeTempDir('huashu-seek-success-');
  try {
    const html = path.join(dir, 'good-seek.html');
    const outFile = path.join(dir, 'good-seek.mp4');
    await writeFile(html, `<!doctype html>
<html>
<body style="margin:0;width:64px;height:64px;background:#123;color:#fff">
<div id="t">0</div>
<script>
if (window.__seekRender) {
  window.__ready = true;
  window.__seekRenderReady = true;
  window.__seek = function (t) {
    document.getElementById('t').textContent = t.toFixed(2);
    document.body.style.background = t > 0 ? '#345' : '#123';
  };
}
</script>
</body>
</html>`);

    const result = runNode([
      'scripts/render-video-seek.js',
      html,
      '--duration=0.2',
      '--fps=2',
      '--width=64',
      '--height=64',
      '--concurrency=1',
      '--readytimeout=1',
    ]);

    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok((await stat(outFile)).size > 0, 'seek renderer should write a non-empty MP4');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('render-video chrome hiding does not target common content class names', async () => {
  const renderVideo = await readFile(path.join(ROOT, 'scripts/render-video.js'), 'utf8');
  const seekVideo = await readFile(path.join(ROOT, 'scripts/render-video-seek.js'), 'utf8');

  for (const source of [renderVideo, seekVideo]) {
    assert.equal(source.includes('.title,'), false);
    assert.equal(source.includes('.kicker,'), false);
    assert.equal(source.includes('.masthead,'), false);
    assert.equal(source.includes('.footer,'), false);
  }
});

test('voiceover ducking keeps audio audible after the first second', async (t) => {
  const ffmpeg = runCommand('ffmpeg', ['-version']);
  if (ffmpeg.status !== 0) {
    t.skip('ffmpeg is not available');
    return;
  }

  const dir = await makeTempDir('huashu-voiceover-mix-');
  try {
    const video = path.join(dir, 'video.mp4');
    const voice = path.join(dir, 'voice.wav');
    const bgm = path.join(dir, 'bgm.wav');
    const out = path.join(dir, 'mixed.mp4');

    assert.equal(runCommand('ffmpeg', [
      '-y',
      '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=2:r=10',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      video,
    ]).status, 0);
    assert.equal(runCommand('ffmpeg', [
      '-y',
      '-f', 'lavfi', '-i', 'sine=frequency=880:duration=2',
      '-c:a', 'pcm_s16le',
      voice,
    ]).status, 0);
    assert.equal(runCommand('ffmpeg', [
      '-y',
      '-f', 'lavfi', '-i', 'sine=frequency=220:duration=2',
      '-c:a', 'pcm_s16le',
      bgm,
    ]).status, 0);

    const mix = runCommand('bash', ['scripts/mix-voiceover.sh', video, `--voiceover=${voice}`, `--bgm=${bgm}`, `--out=${out}`]);
    assert.equal(mix.status, 0, mix.stdout + mix.stderr);

    const probe = runCommand('ffmpeg', [
      '-ss', '1.2',
      '-t', '0.4',
      '-i', out,
      '-af', 'volumedetect',
      '-f', 'null',
      '-',
    ]);
    assert.equal(probe.status, 0, probe.stdout + probe.stderr);
    const match = probe.stderr.match(/mean_volume:\s*(-?\d+(?:\.\d+)?) dB/);
    assert.ok(match, probe.stderr);
    assert.ok(Number(match[1]) > -35, `audio after 1s is too quiet: ${match[1]} dB`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
