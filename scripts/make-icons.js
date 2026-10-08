// Regenerates the PNG app icons from public/icons/icon.svg.
// Needs Playwright (dev-only): `npx playwright` or a global install.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
const svg = fs.readFileSync(path.join(dir, 'icon.svg'), 'utf8');
// Maskable icons need a full-bleed background with the artwork inside the 80% safe zone.
const maskableSvg = svg
  .replace(/<rect[^>]*\/>/, '<rect width="512" height="512" fill="#ff5a1f"/><g transform="translate(51.2 51.2) scale(0.8)">')
  .replace('</svg>', '</g></svg>');

const targets = [
  ['icon-192.png', svg, 192],
  ['icon-512.png', svg, 512],
  ['icon-maskable-512.png', maskableSvg, 512],
];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage();
for (const [file, source, size] of targets) {
  await page.setViewportSize({ width: size, height: size });
  const html = `<html><body style="margin:0;background:transparent">${source.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`;
  await page.setContent(html);
  await page.screenshot({ path: path.join(dir, file), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  console.log('wrote', file);
}
await browser.close();
