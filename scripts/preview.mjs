import http from 'node:http';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { root, archives, exists, option, runMain } from './library.mjs';
import { prepare } from './prepare-preview.mjs';

export const libraryId = createHash('sha256').update(root).digest('hex');

export function createPreviewServer(directory = archives, id = libraryId) {
  return http.createServer(async (request, response) => {
    try {
      const rawPath = new URL(request.url, 'http://127.0.0.1').pathname;
      if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405).end(); return; }
      if (rawPath === '/__library_health') {
        response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ libraryId: id })); return;
      }
      const pathname = decodeURIComponent(rawPath);
      const relative = pathname.endsWith('/') ? pathname + 'index.html' : pathname;
      // Only reading entries/snapshots/texts is exposed, never capture records or config.
      if (!/^\/(?:index\.html|[a-z0-9.-]+\/(?:index\.html|pages\/[a-zA-Z0-9_.-]+\.html|texts\/[a-zA-Z0-9_.-]+\.txt))$/.test(relative)) {
        response.writeHead(404).end('Not found'); return;
      }
      const base = await realpath(directory);
      const file = await realpath(path.join(base, relative));
      const actual = '/' + path.relative(base, file).split(path.sep).join('/');
      if (!file.startsWith(base + path.sep) || !/^\/(?:index\.html|[a-z0-9.-]+\/(?:index\.html|pages\/[a-zA-Z0-9_.-]+\.html|texts\/[a-zA-Z0-9_.-]+\.txt))$/.test(actual)) { response.writeHead(403).end(); return; }
      const info = await stat(file);
      if (!info.isFile()) { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
        'Content-Length': info.size, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      if (request.method === 'HEAD') { response.end(); return; }
      const stream = createReadStream(file);
      stream.on('error', () => response.destroy());
      response.on('close', () => stream.destroy());
      stream.pipe(response);
    } catch (error) {
      const status = error.code === 'ENOENT' ? 404 : error instanceof URIError ? 400 : 500;
      if (!response.headersSent) response.writeHead(status);
      response.end(status === 404 ? 'Not found' : 'Unable to read file');
    }
  });
}

async function openUrl(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
  try {
    const child = spawn(command, [url], { stdio: 'ignore' });
    await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error('Browser opener failed'))); });
  } catch { console.log('未能自动打开浏览器，请手动访问：' + url); }
}

export async function preview({ port = 8765, openBrowser = true } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口须为 1–65535。');
  const url = `http://127.0.0.1:${port}/`;
  let existing;
  try { existing = await fetch(url + '__library_health', { signal: AbortSignal.timeout(1000) }).then(r => r.json()); } catch {}
  if (existing?.libraryId === libraryId) {
    console.log('复用已运行的资料库服务：' + url);
    if (openBrowser) await openUrl(url);
    return;
  }
  if (!await exists(path.join(archives, 'index.html'))) await prepare();
  const server = createPreviewServer();
  await new Promise((resolve, reject) => {
    server.once('error', error => reject(new Error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被其他程序占用；请关闭对应程序，或使用 --port=<其他端口>。` : error.message)));
    server.listen(port, '127.0.0.1', resolve);
  });
  console.log(`资料库已打开：${url}\n保持此终端运行；按 Ctrl+C 停止服务。`);
  const stop = () => { server.close(); server.closeAllConnections(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  server.once('close', () => { process.off('SIGINT', stop); process.off('SIGTERM', stop); });
  if (openBrowser) await openUrl(url);
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runMain(() => preview({
  port: Number(option('--port') || 8765), openBrowser: !process.argv.includes('--no-open'),
}));
