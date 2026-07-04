import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { listOrderedSlideFiles } from './deck_manifest.mjs';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function makeTempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeSlide(file, body = '<p>Slide</p>') {
  await fs.writeFile(file, `<!doctype html><html><head><style>body{width:1280px;height:720px;margin:0}</style></head><body>${body}</body></html>`);
}

test('deck export order follows DECK_MANIFEST and ignores stray slide files', async () => {
  const root = await makeTempDir('deck-manifest-');
  const slidesDir = path.join(root, 'slides');
  await fs.mkdir(slidesDir);
  await writeSlide(path.join(slidesDir, '1-intro.html'));
  await writeSlide(path.join(slidesDir, '2-middle.html'));
  await writeSlide(path.join(slidesDir, '10-end.html'));
  await writeSlide(path.join(slidesDir, '99-draft.html'));
  await fs.writeFile(path.join(root, 'index.html'), `<!doctype html><script>
    window.DECK_MANIFEST = [
      { file: 'slides/1-intro.html', label: 'Intro' },
      { file: 'slides/2-middle.html', label: 'Middle' },
      { file: 'slides/10-end.html', label: 'End' },
    ];
  </script>`);

  assert.deepEqual(await listOrderedSlideFiles(slidesDir), [
    '1-intro.html',
    '2-middle.html',
    '10-end.html',
  ]);
});

test('deck export order falls back to natural sort without an index manifest', async () => {
  const root = await makeTempDir('deck-natural-');
  await writeSlide(path.join(root, '10-end.html'));
  await writeSlide(path.join(root, '2-middle.html'));
  await writeSlide(path.join(root, '1-intro.html'));

  assert.deepEqual(await listOrderedSlideFiles(root), [
    '1-intro.html',
    '2-middle.html',
    '10-end.html',
  ]);
});

test('deck_index falls back to grid when gallery lacks thumbnails', async () => {
  const root = await makeTempDir('deck-gallery-');
  const slidesDir = path.join(root, 'slides');
  await fs.mkdir(slidesDir);
  const manifest = [];
  for (let i = 1; i <= 12; i++) {
    const name = `${String(i).padStart(2, '0')}.html`;
    await writeSlide(path.join(slidesDir, name), `<p>Slide ${i}</p>`);
    manifest.push(`{ file: 'slides/${name}', label: 'Slide ${i}' }`);
  }

  const template = await fs.readFile(path.join(repoRoot, 'assets/deck_index.html'), 'utf8');
  const html = template.replace(
    /window\.DECK_MANIFEST\s*=\s*\[[\s\S]*?\];/,
    `window.DECK_MANIFEST = [\n${manifest.join(',\n')}\n];`
  );
  await fs.writeFile(path.join(root, 'index.html'), html);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`file://${path.join(root, 'index.html')}?ov=gallery`);
    await page.waitForFunction(() => document.body.getAttribute('data-ov') === 'grid');

    assert.equal(await page.locator('#ov-gallery iframe').count(), 0);
    assert.equal(await page.locator('#ov-grid iframe').count(), 12);
  } finally {
    await browser.close();
  }
});

test('PPTX export fails closed on partial slide conversion failures', async () => {
  const root = await makeTempDir('deck-pptx-partial-');
  const slidesDir = path.join(root, 'slides');
  await fs.mkdir(slidesDir);
  await writeSlide(path.join(slidesDir, '01-valid.html'), '<p>Valid slide</p>');
  await writeSlide(path.join(slidesDir, '02-invalid.html'), '<div>Unwrapped text should fail html2pptx validation</div>');

  const outFile = path.join(root, 'out.pptx');
  await fs.writeFile(outFile, 'stale output must be removed');

  await assert.rejects(
    execFileAsync(process.execPath, [
      path.join(repoRoot, 'scripts/export_deck_pptx.mjs'),
      '--slides', slidesDir,
      '--out', outFile,
    ], {
      cwd: repoRoot,
      env: { ...process.env, NODE_PATH: path.join(repoRoot, 'node_modules') },
      timeout: 30000,
    }),
    /默认禁止生成缺页 PPTX|slide 转换失败/
  );
  await assert.rejects(fs.stat(outFile), { code: 'ENOENT' });
});
