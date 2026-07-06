#!/usr/bin/env node
// token-usage — 查看 Claude Code session 的 token 消耗明细
// 用法: node scripts/token-usage.js [--session <id>] [--project <name>] [--simple]

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : fallback;
};
const has = (name) => args.includes('--' + name);

const projectsDir = path.join(process.env.HOME || '~', '.claude/projects');

// 解析项目名
const projectName = flag('project', null);
let projectDir;
if (projectName) {
  const dirs = fs.readdirSync(projectsDir);
  const match = dirs.find(d => d.toLowerCase().includes(projectName.toLowerCase()));
  projectDir = match ? path.join(projectsDir, match) : null;
  if (!projectDir) { console.error('项目未找到:', projectName); process.exit(1); }
} else {
  // 自动选当前目录对应的项目
  const cwd = process.cwd().replace(/\\/g, '/').toLowerCase();
  const dirs = fs.readdirSync(projectsDir);
  const match = dirs.find(d => {
    const key = d.replace(/^c--Ai-?/i, '').replace(/-/g, '/').toLowerCase();
    if (!key) return false; // 排除 C--Ai 这种空匹配
    return cwd.includes(key) || key.includes(cwd.split('/').pop()) || cwd.includes(d.toLowerCase());
  });
  projectDir = match ? path.join(projectsDir, match) : path.join(projectsDir, dirs.sort((a,b) => {
    return fs.statSync(path.join(projectsDir,b)).mtimeMs - fs.statSync(path.join(projectsDir,a)).mtimeMs;
  })[0]);
}

// 解析 session
const sessionId = flag('session', null);
let sessionFile;
if (sessionId) {
  const f = path.join(projectDir, sessionId + '.jsonl');
  if (fs.existsSync(f)) sessionFile = f;
  else {
    const files = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl') && f.includes(sessionId));
    if (files.length) sessionFile = path.join(projectDir, files[0]);
    else { console.error('Session 未找到:', sessionId); process.exit(1); }
  }
} else {
  // 选最新的 jsonl（排除子目录）
  const files = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));
  const latest = files.sort((a,b) => {
    return fs.statSync(path.join(projectDir,b)).mtimeMs - fs.statSync(path.join(projectDir,a)).mtimeMs;
  })[0];
  sessionFile = path.join(projectDir, latest);
}

const lines = fs.readFileSync(sessionFile, 'utf8').trim().split('\n');
const entries = [];
let firstTs = null, lastTs = null;

lines.forEach((line, i) => {
  try {
    const d = JSON.parse(line);
    const u = d.message?.usage;
    if (!u) return;
    const inp = u.input_tokens || 0;
    const out = u.output_tokens || 0;
    const cr = u.cache_read_input_tokens || 0;
    const cw = u.cache_creation_input_tokens || 0;
    const ctx = inp + cr;
    const rate = ctx > 0 ? ((cr / ctx) * 100).toFixed(1) : 0;
    const ts = d.timestamp || '';
    if (!firstTs) firstTs = ts;
    lastTs = ts;
    entries.push({
      line: i + 1,
      timestamp: ts.replace('T',' ').replace('Z',''),
      model: d.message?.model || '?',
      input: inp,
      output: out,
      cacheRead: cr,
      cacheWrite: cw,
      ctxTotal: ctx,
      hitRate: parseFloat(rate)
    });
  } catch(e) {}
});

const simple = has('simple');
const tIn = entries.reduce((s,e) => s + e.input, 0);
const tOut = entries.reduce((s,e) => s + e.output, 0);
const tCr = entries.reduce((s,e) => s + e.cacheRead, 0);

console.log('Session: ' + path.basename(sessionFile, '.jsonl'));
console.log('项目:    ' + path.basename(projectDir));
console.log('时间:    ' + firstTs + ' ~ ' + lastTs);
console.log('模型:    ' + (entries[0]?.model || '?'));
console.log('');

if (simple) {
  console.log('in=' + tIn + ' out=' + tOut + ' cache_read=' + tCr + ' total=' + (tIn + tOut));
} else {
  console.log(' #  | 时间              | 新input | output | 缓存命中 | 上下文总量 | 命中率');
  console.log('-'.repeat(80));
  entries.forEach((e,i) => {
    console.log(
      String(i+1).padStart(2) + ' | ' +
      e.timestamp.substring(11, 19) + ' | ' +
      String(e.input).padStart(7) + ' | ' +
      String(e.output).padStart(6) + ' | ' +
      String(e.cacheRead).padStart(8) + ' | ' +
      String(e.ctxTotal).padStart(9) + ' | ' +
      String(e.hitRate.toFixed(1)).padStart(5) + '%'
    );
  });
  console.log('-'.repeat(80));
  console.log('累计 |                  | ' +
    String(tIn).padStart(7) + ' | ' +
    String(tOut).padStart(6) + ' | ' +
    String(tCr).padStart(8) + ' | ' +
    String(tIn + tCr).padStart(9) + ' |');
  console.log('');
  console.log('实际消耗: ' + (tIn + tOut).toLocaleString() + ' tokens (input + output)');
  console.log('缓存命中: ' + tCr.toLocaleString() + ' tokens (不计费)');
}
