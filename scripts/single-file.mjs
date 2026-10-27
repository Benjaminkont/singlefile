#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { root, atomicWrite, option, runMain } from './library.mjs';
import { browserPath } from './browser.mjs';

runMain(async () => {
  const args = process.argv.slice(2);
  const informational = args.some(arg => ['--help', '--version'].includes(arg));
  const executable = informational ? undefined : await browserPath(option('--browser-executable-path', args));
  const defaults = informational ? [] : [
    `--browser-executable-path=${executable}`, '--browser-width=1440', '--browser-height=1000',
    '--browser-wait-until=networkAlmostIdle', '--browser-wait-delay=25000', '--browser-load-max-time=60000',
    '--browser-capture-max-time=120000', '--browser-arg=--disable-dev-shm-usage', '--block-scripts=false',
    `--browser-script=${path.join(root, 'scripts/warm-page.js')}`, '--remove-hidden-elements=false',
    '--remove-unused-styles=false', '--remove-alternative-medias=false', '--load-deferred-content-min-zoom-factor=1',
  ];
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (!informational && proxy && !args.some(arg => arg.startsWith('--http-proxy-server'))) defaults.push(`--http-proxy-server=${proxy}`);
  const child = spawn(process.execPath, [path.join(root, 'node_modules/single-file-cli/single-file-node.js'), ...defaults, ...args], { stdio: 'inherit' });
  const stop = signal => child.kill(signal);
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    process.exitCode = code ?? 1;
    const output = args[1];
    if (code === 0 && output && !output.startsWith('--') && output.endsWith('.html')) {
      const html = await readFile(output, 'utf8');
      const snapshot = html.replace(/<script\b([^>]*)>[\s\S]*?<\/script\s*>/gi, (tag, attrs) =>
        /\btype\s*=\s*["']?application\/(?:ld\+)?json\b/i.test(attrs) ? tag : '');
      await atomicWrite(output, snapshot);
    }
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
});
