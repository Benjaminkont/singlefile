import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, writeFile, readFile, rm, access, symlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = await mkdtemp(path.join(tmpdir(), 'singlefile test-'));
process.env.SINGLEFILE_ROOT = fixture;
const { sourceId, filenameFor, webpageUrl, paths, readJSON, withLock } = await import('../scripts/library.mjs');
const { prepare } = await import('../scripts/prepare-preview.mjs');
const { addPage } = await import('../scripts/capture.mjs');
const { rewriteLinks } = await import('../scripts/relink.mjs');
const { createPreviewServer, libraryId } = await import('../scripts/preview.mjs');
const environment = { ...process.env, SINGLEFILE_ROOT: fixture, PUPPETEER_EXECUTABLE_PATH: '/nonexistent/browser-for-regression-test' };

beforeEach(async () => {
  await rm(fixture, { recursive: true, force: true });
  await mkdir(path.join(fixture, 'config/sources'), { recursive: true });
  await mkdir(path.join(fixture, 'archives'));
});
after(() => rm(fixture, { recursive: true, force: true }));

async function seed(id, records, targets = records.map(({ url, file }) => ({ url, file }))) {
  const p = paths(id);
  await mkdir(p.pages, { recursive: true });
  await mkdir(p.reports, { recursive: true });
  await writeFile(p.config, JSON.stringify({ name: id, origin: 'https://' + id, targets }));
  await writeFile(p.report, JSON.stringify(records));
  for (const record of records.filter(r => r.ok && !r.missing)) await writeFile(path.join(p.pages, record.file), '<html><body>' + 'Saved text. '.repeat(40) + '</body></html>');
}

test('URL-derived sites and filenames preserve URL distinctions and reject non-web input', () => {
  assert.equal(sourceId('https://www.Anthropic.com/research/test'), 'anthropic.com');
  assert.equal(webpageUrl('https://example.org/a?x=1#part'), 'https://example.org/a?x=1');
  assert.notEqual(filenameFor('https://example.org/a?x=1'), filenameFor('https://example.org/a?x=2'));
  assert.throws(() => webpageUrl('javascript:alert(1)'));
  assert.throws(() => webpageUrl('https://user:secret@example.org/'));
  assert.throws(() => sourceId('../escape'));
});

test('index combines sites, escapes titles, and excludes failed or missing snapshots', async () => {
  await seed('example.org', [
    { url: 'https://example.org/a', file: 'a.html', ok: true, title: '<script>alert(1)</script>', bytes: 1000 },
    { url: 'https://example.org/b', file: 'b.html', ok: false },
    { url: 'https://example.org/c', file: 'c.html', ok: true, missing: true },
  ]);
  await seed('anthropic.com', [{ url: 'https://www.anthropic.com/article', file: 'article.html', ok: true, bytes: 2000 }]);
  assert.deepEqual(await prepare(), { sources: 2, successful: 2, failed: 1 });
  const global = await readFile(path.join(fixture, 'archives/index.html'), 'utf8');
  assert.match(global, /anthropic\.com\/pages\/article\.html/);
  assert.match(global, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(global, /href="example\.org\/pages\/(b|c)\.html"/);
  assert.match(await readFile(path.join(paths('example.org').base, 'index.html'), 'utf8'), /href="pages\/a\.html"/);
});

test('dry-run and invalid input do not create a source or invoke a browser', async () => {
  const plan = await addPage('https://www.anthropic.com/research/test', { dryRun: true });
  assert.equal(plan.source, 'anthropic.com');
  assert.equal(plan.remaining, 1);
  await assert.rejects(access(paths('anthropic.com').config));
  await assert.rejects(access(paths('anthropic.com').base));
  await assert.rejects(addPage('file:///etc/passwd'));
  await assert.rejects(exec(process.execPath, [path.join(project, 'scripts/capture-all.mjs')], { env: environment }), error => error.code === 1 && error.stderr.includes('--source'));
});

test('adding an existing URL with an anchor reuses the snapshot without browser or network', async () => {
  await seed('example.org', [{ url: 'https://example.org/a', file: 'legacy-name.html', ok: true, bytes: 512 }]);
  const before = await readFile(path.join(paths('example.org').pages, 'legacy-name.html'));
  const result = await addPage('https://example.org/a#section');
  assert.equal(result.attempted, 0);
  assert.equal((await readJSON(paths('example.org').config)).targets.length, 1);
  assert.deepEqual(await readFile(path.join(paths('example.org').pages, 'legacy-name.html')), before);
});

test('browser startup failure records the failed new page and preserves a previous successful snapshot', async () => {
  await seed('example.org', [{ url: 'https://example.org/a', file: 'a.html', ok: true, bytes: 512 }]);
  const p = paths('example.org'), before = await readFile(path.join(p.pages, 'a.html'));
  await assert.rejects(exec(process.execPath, [path.join(project, 'scripts/capture-all.mjs'), '--source=example.org', '--refresh'], { env: environment }), error => error.code === 1);
  assert.deepEqual(await readFile(path.join(p.pages, 'a.html')), before);
  assert.equal((await readJSON(p.report))[0].ok, true);
  await assert.rejects(exec(process.execPath, [path.join(project, 'scripts/add-page.mjs'), 'https://new.example/article'], { env: environment }), error => error.code === 1);
  const failed = await readJSON(paths('new.example').report);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].ok, false);
  assert.match(failed[0].error, /浏览器/);
});

test('discovery merge keeps legacy filenames and adds only new URL targets', async () => {
  await seed('example.org', [{ url: 'https://example.org/a', file: 'legacy.html', ok: true }]);
  await mkdir(paths('example.org').discovery, { recursive: true });
  await writeFile(path.join(paths('example.org').discovery, 'crawl-targets.json'), JSON.stringify([
    { url: 'https://example.org/a', file: 'new-name-for-same-page.html' }, { url: 'https://example.org/b', file: 'b.html' },
  ]));
  await exec(process.execPath, [path.join(project, 'scripts/merge-discovery.mjs'), '--source=example.org'], { env: environment });
  const targets = (await readJSON(paths('example.org').config)).targets;
  assert.deepEqual(targets.map(t => t.file), ['legacy.html', 'b.html']);
});

test('link rewriting retains existing local links and resolves archived cross-site links with anchors', () => {
  const mapping = new Map([['https://www.anthropic.com/article', path.join(fixture, 'archives/anthropic.com/pages/article.html')]]);
  const original = '<a href="peer.html#part">peer</a><a href="https://www.anthropic.com/article#figure">figure</a><a href="https://not-saved.example/">online</a>';
  const result = rewriteLinks(original, { url: 'https://example.org/' }, mapping, paths('example.org').pages);
  assert.match(result.html, /href="peer\.html#part"/);
  assert.match(result.html, /href="\.\.\/\.\.\/anthropic\.com\/pages\/article\.html#figure"/);
  assert.equal(rewriteLinks(result.html, { url: 'https://example.org/' }, mapping, paths('example.org').pages).changed, 0);
});

test('source lock prevents concurrent writes', async () => {
  const lock = path.join(paths('example.org').reports, '.capture.lock');
  await withLock(lock, async () => {
    await assert.rejects(withLock(lock, () => assert.fail('must not run')), /已有操作/);
    assert.equal(await readFile(lock, 'utf8'), String(process.pid));
  });
  await assert.rejects(access(lock));
});

test('preview serves snapshots, reuses its own server, rejects conflicts and hides records', async () => {
  await seed('example.org', [{ url: 'https://example.org/a', file: 'a.html', ok: true }]);
  await prepare();
  const server = createPreviewServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port, base = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await fetch(base + '/__library_health').then(r => r.json())).libraryId, libraryId);
    assert.equal((await fetch(base + '/example.org/pages/a.html')).status, 200);
    assert.equal((await fetch(base + '/example.org/records/reports/capture-report.json')).status, 404);
    await symlink(path.join(paths('example.org').reports, 'capture-report.json'), path.join(paths('example.org').pages, 'records.html'));
    assert.equal((await fetch(base + '/example.org/pages/records.html')).status, 403);
    await writeFile(path.join(fixture, 'outside.html'), 'private');
    await symlink(path.join(fixture, 'outside.html'), path.join(paths('example.org').pages, 'outside.html'));
    assert.equal((await fetch(base + '/example.org/pages/outside.html')).status, 403);
    const reused = await exec(path.join(project, 'run/打开资料库.command'), ['--no-open', '--port=' + port], { env: environment, cwd: tmpdir() });
    assert.match(reused.stdout, /复用已运行/);
    const updated = await exec(path.join(project, 'run/更新目录.command'), [], { env: environment, cwd: tmpdir() });
    assert.match(updated.stdout, /目录已更新/);
    const add = await exec(path.join(project, 'run/添加网页.command'), ['https://another.example/article', '--dry-run'], { env: environment, cwd: tmpdir() });
    assert.match(add.stdout, /another\.example/);
    await assert.rejects(access(paths('another.example').config));
    const cancelled = exec(path.join(project, 'run/添加网页.command'), [], { env: environment, cwd: tmpdir() });
    cancelled.child.stdin.end('\n');
    assert.match((await cancelled).stdout, /已取消/);
    const bin = path.join(fixture, 'bin');
    await mkdir(bin);
    await writeFile(path.join(bin, 'open'), '#!/bin/sh\nprintf "%s" "$1" > "$SINGLEFILE_ROOT/opened-url"\n', { mode: 0o755 });
    await exec(path.join(project, 'run/打开资料库.command'), ['--port=' + port], {
      env: { ...environment, PATH: bin + ':' + process.env.PATH }, cwd: tmpdir(),
    });
    assert.equal(await readFile(path.join(fixture, 'opened-url'), 'utf8'), base + '/');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  const other = createPreviewServer(path.join(fixture, 'archives'), 'different-library');
  await new Promise(resolve => other.listen(port, '127.0.0.1', resolve));
  try {
    await assert.rejects(exec(process.execPath, [path.join(project, 'scripts/preview.mjs'), '--no-open', '--port=' + port], { env: environment }), error => error.code === 1 && error.stderr.includes('已被其他程序占用'));
  } finally { other.closeAllConnections(); await new Promise(resolve => other.close(resolve)); }
});
