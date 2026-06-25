import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function makeTempDir(prefix) {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: path.join(repoRoot, 'node_modules') },
    ...options,
  });
}

function commandAvailable(command, args = ['-version']) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return result.status === 0;
}

test('deck gallery without complete thumbs falls back to grid', async (t) => {
  const tmp = await makeTempDir('deck-gallery-no-thumbs-');
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));

  const slidesDir = path.join(tmp, 'slides');
  await fsp.mkdir(slidesDir);
  const manifest = [];
  for (let i = 1; i <= 13; i++) {
    const name = `${String(i).padStart(2, '0')}.html`;
    manifest.push({ file: `slides/${name}`, label: `Slide ${i}` });
    await fsp.writeFile(path.join(slidesDir, name), `<!doctype html>
<html><body style="width:1920px;height:1080px;margin:0;background:#fff">${i}</body></html>`);
  }

  let indexHtml = await fsp.readFile(path.join(repoRoot, 'assets/deck_index.html'), 'utf8');
  indexHtml = indexHtml.replace(
    /window\.DECK_MANIFEST = \[[\s\S]*?\];/,
    `window.DECK_MANIFEST = ${JSON.stringify(manifest, null, 2)};`,
  );
  indexHtml = indexHtml.replace(
    "// window.DECK_OVERVIEW = 'grid';  // 取消注释可固定概览模式",
    "window.DECK_OVERVIEW = 'gallery';",
  );
  await fsp.writeFile(path.join(tmp, 'index.html'), indexHtml);

  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto(pathToFileURL(path.join(tmp, 'index.html')).href);
  await page.waitForFunction(() => document.querySelectorAll('#wall .card').length === 13);

  const state = await page.evaluate(() => ({
    overview: document.body.getAttribute('data-ov'),
    gridCards: document.querySelectorAll('#wall .card').length,
    galleryCards: document.querySelectorAll('#gallery .card').length,
    galleryIframes: document.querySelectorAll('#ov-gallery iframe').length,
  }));

  assert.deepEqual(state, {
    overview: 'grid',
    gridCards: 13,
    galleryCards: 0,
    galleryIframes: 0,
  });
});

test('mix-voiceover ducking keeps audible audio after the opening second', { skip: !commandAvailable('ffmpeg') || !commandAvailable('ffprobe') }, async (t) => {
  const tmp = await makeTempDir('voiceover-ducking-');
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));

  const video = path.join(tmp, 'input.mp4');
  const voice = path.join(tmp, 'voice.mp3');
  const bgm = path.join(tmp, 'bgm.mp3');
  const out = path.join(tmp, 'out.mp4');

  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=30:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video]);
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=3', '-q:a', '9', voice]);
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=3', '-q:a', '9', bgm]);

  const mixed = run('bash', ['scripts/mix-voiceover.sh', video, `--voiceover=${voice}`, `--bgm=${bgm}`, `--out=${out}`]);
  assert.equal(mixed.status, 0, mixed.stderr || mixed.stdout);
  assert.equal(fs.existsSync(out), true);

  const probe = spawnSync('ffmpeg', ['-hide_banner', '-ss', '1.2', '-t', '0.5', '-i', out, '-af', 'volumedetect', '-f', 'null', '-'], {
    encoding: 'utf8',
  });
  assert.equal(probe.status, 0, probe.stderr);
  const match = probe.stderr.match(/mean_volume:\s*(-?\d+(?:\.\d+)?) dB/);
  assert.ok(match, probe.stderr);
  assert.ok(Number(match[1]) > -35, `expected audible audio, got mean_volume ${match[1]} dB`);
});

test('export_deck_pptx fails closed on partial slide conversion failures', async (t) => {
  const tmp = await makeTempDir('pptx-partial-failure-');
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));

  const slidesDir = path.join(tmp, 'slides');
  await fsp.mkdir(slidesDir);
  await fsp.writeFile(path.join(slidesDir, '01-good.html'), `<!doctype html>
<html><head><style>
html,body{width:1280px;height:720px;margin:0;overflow:hidden;font-family:Arial,sans-serif}
p{position:absolute;left:100px;top:100px;width:480px;height:80px;font-size:32px}
</style></head><body><p>Good slide</p></body></html>`);
  await fsp.writeFile(path.join(slidesDir, '02-bad.html'), `<!doctype html>
<html><head><style>html,body{width:2000px;height:720px;margin:0;overflow:hidden}</style></head><body><p>Bad slide</p></body></html>`);

  const out = path.join(tmp, 'deck.pptx');
  const result = run(process.execPath, ['scripts/export_deck_pptx.mjs', '--slides', slidesDir, '--out', out]);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /01-good\.html/);
  assert.match(result.stderr, /02-bad\.html/);
  assert.match(result.stderr, /不生成缺页 PPTX|allow-partial/);
  assert.equal(fs.existsSync(out), false);
});
