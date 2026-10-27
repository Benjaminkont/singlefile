import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { addPage } from './capture.mjs';
import { option, runMain } from './library.mjs';

runMain(async () => {
  let url = process.argv[2];
  if (!url || url.startsWith('--')) {
    if (!process.argv.includes('--prompt')) throw new Error('用法：npm run add -- <网页地址> [--refresh] [--dry-run]');
    const input = createInterface({ input: stdin, output: stdout });
    try { url = (await input.question('粘贴要保存的网页地址（留空取消）：')).trim(); }
    finally { input.close(); }
    if (!url) { console.log('已取消。'); return; }
  }
  await addPage(url, { refresh: process.argv.includes('--refresh'), dryRun: process.argv.includes('--dry-run'), browser: option('--browser') });
});
