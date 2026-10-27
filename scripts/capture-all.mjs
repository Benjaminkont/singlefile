import { option, requireSource, runMain } from './library.mjs';
import { captureSource } from './capture.mjs';

runMain(async () => {
  const source = await requireSource();
  await captureSource(source.id, { only: option('--only'), refresh: process.argv.includes('--refresh'),
    dryRun: process.argv.includes('--dry-run'), concurrency: option('--concurrency'), browser: option('--browser') });
});
