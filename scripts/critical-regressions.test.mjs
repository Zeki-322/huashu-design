import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const repoPath = (...parts) => path.join(ROOT, ...parts);
const readRepo = (...parts) => readFile(repoPath(...parts), 'utf8');

async function makeTempDir(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function pathExists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function chromeHideCss(source) {
  const match = source.match(/const HIDE_CHROME_CSS = `([\s\S]*?)`;/);
  assert.ok(match, 'HIDE_CHROME_CSS should be present');
  return match[1];
}

test('deck gallery falls back to grid when thumbnails are incomplete', async () => {
  const tmp = await makeTempDir('deck-gallery-');
  try {
    const slides = path.join(tmp, 'slides');
    await mkdir(slides);
    const manifest = Array.from({ length: 12 }, (_, i) => {
      const n = String(i + 1).padStart(2, '0');
      return `{ file: "slides/${n}.html", label: "Slide ${n}" }`;
    }).join(',\n    ');
    for (let i = 1; i <= 12; i++) {
      const n = String(i).padStart(2, '0');
      await writeFile(path.join(slides, `${n}.html`), `<!doctype html><title>${n}</title><body style="width:1920px;height:1080px">${n}</body>`);
    }

    const source = await readRepo('assets', 'deck_index.html');
    const html = source.replace(/window\.DECK_MANIFEST = \[[\s\S]*?\];/, `window.DECK_MANIFEST = [\n    ${manifest}\n  ];`);
    const index = path.join(tmp, 'index.html');
    await writeFile(index, html);

    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await page.goto(`file://${index}?ov=gallery`, { waitUntil: 'load' });
      await page.waitForFunction(() => document.body.dataset.mode === 'overview' && document.body.dataset.ov);
      const state = await page.evaluate(() => ({
        ov: document.body.dataset.ov,
        hash: location.hash,
        wallCards: document.querySelectorAll('#wall .card').length,
        galleryCards: document.querySelectorAll('#gallery .card').length,
        galleryIframes: document.querySelectorAll('#gallery iframe').length,
      }));
      assert.deepEqual(state, {
        ov: 'grid',
        hash: '',
        wallCards: 12,
        galleryCards: 0,
        galleryIframes: 0,
      });
    } finally {
      await browser.close();
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('gen_deck_thumbs exits non-zero and removes stale output on failed thumbnail', async () => {
  const tmp = await makeTempDir('deck-thumbs-');
  try {
    const slides = path.join(tmp, 'slides');
    const thumbs = path.join(tmp, 'thumbs');
    await mkdir(slides);
    await mkdir(thumbs);
    await writeFile(path.join(slides, '01.html'), '<!doctype html><body style="width:1920px;height:1080px">slide</body>');
    const stale = path.join(thumbs, '01.jpg');
    await writeFile(stale, 'stale');

    const result = spawnSync(process.execPath, [
      repoPath('scripts', 'gen_deck_thumbs.mjs'),
      '--slides', slides,
      '--out', thumbs,
      '--width', '0',
    ], {
      cwd: tmp,
      env: process.env,
      encoding: 'utf8',
      timeout: 30000,
    });

    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.equal(await pathExists(stale), false, 'stale thumbnail should be deleted on failure');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('PPTX export fails closed unless partial output is explicit', async () => {
  const source = await readRepo('scripts', 'export_deck_pptx.mjs');
  assert.match(source, /allow-partial/);
  assert.match(source, /await fs\.rm\(outFile, \{ force: true \}\)/);
  assert.match(source, /PPTX 导出失败，已删除旧输出/);
});

test('video chrome hiding does not target common content class names', async () => {
  for (const file of ['render-video.js', 'render-video-seek.js']) {
    const source = await readRepo('scripts', file);
    const css = chromeHideCss(source);
    assert.doesNotMatch(css, /\.(title|kicker|masthead|footer)\b/);
  }
});

test('seek renderer requires frozen-clock readiness and exact frame output', async () => {
  const source = await readRepo('scripts', 'render-video-seek.js');
  assert.match(source, /Math\.max\(1,\s*Math\.ceil\(FPS \* DURATION\)\)/);
  assert.match(source, /window\.__seekRenderReady === true/);
  assert.match(source, /null,\s*\n\s*\{ timeout: READY_TIMEOUT \* 1000 \}/);
  assert.match(source, /pngCount !== TOTAL_FRAMES/);
  assert.match(source, /'-start_number', '0'/);
  assert.match(source, /fs\.rmSync\(MP4_OUT, \{ force: true \}\)/);
});

test('Stage components announce seek-render readiness only after installing seek', async () => {
  const animations = await readRepo('assets', 'animations.jsx');
  const narration = await readRepo('assets', 'narration_stage.jsx');
  assert.match(animations, /window\.__seek = \(t\) => setTime[\s\S]*window\.__seekRenderReady = true/);
  assert.match(narration, /window\.__seek = \(t\) => setTime[\s\S]*window\.__seekRenderReady = true/);
});

test('voiceover ducking splits voice stream and does not fade out at t=0', async () => {
  const source = await readRepo('scripts', 'mix-voiceover.sh');
  assert.match(source, /asplit=2\[voice_mix\]\[voice_sidechain\]/);
  assert.doesNotMatch(source, /afade=t=out:st=0/);
});
