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
const ROOT = path.resolve(__dirname, '..');

function run(cmd, args, options = {}) {
  return spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: path.join(ROOT, 'node_modules') },
    ...options,
  });
}

async function withTempDir(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'huashu-critical-'));
  try {
    return await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

test('deck gallery without complete thumbs falls back to grid and clears overview iframes', async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  try {
    await page.goto('file://' + path.join(ROOT, 'assets/deck_index.html') + '?ov=gallery', { waitUntil: 'load' });
    await page.waitForFunction(() =>
      document.body.dataset.mode === 'overview' &&
      document.body.dataset.ov === 'grid' &&
      document.querySelectorAll('#wall .card').length > 0
    );
    const overview = await page.evaluate(() => ({
      mode: document.body.dataset.mode,
      ov: document.body.dataset.ov,
      hash: location.hash,
      galleryCards: document.querySelectorAll('#ov-gallery .card').length,
      galleryIframes: document.querySelectorAll('#ov-gallery iframe').length,
    }));
    assert.deepEqual(overview, {
      mode: 'overview',
      ov: 'grid',
      hash: '',
      galleryCards: 0,
      galleryIframes: 0,
    });

    await page.click('#startBtn');
    await page.waitForFunction(() => document.body.dataset.mode === 'present');
    const present = await page.evaluate(() => ({
      wallCards: document.querySelectorAll('#wall .card').length,
      galleryCards: document.querySelectorAll('#ov-gallery .card').length,
      overviewIframes: document.querySelectorAll('#ov-grid iframe, #ov-gallery iframe').length,
    }));
    assert.deepEqual(present, { wallCards: 0, galleryCards: 0, overviewIframes: 0 });
  } finally {
    await page.close();
    await browser.close();
  }
});

test('gen_deck_thumbs fails nonzero and removes stale per-slide output', async () => {
  await withTempDir(async (dir) => {
    const slides = path.join(dir, 'slides');
    const thumbs = path.join(dir, 'thumbs');
    await fsp.mkdir(slides);
    await fsp.mkdir(thumbs);
    await fsp.writeFile(path.join(slides, '01.html'), '<!doctype html><body>slide</body>');
    const stale = path.join(thumbs, '01.jpg');
    await fsp.writeFile(stale, 'stale');

    const result = run('node', [
      path.join(ROOT, 'scripts/gen_deck_thumbs.mjs'),
      '--slides', slides,
      '--out', thumbs,
      '--width', '0',
    ]);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.equal(fs.existsSync(stale), false, 'stale thumbnail should be removed on failure');
  });
});

test('export_deck_pptx removes stale output and fails on partial conversion by default', async () => {
  await withTempDir(async (dir) => {
    const slides = path.join(dir, 'slides');
    await fsp.mkdir(slides);
    await fsp.writeFile(path.join(slides, '01-good.html'), `<!doctype html>
<style>html,body{width:1280px;height:720px;margin:0;overflow:hidden;background:#fff}p{position:absolute;left:100px;top:100px;margin:0;font-size:24px}</style>
<p>OK</p>`);
    await fsp.writeFile(path.join(slides, '02-bad.html'), `<!doctype html>
<style>html,body{width:1280px;height:720px;margin:0;overflow:hidden;background:#fff}p{background:red;font-size:24px}</style>
<p>bad</p>`);
    const out = path.join(dir, 'deck.pptx');
    await fsp.writeFile(out, 'stale');

    const result = run('node', [
      path.join(ROOT, 'scripts/export_deck_pptx.mjs'),
      '--slides', slides,
      '--out', out,
    ]);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.equal(fs.existsSync(out), false, 'stale PPTX should be removed on partial failure');
  });
});

test('render-video-seek rejects non-frozen seek pages and removes stale MP4', async () => {
  await withTempDir(async (dir) => {
    const html = path.join(dir, 'bad-seek.html');
    const mp4 = path.join(dir, 'bad-seek.mp4');
    await fsp.writeFile(html, '<!doctype html><script>window.__ready=true;window.__seek=function(){}</script><body>bad</body>');
    await fsp.writeFile(mp4, 'stale');

    const result = run('node', [
      path.join(ROOT, 'scripts/render-video-seek.js'),
      html,
      '--duration=0.1',
      '--fps=1',
      '--width=64',
      '--height=64',
      '--readytimeout=0.1',
      '--keep-chrome',
    ]);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /__seekRenderReady|冻结时钟/);
    assert.equal(fs.existsSync(mp4), false, 'stale MP4 should be removed on failed seek handshake');
  });
});

test('render-video-seek captures at least one frame for short positive durations', async () => {
  await withTempDir(async (dir) => {
    const html = path.join(dir, 'good-seek.html');
    const mp4 = path.join(dir, 'good-seek.mp4');
    await fsp.writeFile(html, `<!doctype html>
<style>html,body{margin:0;width:64px;height:64px;background:#123;color:white}</style>
<body><div id="t">0</div><script>
window.__ready = true;
window.__seekRenderReady = true;
window.__seek = (t) => { document.getElementById('t').textContent = t.toFixed(2); };
</script></body>`);

    const result = run('node', [
      path.join(ROOT, 'scripts/render-video-seek.js'),
      html,
      '--duration=0.1',
      '--fps=1',
      '--width=64',
      '--height=64',
      '--readytimeout=1',
      '--keep-chrome',
    ]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(fs.existsSync(mp4), true, 'short positive duration should still produce one-frame MP4');
    assert.ok(fs.statSync(mp4).size > 0);
  });
});

test('mix-voiceover keeps video duration and remains audible after first second', async () => {
  await withTempDir(async (dir) => {
    const video = path.join(dir, 'video.mp4');
    const voice = path.join(dir, 'voice.wav');
    const bgm = path.join(dir, 'bgm.wav');
    const out = path.join(dir, 'mixed.mp4');

    assert.equal(run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video]).status, 0);
    assert.equal(run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=0.5', voice]).status, 0);
    assert.equal(run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=2', bgm]).status, 0);

    const mixed = run('bash', [
      path.join(ROOT, 'scripts/mix-voiceover.sh'),
      video,
      '--voiceover=' + voice,
      '--bgm=' + bgm,
      '--out=' + out,
    ]);
    assert.equal(mixed.status, 0, mixed.stdout + mixed.stderr);

    const duration = run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', out]);
    assert.equal(duration.status, 0, duration.stderr);
    assert.ok(parseFloat(duration.stdout) > 1.8, 'mixed output should not be truncated to voiceover length');

    const volume = run('ffmpeg', ['-v', 'info', '-ss', '1', '-t', '0.2', '-i', out, '-af', 'volumedetect', '-f', 'null', '-']);
    assert.equal(volume.status, 0, volume.stderr);
    assert.match(volume.stderr, /mean_volume: -?\d+(\.\d+)? dB/, 'audio after 1s should not be fully faded out');
  });
});

test('fetch_images generates unique paths for colliding sanitized names', async () => {
  await withTempDir(async (dir) => {
    const existing = path.join(dir, 'same.jpg');
    await fsp.writeFile(existing, 'existing');
    const snippet = `
import importlib.util
spec = importlib.util.spec_from_file_location("fetch_images", ${JSON.stringify(path.join(ROOT, 'scripts/fetch_images.py'))})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
print(mod._unique_path(${JSON.stringify(dir)}, "same.jpg"))
`;
    const result = run('python3', ['-c', snippet]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), path.join(dir, 'same_2.jpg'));
  });
});
