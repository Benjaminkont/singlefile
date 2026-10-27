import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir, stat, open, unlink } from 'node:fs/promises';

export const root = path.resolve(process.env.SINGLEFILE_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
export const archives = path.join(root, 'archives');
export const configDir = path.join(root, 'config/sources');
export const option = (name, args = process.argv.slice(2)) => {
  const equal = args.find(a => a.startsWith(name + '='));
  if (equal !== undefined) return equal.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 && !args[index + 1]?.startsWith('--') ? args[index + 1] : undefined;
};

export function webpageUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('请输入完整的 http:// 或 https:// 网页地址。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('只接受不含登录凭据的 HTTP(S) 网页地址。');
  url.hash = '';
  return url.href;
}

export function sourceId(raw) {
  const hostname = new URL(raw.includes('://') ? webpageUrl(raw) : webpageUrl('https://' + raw)).hostname.toLowerCase().replace(/^www\./, '');
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(hostname) || hostname.includes('..')) throw new Error('站点域名无效。');
  return hostname;
}

export function validFile(file) {
  if (typeof file !== 'string' || !/^[a-zA-Z0-9_.-]+\.html$/.test(file) || file === 'index.html' || path.basename(file) !== file) throw new Error('网页文件名无效：' + file);
  return file;
}

export function filenameFor(raw) {
  const url = new URL(webpageUrl(raw));
  const slug = url.pathname.replace(/^\/+|\/+$/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 140) || 'home';
  return `${slug}-${createHash('sha256').update(url.href).digest('hex').slice(0, 10)}.html`;
}

export function paths(id) {
  if (sourceId(id) !== id) throw new Error('请使用规范化站点名：' + sourceId(id));
  const base = path.join(archives, id);
  const records = path.join(base, 'records');
  return { id, base, pages: path.join(base, 'pages'), texts: path.join(base, 'texts'), records,
    reports: path.join(records, 'reports'), metadata: path.join(records, 'metadata'), logs: path.join(records, 'logs'),
    screenshots: path.join(records, 'screenshots'), discovery: path.join(records, 'discovery'),
    report: path.join(records, 'reports/capture-report.json'), summary: path.join(records, 'reports/full-run-summary.json'),
    config: path.join(configDir, id + '.json') };
}

export async function readJSON(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
}

export async function writeJSON(file, value) {
  await atomicWrite(file, JSON.stringify(value, null, 2) + '\n');
}

export async function atomicWrite(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try { await writeFile(temp, content); await rename(temp, file); }
  finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

export const exists = async file => stat(file).then(s => s.isFile()).catch(error => { if (error.code === 'ENOENT') return false; throw error; });

export async function loadSource(id) {
  const config = await readJSON(paths(id).config);
  if (!config.name || sourceId(config.origin) !== id || !Array.isArray(config.targets)) throw new Error('站点配置无效：' + id);
  for (const target of config.targets) { webpageUrl(target.url); validFile(target.file); }
  const files = config.targets.map(t => t.file);
  if (new Set(files).size !== files.length) throw new Error('站点配置包含重复文件名：' + id);
  return { ...config, id };
}

export async function loadSources() {
  const files = await readdir(configDir).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  return Promise.all(files.filter(f => f.endsWith('.json')).sort().map(f => loadSource(f.slice(0, -5))));
}

export async function requireSource() {
  const raw = option('--source');
  if (!raw) {
    const ids = (await loadSources()).map(s => s.id).join(', ') || '暂无；请先添加网页';
    throw new Error(`请指定 --source=<站点>。可用站点：${ids}`);
  }
  return loadSource(sourceId(raw));
}

export async function withLock(file, action, waitMs = 0) {
  await mkdir(path.dirname(file), { recursive: true });
  const started = Date.now();
  while (true) {
    try {
      const handle = await open(file, 'wx');
      await handle.writeFile(String(process.pid));
      await handle.close();
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(await readFile(file, 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; }));
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); }
        catch (probe) {
          if (probe.code === 'ESRCH') { await unlink(file).catch(e => { if (e.code !== 'ENOENT') throw e; }); continue; }
          if (probe.code !== 'EPERM') throw probe;
        }
      }
      if (Date.now() - started >= waitMs) throw new Error(`已有操作正在运行或锁文件需检查：${path.relative(root, file)}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  try { return await action(); }
  finally { await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

export function runMain(action) {
  action().catch(error => { console.error('错误：' + error.message); process.exitCode = 1; });
}
