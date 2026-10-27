import path from 'node:path';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { root } from './library.mjs';

export async function browserPath(explicit = process.env.PUPPETEER_EXECUTABLE_PATH) {
  const executable = async file => access(file, constants.X_OK).then(() => true).catch(() => false);
  if (explicit) {
    if (!await executable(explicit)) throw new Error('指定的浏览器文件不存在或不可执行。');
    return explicit;
  }
  const candidates = process.platform === 'darwin' ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    path.join(process.env.HOME || '', 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ] : process.platform === 'linux' ? ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'] : [
    path.join(process.env.PROGRAMFILES || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
  ];
  for (const file of candidates) if (await executable(file)) return file;
  process.env.PUPPETEER_CACHE_DIR = path.join(root, '.browser-cache');
  const { default: puppeteer } = await import('puppeteer');
  let cached;
  try { cached = puppeteer.executablePath(); } catch {}
  if (cached && await executable(cached)) return cached;
  throw new Error('未找到当前平台的 Chrome。请安装 Chrome，或设置 PUPPETEER_EXECUTABLE_PATH。');
}

export async function launchBrowser(explicit) {
  const executablePath = await browserPath(explicit);
  const { default: puppeteer } = await import('puppeteer');
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  return puppeteer.launch({ executablePath, headless: true, args: ['--disable-dev-shm-usage', ...(proxy ? [`--proxy-server=${proxy}`] : [])] });
}
