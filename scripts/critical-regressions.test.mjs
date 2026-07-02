import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { chromium } from 'playwright';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeDeckFixture(dir, manifest) {
  const slidesDir = path.join(dir, 'slides');
  fs.mkdirSync(slidesDir, { recursive: true });
  manifest.forEach((item, i) => {
    fs.writeFileSync(
      path.join(slidesDir, path.basename(item.file)),
      `<!doctype html><html><body><h1>Slide ${i + 1}</h1></body></html>`,
    );
  });

  const template = fs.readFileSync(path.join(repoRoot, 'assets/deck_index.html'), 'utf8');
  const index = template.replace(
    /window\.DECK_MANIFEST = \[[\s\S]*?\];/,
    `window.DECK_MANIFEST = ${JSON.stringify(manifest, null, 2)};`,
  );
  const indexPath = path.join(dir, 'index.html');
  fs.writeFileSync(indexPath, index);
  return indexPath;
}

async function inspectDeck(indexPath, query = '') {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(pathToFileURL(indexPath).href + query, { waitUntil: 'load' });
    await page.waitForFunction(() => document.body.getAttribute('data-mode') === 'overview');
    await page.waitForFunction(() => document.querySelectorAll('#wall .card, #gallery .card').length > 0);
    return await page.evaluate(() => ({
      overview: document.body.getAttribute('data-ov'),
      wallIframes: document.querySelectorAll('#wall iframe').length,
      galleryIframes: document.querySelectorAll('#gallery iframe').length,
      galleryImages: document.querySelectorAll('#gallery img.thumb-img').length,
    }));
  } finally {
    await browser.close();
  }
}

test('deck gallery falls back to grid when thumbs are incomplete', async (t) => {
  const dir = tmpDir('deck-no-thumbs-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const indexPath = writeDeckFixture(dir, [
    { file: 'slides/01.html', label: 'One' },
    { file: 'slides/02.html', label: 'Two' },
    { file: 'slides/03.html', label: 'Three' },
  ]);

  const state = await inspectDeck(indexPath, '?ov=gallery');
  assert.equal(state.overview, 'grid');
  assert.equal(state.wallIframes, 3);
  assert.equal(state.galleryIframes, 0);
});

test('deck gallery uses only images when every slide has a thumb', async (t) => {
  const dir = tmpDir('deck-with-thumbs-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tinyGif = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
  const indexPath = writeDeckFixture(dir, [
    { file: 'slides/01.html', label: 'One', thumb: tinyGif },
    { file: 'slides/02.html', label: 'Two', thumb: tinyGif },
    { file: 'slides/03.html', label: 'Three', thumb: tinyGif },
  ]);

  const state = await inspectDeck(indexPath, '?ov=gallery');
  assert.equal(state.overview, 'gallery');
  assert.equal(state.galleryIframes, 0);
  assert.ok(state.galleryImages > 3);
});

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', ...options });
  assert.equal(
    result.status,
    0,
    `${cmd} ${args.join(' ')} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).status === 0;

test('ducking voiceover mix keeps audible audio after the opening second', { skip: !hasFfmpeg }, (t) => {
  const dir = tmpDir('mix-voiceover-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const video = path.join(dir, 'silent.mp4');
  const voice = path.join(dir, 'voice.mp3');
  const bgm = path.join(dir, 'bgm.mp3');
  const out = path.join(dir, 'out.mp4');

  run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=30:d=2', '-pix_fmt', 'yuv420p', video]);
  run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=2', '-q:a', '9', voice]);
  run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=2', '-q:a', '9', bgm]);
  run('bash', [path.join(repoRoot, 'scripts/mix-voiceover.sh'), video, `--voiceover=${voice}`, `--bgm=${bgm}`, `--out=${out}`]);

  const probe = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-ss', '1', '-t', '0.5', '-i', out, '-af', 'volumedetect', '-f', 'null', '-'],
    { encoding: 'utf8' },
  );
  assert.equal(probe.status, 0, probe.stderr);
  const match = probe.stderr.match(/mean_volume:\s*(-?\d+(?:\.\d+)?) dB/);
  assert.ok(match, probe.stderr);
  assert.ok(Number(match[1]) > -45, `mixed audio unexpectedly quiet: ${match[1]} dB`);
});

test('narration renderer resolves local node_modules before existing NODE_PATH', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'scripts/render-narration.sh'), 'utf8');
  assert.doesNotMatch(source, /npm root -g/);
  assert.match(source, /LOCAL_NODE_PATH="\$\(cd "\$SKILL_ROOT" && npm root\)"/);
  assert.match(source, /NODE_PATH="\$\{LOCAL_NODE_PATH\}\$\{NODE_PATH:\+\:\$NODE_PATH\}"/);
});

test('thumbnail generation exits non-zero when any slide fails', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'scripts/gen_deck_thumbs.mjs'), 'utf8');
  assert.match(source, /if \(ok !== files\.length\) \{[\s\S]*process\.exit\(1\);[\s\S]*\}/);
});
