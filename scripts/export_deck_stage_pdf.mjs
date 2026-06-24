#!/usr/bin/env node
/**
 * export_deck_stage_pdf.mjs — 单文件 <deck-stage> 架构专用 PDF 导出
 *
 * 用法：
 *   node export_deck_stage_pdf.mjs --html <deck.html> --out <file.pdf> [--width 1920] [--height 1080]
 *
 * 什么时候用这个脚本？
 *   - 你的 deck 是**单 HTML 文件**，所有 slide 是 `<section>`，外层用 `<deck-stage>` 包裹
 *   - 此时 `export_deck_pdf.mjs`（多文件专用）用不上
 *
 * 为什么不能直接 `page.pdf()`（2026-04-20 踩坑记录）：
 *   1. deck-stage 的 shadow CSS `::slotted(section) { display: none }` 让只有 active slide 可见
 *   2. print 媒体下外层 `!important` 压不住 shadow DOM 规则
 *   3. 结果：PDF 永远只有 1 页（active 那张）
 *
 * 解决方案：
 *   打开 HTML 后，用 page.evaluate 把 deck-stage 的 shadow DOM 临时改成
 *   只含 <slot> 的打印外壳，并把所有 section 标记为 active。
 *   这样既绕开 shadow DOM 只显示当前页的规则，又保留 deck-stage > section
 *   和 section.active 这类单页样式选择器。
 *
 * 依赖：playwright
 *   npm install playwright
 *
 * 输出特点：
 *   - 文字保留矢量（可复制、可搜索）
 *   - 视觉 1:1 保真
 *   - 字体必须能被 Chromium 加载（本地字体或 Google Fonts）
 */

import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';

function parseArgs() {
  const args = { width: 1920, height: 1080 };
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i += 2) {
    const k = a[i].replace(/^--/, '');
    args[k] = a[i + 1];
  }
  if (!args.html || !args.out) {
    console.error('用法: node export_deck_stage_pdf.mjs --html <deck.html> --out <file.pdf> [--width 1920] [--height 1080]');
    process.exit(1);
  }
  args.width = parseInt(args.width);
  args.height = parseInt(args.height);
  return args;
}

async function main() {
  const { html, out, width, height } = parseArgs();
  const htmlAbs = path.resolve(html);
  const outFile = path.resolve(out);

  await fs.access(htmlAbs).catch(() => {
    console.error(`HTML file not found: ${htmlAbs}`);
    process.exit(1);
  });

  console.log(`Rendering ${path.basename(htmlAbs)} → ${path.basename(outFile)}`);

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width, height } });
  const page = await ctx.newPage();

  await page.goto('file://' + htmlAbs, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);  // 等 Google Fonts + deck-stage init

  // 核心修复：保留 deck-stage > section 父子关系，只替换 shadow DOM 打印外壳
  const sectionCount = await page.evaluate(({ W, H }) => {
    const stage = document.querySelector('deck-stage');
    if (!stage) throw new Error('<deck-stage> not found — 这个脚本只适用于单文件 deck-stage 架构');
    const sections = Array.from(stage.querySelectorAll(':scope > section'));
    if (!sections.length) throw new Error('No <section> found inside <deck-stage>');
    if (!stage.shadowRoot) throw new Error('<deck-stage> shadowRoot is not open; cannot prepare print export');

    // 注入打印样式
    const style = document.createElement('style');
    style.textContent = `
      @page { size: ${W}px ${H}px; margin: 0; }
      html, body { margin: 0 !important; padding: 0 !important; background: #fff; overflow: visible !important; height: auto !important; }
      deck-stage {
        display: block !important;
        position: static !important;
        width: ${W}px !important;
        height: auto !important;
        background: #fff !important;
        overflow: visible !important;
      }
      deck-stage > section {
        box-sizing: border-box !important;
        width: ${W}px !important;
        height: ${H}px !important;
        position: relative !important;
        overflow: hidden !important;
        page-break-after: always !important;
        break-after: page !important;
        margin: 0 !important;
      }
      deck-stage > section:last-child {
        page-break-after: auto !important;
        break-after: auto !important;
      }
    `;
    document.head.appendChild(style);

    sections.forEach(s => {
      s.classList.add('active');
    });

    stage.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block !important;
          position: static !important;
          background: #fff !important;
          overflow: visible !important;
        }
        ::slotted(section) {
          box-sizing: border-box !important;
          width: ${W}px !important;
          height: ${H}px !important;
          position: relative !important;
          overflow: hidden !important;
          margin: 0 !important;
        }
      </style>
      <slot></slot>
    `;
    return sections.length;
  }, { W: width, H: height });

  await page.waitForTimeout(800);

  await page.pdf({
    path: outFile,
    width: `${width}px`,
    height: `${height}px`,
    printBackground: true,
    preferCSSPageSize: true,
  });

  await browser.close();

  const stat = await fs.stat(outFile);
  const kb = (stat.size / 1024).toFixed(0);
  console.log(`\n✓ Wrote ${outFile}  (${kb} KB, ${sectionCount} pages, vector)`);
  console.log(`  验证页数：mdimport "${outFile}" && pdfinfo "${outFile}" | grep Pages`);
}

main().catch(e => { console.error(e); process.exit(1); });
