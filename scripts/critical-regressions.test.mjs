import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

async function tempDir(name) {
  return mkdtemp(path.join(os.tmpdir(), `huashu-${name}-`));
}

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function listSeekTemps(dir) {
  return (await readdir(dir)).filter(name => name.startsWith('.seek-tmp-'));
}

async function writeFakeFfmpeg(binDir, mode) {
  await mkdir(binDir, { recursive: true });
  const script = mode === 'fail'
    ? `#!/usr/bin/env node\nprocess.stderr.write('fake ffmpeg failure');\nprocess.exit(2);\n`
    : `#!/usr/bin/env node\nconst fs = require('fs');\nfs.writeFileSync(process.argv[process.argv.length - 1], 'fake mp4');\n`;
  const ffmpeg = path.join(binDir, 'ffmpeg');
  await writeFile(ffmpeg, script);
  await chmod(ffmpeg, 0o755);
  return ffmpeg;
}

function runSeek(html, env, extraArgs = []) {
  return spawnSync(process.execPath, [
    path.join(ROOT, 'scripts/render-video-seek.js'),
    html,
    '--duration=0.1',
    '--fps=1',
    '--width=100',
    '--height=100',
    '--concurrency=1',
    '--settle=1',
    '--readytimeout=1',
    ...extraArgs,
  ], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
  });
}

test('seek renderer captures at least one frame for sub-second durations', async () => {
  const dir = await tempDir('seek-one-frame');
  try {
    const bin = path.join(dir, 'bin');
    await writeFakeFfmpeg(bin, 'success');
    const html = path.join(dir, 'demo.html');
    await writeFile(html, `<!doctype html>
<html><body style="margin:0;width:100px;height:100px;background:white">
<script>
window.__ready = true;
if (window.__seekRender) {
  window.__seekRenderReady = true;
  window.__seek = (t) => { document.body.textContent = 't=' + t.toFixed(3); };
}
</script>
</body></html>`);

    const result = runSeek(html, { ...process.env, PATH: `${bin}:${process.env.PATH}` });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Captured 1\/1 frames/);
    assert.equal(await exists(path.join(dir, 'demo.mp4')), true);
    assert.deepEqual(await listSeekTemps(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('seek renderer fails closed and cleans files when ffmpeg fails', async () => {
  const dir = await tempDir('seek-ffmpeg-fail');
  try {
    const bin = path.join(dir, 'bin');
    await writeFakeFfmpeg(bin, 'fail');
    const html = path.join(dir, 'demo.html');
    await writeFile(html, `<!doctype html>
<html><body style="margin:0;width:100px;height:100px;background:white">
<script>
window.__ready = true;
if (window.__seekRender) {
  window.__seekRenderReady = true;
  window.__seek = (t) => { document.body.textContent = 't=' + t.toFixed(3); };
}
</script>
</body></html>`);

    const result = runSeek(html, { ...process.env, PATH: `${bin}:${process.env.PATH}` });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /fake ffmpeg failure/);
    assert.equal(await exists(path.join(dir, 'demo.mp4')), false);
    assert.deepEqual(await listSeekTemps(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('seek renderer rejects pages without the frozen-clock handshake', async () => {
  const dir = await tempDir('seek-handshake');
  try {
    const bin = path.join(dir, 'bin');
    await writeFakeFfmpeg(bin, 'success');
    const html = path.join(dir, 'demo.html');
    await writeFile(html, `<!doctype html>
<html><body style="margin:0;width:100px;height:100px;background:white">
<script>
window.__ready = true;
window.__seek = () => {};
</script>
</body></html>`);

    const result = runSeek(html, { ...process.env, PATH: `${bin}:${process.env.PATH}` });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /__seekRenderReady/);
    assert.equal(await exists(path.join(dir, 'demo.mp4')), false);
    assert.deepEqual(await listSeekTemps(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('deck_index falls back to grid when gallery thumbnails are incomplete', async () => {
  const dir = await tempDir('deck-gallery-fallback');
  const browser = await chromium.launch();
  try {
    const slidesDir = path.join(dir, 'slides');
    await mkdir(slidesDir, { recursive: true });
    for (let i = 1; i <= 3; i++) {
      await writeFile(path.join(slidesDir, `0${i}.html`), `<!doctype html><html><body>slide ${i}</body></html>`);
    }

    const template = await readFile(path.join(ROOT, 'assets/deck_index.html'), 'utf8');
    const replacement = `window.DECK_MANIFEST = [
    { file: "slides/01.html", label: "One" },
    { file: "slides/02.html", label: "Two" },
    { file: "slides/03.html", label: "Three" },
  ];
  window.DECK_WIDTH = 1920;
  window.DECK_HEIGHT = 1080;
  window.DECK_OVERVIEW = 'gallery';`;
    const html = template.replace(
      /window\.DECK_MANIFEST = \[[\s\S]*?\];\s*window\.DECK_WIDTH = 1920;\s*window\.DECK_HEIGHT = 1080;/,
      replacement,
    );
    assert.notEqual(html, template, 'test fixture failed to inject manifest');
    await writeFile(path.join(dir, 'index.html'), html);

    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await page.goto('file://' + path.join(dir, 'index.html'), { waitUntil: 'load' });
    await page.waitForFunction(() => document.body.dataset.mode === 'overview');

    assert.equal(await page.evaluate(() => document.body.dataset.ov), 'grid');
    assert.equal(await page.locator('#ov-gallery iframe').count(), 0);
    assert.equal(await page.locator('#ov-grid iframe').count(), 3);
    await page.close();
  } finally {
    await browser.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('video chrome hiding does not target common content class names', async () => {
  for (const rel of ['scripts/render-video.js', 'scripts/render-video-seek.js']) {
    const source = await readFile(path.join(ROOT, rel), 'utf8');
    assert.doesNotMatch(source, /(^|[\s,])\.(masthead|kicker|title|footer)([\s,{])/);
  }
});

test('render-narration resolves local node_modules before invoking renderers', async () => {
  const source = await readFile(path.join(ROOT, 'scripts/render-narration.sh'), 'utf8');
  assert.match(source, /LOCAL_NODE_PATH=.*npm root/);
  assert.doesNotMatch(source, /npm root -g/);
});

test('PPTX export removes stale output and fails on partial conversion by default', async () => {
  const dir = await tempDir('pptx-partial');
  try {
    const slides = path.join(dir, 'slides');
    const out = path.join(dir, 'deck.pptx');
    await mkdir(slides, { recursive: true });
    await writeFile(out, 'stale pptx');
    await writeFile(path.join(slides, '01-ok.html'), `<!doctype html>
<html><body style="margin:0;width:960px;height:540px;background:#fff">
<p style="position:absolute;left:40px;top:40px;font-size:24px">OK slide</p>
</body></html>`);
    await writeFile(path.join(slides, '02-bad.html'), `<!doctype html>
<html><body style="margin:0;width:960px;height:540px;background:linear-gradient(red, blue)">
<p style="position:absolute;left:40px;top:40px;font-size:24px">Bad slide</p>
</body></html>`);

    const result = spawnSync(process.execPath, [
      path.join(ROOT, 'scripts/export_deck_pptx.mjs'),
      '--slides', slides,
      '--out', out,
    ], {
      cwd: ROOT,
      encoding: 'utf8',
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /部分失败|全部失败/);
    assert.equal(await exists(out), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
