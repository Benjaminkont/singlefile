import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdir, rename, stat } from 'node:fs/promises';
import { root, paths, webpageUrl, sourceId, filenameFor, loadSource, readJSON, writeJSON, atomicWrite, exists, withLock } from './library.mjs';
import { launchBrowser } from './browser.mjs';
import { inspectPage } from './inspect-page.mjs';
import { prepare } from './prepare-preview.mjs';
import { relink } from './relink.mjs';

function settings(options) {
  const concurrency = Number(options.concurrency || 2);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 12) throw new Error('并发数须为 1–12。');
  return { ...options, concurrency };
}

async function captureOne(browser, id, target, children, explicitBrowser) {
  const p = paths(id);
  const started = new Date().toISOString();
  const staging = path.join(p.records, 'staging', `${process.pid}-${target.file}`);
  await mkdir(path.dirname(staging), { recursive: true });
  const child = spawn(process.execPath, [path.join(root, 'scripts/single-file.mjs'), target.url, staging,
    '--filename-conflict-action=overwrite', '--dump-json', '--errors-file=' + path.join(p.logs, target.file + '.errors.log'),
    ...(explicitBrowser ? ['--browser-executable-path=' + explicitBrowser] : [])],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let stdout = '', stderr = '', timedOut = false;
  child.stdout.on('data', data => stdout += data);
  child.stderr.on('data', data => stderr += data);
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 240000);
  const killTimer = setTimeout(() => child.kill('SIGKILL'), 255000);
  let exitCode;
  try { exitCode = await new Promise(resolve => { child.once('error', e => { stderr += e.message; resolve(-1); }); child.once('close', resolve); }); }
  finally { clearTimeout(timer); clearTimeout(killTimer); children.delete(child); }
  await atomicWrite(path.join(p.logs, target.file + '.capture.log'), stderr);
  let metadata;
  try { metadata = JSON.parse(stdout); } catch {}
  if (metadata) await writeJSON(path.join(p.metadata, target.file + '.metadata.json'), metadata);
  const bytes = await stat(staging).then(s => s.size).catch(() => 0);
  const result = { ...target, started, finished: new Date().toISOString(), finalUrl: metadata?.request?.url,
    title: metadata?.title || target.title, exitCode, httpStatus: metadata?.response?.status, bytes,
    ok: exitCode === 0 && metadata?.response?.status === 200 && bytes > 1000 };
  const retryAfter = metadata?.response?.headers?.find(h => h.name.toLowerCase() === 'retry-after')?.value;
  if (retryAfter) result.retryAfter = retryAfter;
  if (result.ok) {
    try {
      const { text, ...offline } = await inspectPage(browser, staging);
      result.offline = offline;
      result.ok = offline.offlineOk;
      if (result.ok) {
        await rename(staging, path.join(p.pages, target.file));
        await atomicWrite(path.join(p.texts, target.file.replace(/\.html$/, '.txt')), text);
      }
    } catch (error) { result.ok = false; result.verificationError = error.message; }
  }
  if (!result.ok) {
    result.error = timedOut ? 'Capture timed out' : result.verificationError || (result.offline?.challenge ? 'Challenge page' : 'HTTP/content/capture failure; see capture log');
    if (await exists(staging)) {
      const failed = path.join(p.records, 'failed', target.file);
      await mkdir(path.dirname(failed), { recursive: true });
      await rename(staging, failed);
    }
  }
  return result;
}

async function runCapture(source, options) {
  const p = paths(source.id), opts = settings(options);
  const selected = opts.only ? source.targets.filter(t => t.file === opts.only) : source.targets;
  if (!selected.length) throw new Error('没有匹配的抓取目标。');
  let records = await readJSON(p.report, []);
  const pending = [];
  for (const t of selected) if (opts.refresh || !records.some(r => r.file === t.file && r.ok) || !await exists(path.join(p.pages, t.file))) pending.push(t);
  const plan = { source: source.id, total: source.targets.length, selected: selected.length, reusable: selected.length - pending.length, remaining: pending.length, concurrency: opts.concurrency };
  if (opts.dryRun) { console.log(JSON.stringify(plan, null, 2)); return plan; }
  for (const dir of [p.pages, p.texts, p.reports, p.metadata, p.logs]) await mkdir(dir, { recursive: true });
  let browser, stopped = false, cursor = 0, attempts = 0, runFailures = 0, phase = 'running', cooldownUntil = 0, runError;
  const children = new Set();
  const stop = () => { stopped = true; for (const child of children) child.kill('SIGTERM'); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  const started = new Date().toISOString();
  let queue = Promise.resolve();
  const save = () => {
    const rows = source.targets.map(t => records.find(r => r.file === t.file)).filter(Boolean);
    const successful = rows.filter(r => r.ok).length, failed = rows.filter(r => !r.ok).length;
    const summary = { source: source.id, started, updated: new Date().toISOString(), phase, pid: process.pid, concurrency: opts.concurrency,
      total: source.targets.length, successful, failed, pending: source.targets.length - successful - failed, attemptsThisRun: attempts,
      cooldownUntil: cooldownUntil > Date.now() ? new Date(cooldownUntil).toISOString() : null, error: runError };
    queue = queue.then(async () => { await writeJSON(p.report, rows); await writeJSON(p.summary, summary); });
    return queue;
  };
  try {
    console.log(`抓取 ${source.id}：${pending.length} 个待处理，${plan.reusable} 个复用。`);
    // Opening/adding an existing successful page needs neither browser nor network.
    if (pending.length) browser = await launchBrowser(opts.browser);
    await Promise.all(Array.from({ length: Math.min(opts.concurrency, pending.length) }, async () => {
      while (!stopped && cursor < pending.length) {
        const target = pending[cursor++];
        let result;
        for (let attempt = 1; attempt <= 2 && !stopped; attempt++) {
          while (!stopped && Date.now() < cooldownUntil) await new Promise(resolve => setTimeout(resolve, Math.min(1000, cooldownUntil - Date.now())));
          if (stopped) break;
          attempts++;
          console.log(`保存 ${target.url}（第 ${attempt} 次）`);
          result = await captureOne(browser, source.id, target, children, opts.browser);
          result.attempts = attempt;
          const prior = records.find(r => r.file === target.file);
          // A failed refresh must not replace a readable archived snapshot.
          const stored = !result.ok && prior?.ok && await exists(path.join(p.pages, prior.file)) ? { ...prior, lastAttempt: result } : result;
          records = records.filter(r => r.file !== target.file); records.push(stored);
          const blocked = result.httpStatus === 429 || result.httpStatus === 403 || result.offline?.challenge;
          if (blocked) {
            const seconds = Number(result.retryAfter);
            cooldownUntil = Math.max(cooldownUntil, Date.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : Math.max(0, Date.parse(result.retryAfter || '') - Date.now()) || 60000));
          }
          await save();
          console.log(`${result.ok ? 'SAVED' : 'FAILED'} ${target.file} HTTP=${result.httpStatus ?? '?'} offline=${result.offline?.offlineOk ?? false}`);
          if (result.ok || (result.httpStatus >= 400 && result.httpStatus < 500 && !blocked)) break;
        }
        if (!result?.ok) runFailures++;
        if (result?.ok) {
          const rewritten = await relink(source.id, target.file, { updateReport: false });
          const row = records.find(r => r.file === target.file);
          row.bytes = (await stat(path.join(p.pages, target.file))).size;
          row.localLinksRewritten = (row.localLinksRewritten || 0) + rewritten;
          await save();
          await prepare();
        }
      }
    }));
    phase = stopped ? 'interrupted' : runFailures || records.some(r => !r.ok) ? 'finished_with_failures' : 'complete';
    await save();
    await prepare();
    if (stopped || runFailures) process.exitCode = 1;
    return { ...plan, phase, attempted: attempts, failedThisRun: runFailures };
  } catch (error) {
    phase = 'error'; runError = error.message;
    for (const target of pending) {
      if (!records.some(r => r.file === target.file)) records.push({ ...target, ok: false, exitCode: -1, error: runError, finished: new Date().toISOString() });
    }
    await save();
    throw error;
  }
  finally {
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    if (browser) await browser.close();
    await queue;
  }
}

export async function captureSource(id, options = {}) {
  const opts = settings(options);
  if (opts.dryRun) return runCapture(await loadSource(id), opts);
  return withLock(path.join(paths(id).reports, '.capture.lock'), async () => runCapture(await loadSource(id), opts));
}

export async function addPage(raw, options = {}) {
  const url = webpageUrl(raw), id = sourceId(url), p = paths(id);
  const add = async () => {
    const stored = await readJSON(p.config, null);
    const config = stored ? await loadSource(id) : { id, name: id, origin: new URL(url).origin, targets: [] };
    const prior = config.targets.find(t => [t.url, ...(t.aliases || [])].some(u => webpageUrl(u) === url));
    const target = prior || { url, file: filenameFor(url) };
    if (!prior) config.targets.push(target);
    if (!options.dryRun) {
      const { id: ignored, ...data } = config;
      await writeJSON(p.config, data);
    }
    return runCapture(config, { ...options, only: target.file, concurrency: 1 });
  };
  return options.dryRun ? add() : withLock(path.join(p.reports, '.capture.lock'), add);
}
