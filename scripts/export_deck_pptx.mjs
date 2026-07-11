#!/usr/bin/env node
/**
 * export_deck_pptx.mjs — 把多文件 slide deck 导出为可编辑 PPTX
 *
 * 用法：
 *   node export_deck_pptx.mjs --slides <dir> --out <file.pptx> [--index index.html] [--allow-partial]
 *
 * 行为：
 *   - 调用 scripts/html2pptx.js 把 HTML DOM 逐元素翻译成 PowerPoint 原生对象
 *   - 文字是真文本框，PPT 里直接双击能编辑
 *   - body 尺寸 960pt × 540pt（LAYOUT_WIDE，13.333″ × 7.5″）
 *
 * ⚠️ HTML 必须符合 4 条硬约束（见 references/editable-pptx.md）：
 *   1. 文字包在 <p>/<h1>-<h6> 里（div 不能直接放文字）
 *   2. 不用 CSS 渐变
 *   3. <p>/<h*> 不能有 background/border/shadow（放外层 div）
 *   4. div 不能 background-image（用 <img>）
 *
 * 视觉驱动的 HTML 几乎无法 pass —— 必须从写 HTML 的第一行就按约束写。
 * 视觉自由度优先的场景（动画、web component、CSS 渐变、复杂 SVG）
 * 应改用 export_deck_pdf.mjs / export_deck_stage_pdf.mjs 导出 PDF。
 *
 * 依赖：npm install playwright pptxgenjs sharp
 *
 * 默认优先读取 slides 同级 index.html 的 DECK_MANIFEST 顺序；找不到 manifest 时才按文件名排序。
 * 默认任意 slide 转换失败都不写出 PPTX；确需缺页草稿时显式传 --allow-partial。
 */

import pptxgen from 'pptxgenjs';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveDeckEntries } from './deck_manifest.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs() {
  const args = {};
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    const raw = a[i];
    if (!raw.startsWith('--')) {
      console.error(`未知参数: ${raw}`);
      process.exit(1);
    }
    const k = raw.replace(/^--/, '');
    if (k === 'allow-partial') {
      args.allowPartial = true;
      continue;
    }
    const value = a[++i];
    if (!value || value.startsWith('--')) {
      console.error(`参数 ${raw} 需要一个值`);
      process.exit(1);
    }
    args[k] = value;
  }
  if (!args.slides || !args.out) {
    console.error('用法: node export_deck_pptx.mjs --slides <dir> --out <file.pptx> [--index index.html] [--allow-partial]');
    console.error('');
    console.error('⚠️ HTML 必须符合 4 条硬约束（见 references/editable-pptx.md）。');
    console.error('   视觉自由度优先的场景请改用 export_deck_pdf.mjs 导出 PDF。');
    process.exit(1);
  }
  return args;
}

async function main() {
  const { slides, out, index, allowPartial } = parseArgs();
  const slidesDir = path.resolve(slides);
  const outFile = path.resolve(out);

  await fs.rm(outFile, { force: true });
  const entries = await resolveDeckEntries({ slidesDir, indexPath: index });

  console.log(`Converting ${entries.length} slides via html2pptx...`);

  const { createRequire } = await import('module');
  const require = createRequire(import.meta.url);
  let html2pptx;
  try {
    html2pptx = require(path.join(__dirname, 'html2pptx.js'));
  } catch (e) {
    console.error(`✗ 加载 html2pptx.js 失败：${e.message}`);
    console.error(`  依赖缺失时请跑：npm install playwright pptxgenjs sharp`);
    process.exit(1);
  }

  const pres = new pptxgen();
  pres.layout = 'LAYOUT_WIDE';  // 13.333 × 7.5 inch，对应 HTML body 960 × 540 pt

  const errors = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    try {
      await html2pptx(entry.absPath, pres);
      console.log(`  [${i + 1}/${entries.length}] ${entry.displayName} ✓`);
    } catch (e) {
      console.error(`  [${i + 1}/${entries.length}] ${entry.displayName} ✗  ${e.message}`);
      errors.push({ file: entry.displayName, error: e.message });
    }
  }

  if (errors.length) {
    console.error(`\n⚠️ ${errors.length} 张 slide 转换失败。常见原因：HTML 不符合 4 条硬约束。`);
    console.error(`  详见 references/editable-pptx.md 的「常见错误速查」。`);
    if (errors.length === entries.length) {
      console.error(`✗ 全部失败，不生成 PPTX。`);
      process.exit(1);
    }
    if (!allowPartial) {
      console.error(`✗ 默认不生成缺页 PPTX；如确需草稿，请显式传 --allow-partial。`);
      await fs.rm(outFile, { force: true });
      process.exit(1);
    }
    console.error(`⚠️ 已显式允许部分导出，将生成缺 ${errors.length} 页的草稿 PPTX。`);
  }

  await pres.writeFile({ fileName: outFile });
  console.log(`\n✓ Wrote ${outFile}  (${entries.length - errors.length}/${entries.length} slides, 可编辑 PPTX)`);
}

main().catch(e => { console.error(e); process.exit(1); });
