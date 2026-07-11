import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { pathToFileURL, fileURLToPath } from 'url';
import { chromium } from 'playwright';
import { parseDeckManifest, resolveDeckEntries } from './deck_manifest.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function makeTempDeck() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'huashu-deck-'));
  await fs.mkdir(path.join(dir, 'slides'));
  return dir;
}

async function writeSlide(file, body = '<p>Slide</p>') {
  await fs.writeFile(file, `<!doctype html><html><head><meta charset="utf-8"></head><body style="width:960px;height:540px;margin:0">${body}</body></html>`);
}

test('parseDeckManifest accepts the commented object literal used by deck_index.html', () => {
  const manifest = parseDeckManifest(`
    <script>
      window.DECK_MANIFEST = [
        { file: "slides/02.html", label: "Second" /*, thumb: "thumbs/02.jpg" */ },
        // comments and trailing commas are expected in hand-edited decks
        { file: 'slides/01.html', label: 'First', },
      ];
    </script>
  `);

  assert.deepEqual(manifest.map(item => item.file), ['slides/02.html', 'slides/01.html']);
});

test('resolveDeckEntries uses DECK_MANIFEST order instead of filename order', async () => {
  const dir = await makeTempDeck();
  await writeSlide(path.join(dir, 'slides', '01.html'));
  await writeSlide(path.join(dir, 'slides', '02.html'));
  await writeSlide(path.join(dir, 'slides', '10.html'));
  await fs.writeFile(path.join(dir, 'index.html'), `
    <script>
      window.DECK_MANIFEST = [
        { file: "slides/10.html", label: "Ten" },
        { file: "slides/01.html", label: "One" },
      ];
    </script>
  `);

  const entries = await resolveDeckEntries({ slidesDir: path.join(dir, 'slides') });
  assert.deepEqual(entries.map(entry => entry.displayName), ['slides/10.html', 'slides/01.html']);
});

test('deck_index falls back to grid when gallery is forced without complete thumbs', async () => {
  const dir = await makeTempDeck();
  await writeSlide(path.join(dir, 'slides', '01-cover.html'));
  await fs.copyFile(path.join(repoRoot, 'assets', 'deck_index.html'), path.join(dir, 'index.html'));

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  try {
    await page.goto(pathToFileURL(path.join(dir, 'index.html')).href + '?ov=gallery', { waitUntil: 'load' });
    await page.waitForFunction(() => document.body.dataset.mode === 'overview');
    const state = await page.evaluate(() => ({
      overview: document.body.dataset.ov,
      galleryIframes: document.querySelectorAll('#ov-gallery iframe').length,
      gridCards: document.querySelectorAll('#ov-grid .card').length,
    }));

    assert.equal(state.overview, 'grid');
    assert.equal(state.galleryIframes, 0);
    assert.equal(state.gridCards, 1);
  } finally {
    await browser.close();
  }
});

test('export_deck_pptx fails closed on partial conversion errors', async () => {
  const dir = await makeTempDeck();
  await writeSlide(path.join(dir, 'slides', '01.html'), '<p style="font-size:40px">OK</p>');
  await writeSlide(
    path.join(dir, 'slides', '02.html'),
    '<div style="width:100%;height:100%;background:linear-gradient(red, blue)"><p>Invalid for PPTX</p></div>',
  );
  await fs.writeFile(path.join(dir, 'index.html'), `
    <script>
      window.DECK_MANIFEST = [
        { file: "slides/01.html", label: "OK" },
        { file: "slides/02.html", label: "Invalid" },
      ];
    </script>
  `);

  const outFile = path.join(dir, 'deck.pptx');
  const result = spawnSync(process.execPath, [
    path.join(repoRoot, 'scripts', 'export_deck_pptx.mjs'),
    '--slides', path.join(dir, 'slides'),
    '--out', outFile,
  ], {
    cwd: repoRoot,
    env: { ...process.env, NODE_PATH: path.join(repoRoot, 'node_modules') },
    encoding: 'utf8',
  });

  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  await assert.rejects(fs.stat(outFile), { code: 'ENOENT' });
  assert.match(result.stderr, /默认不生成缺页 PPTX/);
});
