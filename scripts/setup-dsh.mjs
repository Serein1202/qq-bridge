#!/usr/bin/env node
// setup-dsh.mjs — 在目标设备上安装 qq-bridge 的 DSH 端配置
//
// 功能：
//   1. 安装两套 agent preset：qq-chat、qq-chat-v2
//      （DSH 0.1.7 机制：作为 qq-agent-presets bundle 的 patch 层插入
//        @deepseek-ai/dsh-agent-preset 行；~/.dsh/.agent-presets/ 目录已不再被读取）
//   2. 在 DSH profile 的 cordis.patch.yml 中挂载 MCP server：
//      · mcp-snowluma / mcp-snowluma-host / mcp-web-search-safe —— 桥接必需，无条件写入；
//      · mcp-phone / mcp-companion / mcp-qzone —— 高权限，**默认全部写入**；
//        如需只开部分子集可用 --enable=phone,companion,qzone 指定（详见 mcpEntries 上方注释）。
//   3. 在 profile package.json 中注册两个 bundle：qq-mode-console、qq-agent-presets
//
// 用法：
//   node scripts/setup-dsh.mjs [profile]                     # 默认挂载全部高权限 MCP
//   node scripts/setup-dsh.mjs [profile] --enable=phone      # 只挂指定子集
//   等价环境变量：QQ_BRIDGE_ENABLE_MCP=phone,companion,qzone
//
// 默认 profile 为 web；可用环境变量 DSH_HOME 指定 DSH 根目录。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
import { BUNDLE_DIR, PRESETS, buildPatches, patchFileFor } from './build-agent-preset-patches.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
// `--enable=...` 这类开关不再是位置参数，先摘出去，否则会被当成 profile 名
// （历史 bug：profile 名校验不含 `=`，于是会去建 ~/.dsh/profiles/--enable=phone 这种目录）。
const ARGV = process.argv.slice(2);
const PROFILE = ARGV.filter((a) => !a.startsWith('--'))[0] || 'web';

// A profile is a directory name, never a path (same boundary as DSH itself).
if (PROFILE === '.' || PROFILE === '..' || PROFILE === 'node_modules'
    || /[\\/\x00-\x1f<>:"|?*]/.test(PROFILE) || /[. ]$/.test(PROFILE)) {
  fatal(`invalid profile name: ${JSON.stringify(PROFILE)}`);
}

function log(msg) {
  console.log(`[setup-dsh] ${msg}`);
}

function fatal(msg) {
  console.error(`[setup-dsh] ERROR: ${msg}`);
  process.exit(1);
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

/**
 * 备份一个即将被覆盖的文件。
 *
 * 为什么不用 `flag: 'wx'`（写一次就永不更新）：那样第一次安装会留下一个备份，
 * 之后每次 setup 都静默跳过 —— 用户后来手工改过的内容再被覆盖时，桌上那份备份
 * 早已过期，等于「有备份但救不回来」。改为每次覆盖前打时间戳快照，只保留最近 N 份。
 */
function backupBeforeOverwrite(file, keep = 5) {
  if (!fs.existsSync(file)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = `${file}.bak-${stamp}`;
  try {
    fs.copyFileSync(file, dest);
  } catch (error) {
    log(`⚠️ 备份失败（${file}）：${error?.message ?? error}；继续但请自行确认原内容`);
    return null;
  }
  try {
    const dir = path.dirname(file);
    const prefix = `${path.basename(file)}.bak-`;
    const snaps = fs.readdirSync(dir).filter((f) => f.startsWith(prefix)).sort();
    // 时间戳升序 ⇒ 前面的是最旧的，只保留最后 keep 份
    for (const f of snaps.slice(0, Math.max(0, snaps.length - keep))) {
      fs.rmSync(path.join(dir, f), { force: true });
    }
  } catch {}
  return dest;
}

// ── agent preset：DSH 0.1.7 机制 ─────────────────────────────────────────────
//
// 0.1.5：preset 是 ~/.dsh/.agent-presets/<preset>/ 下的目录，DSH 启动时扫目录装载。
// 0.1.7：注册表既不扫目录也不接受 preset 路径；preset 是一条普通 loader 行
//        （@deepseek-ai/dsh-agent-preset，config.plugins 内联子行列表），
//        由 bundle 的 patch 文件插入。因此这里做两件事：
//          ① 把 qq-agent-presets bundle 注册进 profile（link: 依赖 + bundles + junction）；
//          ② 从仓库权威源（dsh/agent-presets/<preset>/）重新生成 patch 文件。
//        旧目录不再写入、也不删除（见 reportLegacyPresetDir）。
const BUNDLE_NAMES = ['qq-mode-console', 'qq-agent-presets'];

/** 从仓库源重新生成 bundle 里的 patch 文件（人格正文/工具面改了就必须重跑）。 */
function regeneratePresetPatches() {
  const results = buildPatches({ log: () => {} });
  for (const { file, changed } of results) {
    log(`preset patch ${changed ? '已生成' : '已是最新'}: ${path.relative(REPO_ROOT, file)}`);
  }
  for (const name of PRESETS) {
    const file = patchFileFor(name);
    if (!fs.existsSync(file)) fatal(`preset patch 未生成：${file}`);
  }
}

/**
 * 旧机制的安装目录：0.1.7 起 DSH 完全不再读它。
 *
 * 这里**只报告、不删除**——里面可能是用户手改过的人设（仓库源文件救不回来）。
 * 顺带对比仓库源：一致说明没丢东西，不一致说明用户改的那份已不再生效，需要人工合并。
 */
function reportLegacyPresetDir() {
  const legacy = path.join(DSH_HOME, '.agent-presets');
  if (!fs.existsSync(legacy)) return;
  log(`注意：${legacy} 是 DSH 0.1.5 的 preset 安装目录，0.1.7 起不再被读取（保留未删，可自行备份后清理）`);
  for (const name of PRESETS) {
    const installed = path.join(legacy, name, 'agent.cordis.yml');
    if (!fs.existsSync(installed)) continue;
    const source = path.join(REPO_ROOT, 'dsh', 'agent-presets', name, 'agent.cordis.yml');
    const same = fs.existsSync(source) && fs.readFileSync(installed, 'utf8') === fs.readFileSync(source, 'utf8');
    log(same
      ? `  · ${name}：旧目录副本与仓库源一致（无内容丢失）`
      : `  ⚠️ ${name}：旧目录副本与仓库源**不一致**——那份手改内容不会再生效，请人工合并到 dsh/agent-presets/${name}/agent.cordis.yml`);
  }
}

function yamlSingleQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

// 由桥接托管的 MCP 条目 id：脚本对这些 id 拥有所有权，可安全地按 id 增删。
//
// 2026-11-01 起拆成两组：
//   · CORE_MCP_IDS       —— 桥接本体必需（发消息/收消息/安全搜索），无条件写入；
//   · PRIVILEGED_MCP_IDS —— 高权限能力，**默认不写入**，必须显式开启（见 parseEnabledPrivileged）。
//
// 为什么高权限组默认「不挂载」，而不是「挂载了但在白名单里挡住」：
//   qq-tool-restrict 的 tools.restrict 只藏 KNOWN_DANGEROUS_GLOBAL_TOOLS（本地执行类工具），
//   MCP 命名空间走的是 tools.guard（执行期拒绝）。也就是说条目只要写进 cordis.patch.yml，
//   phone/companion/qzone 那几十个工具名**照样出现在模型的工具 schema 里**——每回合为它们
//   付 token，还会诱导模型反复尝试调用再被拒。而这里（注册层）是唯一能在源头上摘掉它们的
//   位置：不写条目 ⇒ DSH 不 spawn 对应进程 ⇒ 工具根本不进 schema。
//   代价是想用的时候要多跑一次本脚本。这是刻意选的 fail-closed：开着忘了关，
//   比关着想开危险得多（群友一句话就能让 AI 操作手机/发说说/读日记）。
const CORE_MCP_IDS = ['mcp-snowluma', 'mcp-snowluma-host', 'mcp-web-search-safe'];
const PRIVILEGED_MCP_IDS = ['mcp-phone', 'mcp-companion', 'mcp-qzone'];
// 高权限 MCP 默认全部挂载（2026-11-02 起；设 false 可恢复「默认不挂」）。
const PRIVILEGED_MCP_DEFAULT_ALL = true;
// 清理范围仍是全集：否则「重跑不带 --enable」删不掉上一轮挂上去的高权限条目，回退不干净。
const MANAGED_MCP_IDS = [...CORE_MCP_IDS, ...PRIVILEGED_MCP_IDS];

const MCP_SERVERS = {
  'mcp-snowluma': { serverName: 'snowluma', script: path.join(REPO_ROOT, 'src', 'mcp-snowluma-safe.js'), toolCallTimeoutMs: 725000 },
  'mcp-snowluma-host': { serverName: 'snowluma-host', script: path.join(REPO_ROOT, 'src', 'mcp-host-server.js') },
  'mcp-web-search-safe': { serverName: 'web-search-safe', script: path.join(REPO_ROOT, 'src', 'mcp-web-search-safe.js') },
  'mcp-phone': { serverName: 'phone', script: path.join(REPO_ROOT, 'packages', 'phone-mcp', 'src', 'phone-mcp.js') },
  'mcp-companion': { serverName: 'companion', script: path.join(REPO_ROOT, 'src', 'mcp-companion.js'), toolCallTimeoutMs: 125000 },
  // 空间专用 server。注意：phone-mcp 里原本内嵌了同源的一套 qzone_* 工具，
  // 2026-11-01 起统一由本条目独占，phone-mcp 那份已删除（避免同名能力两处维护）。
  'mcp-qzone': { serverName: 'qzone', script: path.join(REPO_ROOT, 'packages', 'qzone-mcp', 'src', 'qzone-mcp.js') },
};

// 与高权限条目一一对应的 qq-tool-restrict 白名单前缀。
// 挂载只是第一步，白名单不放行照样调不动，所以开启时日志会连带提示这一步。
const PRIVILEGED_PREFIX_BY_ID = {
  'mcp-phone': 'mcp__phone__',
  'mcp-companion': 'mcp__companion__',
  'mcp-qzone': 'mcp__qzone__',
};

/**
 * 解析「本次要显式开启哪些高权限 MCP」。
 *
 * 两种等价写法：`--enable=phone,companion,qzone`（可重复传）或环境变量 QQ_BRIDGE_ENABLE_MCP。
 * 只认本组内的名字（id / 去掉 mcp- 前缀 / serverName 三种写法都接受）；
 * 未知名字直接 fatal —— 拼错却静默忽略，比报错危险得多（会让人以为开了其实没开）。
 */
function parseEnabledPrivileged() {
  const raw = [
    ...ARGV.filter((a) => a.startsWith('--enable=')).map((a) => a.slice('--enable='.length)),
    process.env.QQ_BRIDGE_ENABLE_MCP || '',
  ].join(',').split(',').map((s) => s.trim()).filter(Boolean);
  const enabled = new Set();
  const unknown = [];
  for (const item of raw) {
    const hit = PRIVILEGED_MCP_IDS.find(
      (id) => id === item || id === `mcp-${item}` || MCP_SERVERS[id].serverName === item,
    );
    if (!hit) { unknown.push(item); continue; }
    enabled.add(hit);
  }
  if (unknown.length) {
    fatal(`未知的高权限 MCP：${unknown.join(', ')}；可选：${PRIVILEGED_MCP_IDS.join(', ')}`
      + `（也可写 serverName：${PRIVILEGED_MCP_IDS.map((id) => MCP_SERVERS[id].serverName).join(', ')}）`);
  }
  // 默认挂载（2026-11-02 起）：未显式指定时放行全部高权限 MCP；显式传 --enable 则只挂指定子集。
  if (!enabled.size && PRIVILEGED_MCP_DEFAULT_ALL) {
    for (const id of PRIVILEGED_MCP_IDS) enabled.add(id);
  }
  return enabled;
}

/**
 * 挑一个**稳定的** node 解释器写进 DSH 配置。
 *
 * 为什么不能直接用 process.execPath：MCP server 是 DSH 拿这份配置去 spawn 的，
 * 而跑本脚本的 node 完全可能是某个托管/临时运行时（实测就踩到了：写进去的是
 * C:\Users\RuoXi\.workbuddy\binaries\node\versions\22.22.2-6\node.exe）。
 * 那种路径随版本升级或工具卸载就没了 —— 表现是「DSH 启动了但所有 MCP 全部拉不起来」，
 * 而且报错在 DSH 侧，很难联想到是这个路径的问题。
 *
 * 优先级：QQ_BRIDGE_NODE_BIN 显式指定 > PATH/常见安装位里**非托管非临时**的 node > 兜底当前解释器（并告警）。
 */
function resolveNodeBin() {
  const override = process.env.QQ_BRIDGE_NODE_BIN;
  if (override) {
    if (!fs.existsSync(override)) fatal(`QQ_BRIDGE_NODE_BIN 指向的文件不存在: ${override}`);
    log(`node 解释器（显式指定）: ${override}`);
    return override;
  }
  const isWin = process.platform === 'win32';
  const exts = isWin ? ['.exe', '.cmd', ''] : [''];
  const candidates = [];
  for (const dir of String(process.env.PATH || '').split(isWin ? ';' : ':').filter(Boolean)) {
    for (const ext of exts) {
      const p = path.join(dir, `node${ext}`);
      if (fs.existsSync(p)) candidates.push(p);
    }
  }
  if (isWin) {
    // PATH 没配 node 的情况很常见（便携安装 / 只装了不加入 PATH）
    for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)) {
      const p = path.join(base, 'nodejs', 'node.exe');
      if (fs.existsSync(p)) candidates.push(p);
    }
  }
  // 托管运行时 / 临时目录：今天能跑，明天可能就没了
  const VOLATILE = /(\.workbuddy|\\Temp\\|\/tmp\/|AppData\\Local\\Temp)/i;
  const uniq = [...new Set(candidates)];
  const stable = uniq.filter((p) => !VOLATILE.test(p));
  // engines.node >= 22.13：MCP server 用了较新的 Node API，版本不够会在运行时才炸。
  // 宁可现在多跑一次 `node -v`，也别把「DSH 起来了但工具全挂」留到现网排查。
  const majorOf = (p) => {
    try {
      const r = spawnSync(p, ['-v'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
      const m = /^v?(\d+)/.exec(String(r.stdout || '').trim());
      return m ? Number(m[1]) : 0;
    } catch { return 0; }
  };
  const MIN_MAJOR = 22;
  const pick = stable.find((p) => majorOf(p) >= MIN_MAJOR) ?? stable[0];
  if (pick && majorOf(pick) < MIN_MAJOR) {
    log(`⚠️ 找到的 node 版本过低（${pick}，需要 >= ${MIN_MAJOR}）：MCP server 可能跑不起来；`
      + '建议升级 Node，或用 QQ_BRIDGE_NODE_BIN 指定一个满足版本的解释器。');
  }
  if (pick) {
    if (VOLATILE.test(process.execPath)) {
      log(`node 解释器: ${pick}（已避开当前这个托管/临时运行时 ${process.execPath}）`);
    } else {
      log(`node 解释器: ${pick}`);
    }
    return pick;
  }
  log(`⚠️ 没找到稳定的 node 安装，只能写当前解释器 ${process.execPath}；`
    + '若它是托管/临时运行时，卸载或升级后 DSH 会拉不起 MCP —— 建议先装 Node 再用 '
    + 'QQ_BRIDGE_NODE_BIN=<绝对路径> 重跑本脚本。');
  return process.execPath;
}

function mcpEntries(enabledPrivileged = new Set()) {
  const node = resolveNodeBin();
  const ids = [...CORE_MCP_IDS, ...PRIVILEGED_MCP_IDS.filter((id) => enabledPrivileged.has(id))];
  let out = '# === qq-bridge MCP BEGIN ===\n';
  out += '# 由 scripts/setup-dsh.mjs 维护；这段区块会被整体替换，请勿手工编辑内部条目。\n';
  for (const id of ids) {
    const s = MCP_SERVERS[id];
    out += `- insert:\n`;
    out += `    - id: ${id}\n`;
    out += `      name: '@deepseek-ai/dsh-mcp-client'\n`;
    out += `      config:\n`;
    out += `        serverName: ${s.serverName}\n`;
    out += `        transport: stdio\n`;
    out += `        command: ${yamlSingleQuote(node)}\n`;
    out += `        args:\n`;
    out += `          - ${yamlSingleQuote(s.script)}\n`;
    // qq_wait_for_messages 最长可等 10 分钟；DSH 默认 60s 会提前掐断工具调用。
    if (s.toolCallTimeoutMs) out += `        toolCallTimeoutMs: ${s.toolCallTimeoutMs}\n`;
  }
  out += '# === qq-bridge MCP END ===\n';
  return out;
}

function prepareCordisPatch(enabledPrivileged) {
  const profileDir = path.join(DSH_HOME, 'profiles', PROFILE);
  const patchFile = path.join(profileDir, 'cordis.patch.yml');
  const original = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, 'utf8') : '';
  const lines = original.replace(/^\uFEFF/, '').split(/\r?\n/);
  // Repair only the historical invalid *root* [] followed by block operations.
  // A nested [] or a line inside a literal scalar is user data and must survive.
  const first = lines.findIndex((line) => line.trim() && !line.trimStart().startsWith('#'));
  if (first >= 0 && lines[first].trim() === '[]'
      && lines.slice(first + 1).some((line) => /^-\s/.test(line))) {
    lines.splice(first, 1);
  }
  let doc;
  try { doc = yaml.load(lines.join('\n')) ?? []; }
  catch (error) { fatal(`failed to parse ${patchFile}; file unchanged: ${error.message}`); }
  if (!Array.isArray(doc)) fatal(`${patchFile} must contain a YAML array; file unchanged`);
  let removed = 0;
  const kept = [];
  for (const operation of doc) {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
      fatal(`invalid patch operation in ${patchFile}; file unchanged`);
    }
    if (!Object.hasOwn(operation, 'insert')) { kept.push(operation); continue; }
    if (!Array.isArray(operation.insert)) fatal(`insert must be an array in ${patchFile}; file unchanged`);
    const entries = operation.insert.filter((entry) => {
      if (!MANAGED_MCP_IDS.includes(entry?.id)) return true;
      removed++;
      return false;
    });
    // Retain shared insert parents and their selectors/other operation fields.
    if (entries.length || Object.keys(operation).length > 1) kept.push({ ...operation, insert: entries });
  }
  const text = (kept.length ? `${yaml.dump(kept, { lineWidth: -1, noRefs: true })}\n` : '') + mcpEntries(enabledPrivileged);
  const written = CORE_MCP_IDS.length + PRIVILEGED_MCP_IDS.filter((id) => enabledPrivileged.has(id)).length;
  return { patchFile, original, text, removed, written };
}

function patchCordis({ patchFile, original, text, removed, written }) {
  ensureDir(path.dirname(patchFile));
  // Parsing/serialization normalizes formatting; keep the original text (including comments).
  if (original && original !== text) {
    backupBeforeOverwrite(patchFile);
  }
  const temporary = `${patchFile}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, text, 'utf8');
    fs.renameSync(temporary, patchFile);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  log(`cordis.patch.yml: MCP 条目已同步（清理旧条目 ${removed} 条，写入 ${written} 条）`);
}

/**
 * 高权限 MCP 的挂载结果播报。
 *
 * 这不是装饰：「装了却调不动」和「以为没装其实装了」是本脚本最容易踩的两个坑——
 * 前者要连白名单一起开，后者是默认行为，得让用户看得见自己处于哪种状态。
 */
function reportPrivilegedMcps(enabled) {
  if (enabled.size > 0) {
    log(`⚠️ 本次挂载了高权限 MCP：${[...enabled].join(', ')}`);
    log('   这些能力会被 QQ 群里不可信人群的提示词注入驱动，请确认你的会话不会被外人触达。');
    log(`   还必须在工具白名单放行对应前缀，否则「看得到工具、调用被拒」：${[...enabled].map((id) => PRIVILEGED_PREFIX_BY_ID[id]).join(', ')}`);
    log('   放行方式：控制台「访问与安全 → 工具白名单」加前缀（写入 state/whitelist-extra.json），');
    log('   或设置环境变量 QQ_TOOL_RESTRICT_EXTRA 指向 {"prefixes":[...]} 的 JSON；重启 DSH 生效。');
    log(`   想关掉：临时把 setup-dsh.mjs 的 PRIVILEGED_MCP_DEFAULT_ALL 改为 false 后重跑，高权限条目会被整段清掉。`);
    return;
  }
  log(`高权限 MCP 未挂载（默认关闭）：${PRIVILEGED_MCP_IDS.map((id) => `${id}(${MCP_SERVERS[id].serverName})`).join(' / ')}`);
  log('   这组的进程不会被 DSH 拉起，工具也不进模型 schema（省 token，也避免诱导模型去试）。');
  log(`   需要时显式开启：node scripts/setup-dsh.mjs ${PROFILE} --enable=phone,companion,qzone`);
  log('   并同步放行对应白名单前缀（mcp__phone__ / mcp__companion__ / mcp__qzone__），重启 DSH 生效。');
}

/**
 * 建一个指向本仓库的目录链接（Windows 用 junction，免管理员权限）。
 *
 * 链接已存在时校验指向：指向本仓库 ⇒ 跳过（幂等）；指向别处/悬空 ⇒ 重建。
 * 指向别处说明用户手工挪过文件，这里按"重装"处理并明确打印。
 */
function ensureDirLink(linkPath, targetDir, label) {
  if (!fs.existsSync(targetDir)) fatal(`${label} 源目录不存在: ${targetDir}`);
  ensureDir(path.dirname(linkPath));

  let existing = null;
  try {
    existing = fs.lstatSync(linkPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') fatal(`failed to inspect ${label}: ${error?.message ?? error}`);
  }

  if (existing) {
    if (!existing.isSymbolicLink()) {
      fatal(`${label} 已存在且不是符号链接/junction: ${linkPath}。请先手工移走或删除，然后重跑。`);
    }
    let sameTarget = false;
    try {
      const target = fs.realpathSync(linkPath);
      const expected = fs.realpathSync(targetDir);
      sameTarget = process.platform === 'win32'
        ? String(target).toLowerCase() === String(expected).toLowerCase()
        : String(target) === String(expected);
    } catch {}
    if (sameTarget) {
      log(`${label} 已存在且指向本仓库: ${linkPath}`);
      return linkPath;
    }
    log(`${label} 存在但指向别处/失效，重建: ${linkPath}`);
    fs.rmSync(linkPath, { recursive: true, force: true });
  }

  try {
    if (process.platform === 'win32') {
      fs.symlinkSync(targetDir, linkPath, 'junction');
    } else {
      fs.symlinkSync(targetDir, linkPath, 'dir');
    }
    log(`${label} 已创建: ${linkPath}`);
  } catch (e) {
    fatal(`failed to create ${label}: ${e.message}`);
  }
  return linkPath;
}

/**
 * 把仓库里的 bundle 包接进 profile。
 *
 * 两层链接，与 `dsh plugin install`（pnpm）物化出的形态一致：
 *   ~/.dsh/plugins/<name>  → 仓库目录（人工可读的"安装位"）
 *   <profile>/node_modules/<name> → ~/.dsh/plugins/<name>（Node 解析路径）
 * 第二层必须自己建：preset 子行按 profile 目录解析裸说明符
 * （qq-agent-presets/qq-tool-restrict.mjs），缺了它 preset 会整条挂载失败。
 */
function ensureBundle(name) {
  const repoDir = name === 'qq-agent-presets' ? BUNDLE_DIR : path.join(REPO_ROOT, 'plugins', name);
  const linkDir = ensureDirLink(path.join(DSH_HOME, 'plugins', name), repoDir, `bundle ${name} link`);
  ensureDirLink(path.join(DSH_HOME, 'profiles', PROFILE, 'node_modules', name), linkDir, `bundle ${name} node_modules link`);
  return linkDir;
}

function patchProfilePackage(links) {
  const profileDir = path.join(DSH_HOME, 'profiles', PROFILE);
  const pkgFile = path.join(profileDir, 'package.json');
  ensureDir(profileDir);
  let pkg = { name: `dsh-profile-${PROFILE}`, private: true, dependencies: {}, dsh: { profile: { bundles: [] } } };
  if (fs.existsSync(pkgFile)) {
    try {
      pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
    } catch (e) {
      fatal(`failed to parse ${pkgFile}: ${e.message}`);
    }
  }
  pkg.name = pkg.name || `dsh-profile-${PROFILE}`;
  pkg.private = pkg.private !== false;
  if (!pkg.dependencies || typeof pkg.dependencies !== 'object' || Array.isArray(pkg.dependencies)) pkg.dependencies = {};
  pkg.dsh = pkg.dsh || {};
  pkg.dsh.profile = pkg.dsh.profile || {};
  if (!Array.isArray(pkg.dsh.profile.bundles)) pkg.dsh.profile.bundles = [];
  for (const [name, linkDir] of Object.entries(links)) {
    const linkVal = `link:${linkDir.replace(/\\/g, '/')}`;
    if (pkg.dependencies[name] !== linkVal) {
      pkg.dependencies[name] = linkVal;
      log(`package.json dependency ${name} -> ${linkVal}`);
    }
    if (!pkg.dsh.profile.bundles.includes(name)) {
      pkg.dsh.profile.bundles.push(name);
      log(`package.json bundle added: ${name}`);
    }
  }
  fs.writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  log(`profile package.json ensured: ${pkgFile}`);
}

function ensureLocalModeFile() {
  const stateDir = path.join(REPO_ROOT, 'state');
  const modeFile = path.join(stateDir, 'mode.json');
  if (fs.existsSync(modeFile)) {
    log(`state/mode.json already exists; leave as-is (current mode may be user-configured)`);
    return;
  }
  ensureDir(stateDir);
  // DSH 0.1.5 起不再有 'router-standard' preset；留空表示「用 DSH 自己声明的默认 preset」，
  // 由 bridge.js 的 resolvePresetName() 兜底（硬编码已下线的名字只会换来每次启动的误导性告警）。
  fs.writeFileSync(modeFile, `${JSON.stringify({ mode: 'reserved2', closedAgentPreset: '' }, null, 2)}\n`, 'utf8');
  log(`state/mode.json created with mode=reserved2 (fallback if DSH settings are not available)`);
}

// qq-mode-console / qq-agent-presets 以 link: 依赖注册进 profile package.json 后，DSH 首次启动
// 需要先安装一次才能解析这些 bundle（否则 cold start 报 "cannot resolve profile bundle"）。
// dsh CLI 可用时自动执行。
function autoInstallProfileBundles() {
  if (process.env.QQ_BRIDGE_SKIP_DSH_INSTALL === '1') {
    log('auto-install skipped: QQ_BRIDGE_SKIP_DSH_INSTALL=1');
    return;
  }
  const windows = process.platform === 'win32';
  // Node cannot spawn npm's .cmd shim directly. Keep the shell command constant;
  // the validated (no quotes/control chars) profile travels through one quoted
  // environment expansion, with delayed expansion disabled to preserve '!'.
  const cmd = windows ? (process.env.ComSpec || 'cmd.exe') : 'dsh';
  const args = windows
    ? ['/d', '/v:off', '/s', '/c', 'dsh.cmd plugin --profile "%QQ_BRIDGE_SETUP_PROFILE%" install']
    : ['plugin', '--profile', PROFILE, 'install'];
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true,
    windowsVerbatimArguments: windows,
    ...(windows ? { env: { ...process.env, QQ_BRIDGE_SETUP_PROFILE: PROFILE } } : {}),
  });
  if (r.error) {
    log(`auto-install failed to start/complete（${r.error.code || r.error.message}）。`);
    log(`若 DSH 启动报“cannot resolve profile bundle”，请手动执行：dsh plugin --profile ${PROFILE} install`);
    return;
  }
  if (r.status === 0) {
    log(`dsh plugin --profile ${PROFILE} install: OK`);
  } else {
    log(`dsh plugin --profile ${PROFILE} install 返回退出码 ${r.status}（若 DSH 启动报 bundle 解析失败，请手动重跑该命令）`);
  }
}

// Validate the existing YAML before changing any presets or configuration.
const enabledPrivileged = parseEnabledPrivileged();
const cordisPatch = prepareCordisPatch(enabledPrivileged);
regeneratePresetPatches();
patchCordis(cordisPatch);
reportPrivilegedMcps(enabledPrivileged);
const links = {};
for (const name of BUNDLE_NAMES) links[name] = ensureBundle(name);
patchProfilePackage(links);
reportLegacyPresetDir();
ensureLocalModeFile();
autoInstallProfileBundles();
log('Done. Restart DSH (or reload the profile) so the new presets/MCP take effect.');
