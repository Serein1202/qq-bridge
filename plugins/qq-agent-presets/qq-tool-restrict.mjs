// QQ 桥接安全硬边界：只允许 QQ MCP 工具与少量无害模型侧工具。
//
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// 本文件是 qq-agent-presets bundle 里的**唯一权威实现**，由 qq-chat / qq-chat-v2 两个
// agent preset 的 qq-tool-restrict 行共同引用（dsh/agent-presets/<preset>/qq-tool-restrict.mjs
// 只是个 re-export 壳，避免出现两份会漂移的实现）。
//
// 为什么引用方式是「包名/子路径」而不是 `./qq-tool-restrict.mjs`（DSH 0.1.7 的机制变化）：
//   0.1.5 的 preset 是 ~/.dsh/.agent-presets/<preset>/ 目录，相对名按 preset 目录解析；
//   0.1.7 的 preset 变成一条 loader 行，子行 name 按**声明它的 loader 上下文**
//   （= profile 目录 file:///…/.dsh/profiles/<profile>/）解析，因此 `./x.mjs` 会去找
//   profile 根目录下的文件（不存在）。bundle patch 文件只对 insert 行自己的 name 做
//   「相对 patch 文件锚定」（dsh-app-boot 的 anchorInsertedPluginNames），不会走进
//   preset 行的 config.plugins —— 所以守卫只能用**从 profile 目录可解析的裸说明符**。
//   该包以 link: 依赖注册在 profile package.json，node_modules junction 由
//   scripts/setup-dsh.mjs（或 dsh-super-injector 的 dev_heal_links）维护：
//   不写死任何绝对路径，仓库搬家后重建链接即可。
// 作用：
//  1) 用 tools.restrict 把本地执行/文件类工具与开发工具从**工具清单**里隐藏（注册期）；
//  2) 用 tools.guard 白名单兜底：任何不在允许范围内的工具，执行时一律拒绝。
//
// ⚠️ 第 1 条是铁律 L7 的落点，不是"附注"：仿真会话的 preset 永不包含本地工具。
//    `tools.guard` 只能拒绝**执行**，工具名仍会出现在模型的 schema 里——
//    那既不满足"仿真会话不得拥有本地执行能力"的注册期要求，也会诱导模型去调它。
//    所以本地工具必须同时出现在下面的 restrict 名单里。
export const name = 'qq-tool-restrict'

export const inject = ['tools']

/**
 * 本地执行 / 文件访问 / 进程控制类工具：仿真会话**不得**拥有。
 *
 * 名字**逐个核对过** DSH 0.1.7-rc.2 实际注册的工具名（来源包见每条注释），
 * 不是凭印象列举。教训：本名单初版把 `pwsh_persistent`/`bash_persistent`/
 * `cordis`/`goal_write`/`goal_read` 当成工具名，这五个**根本不存在**——
 * 而 `tools.restrict()` 对未知名字会抛错、被下面的 try/catch 逐个吞掉，
 * 于是坏名字**静默失效**。`test-preset-local-tools.mjs` 现在会把本数组与
 * DSH 真实工具名集合求差，专门防这类拼写假名。
 *
 * 2026-09-27 针对 0.1.7-rc.2 重新对账（不是逐个打补丁）：`dsh-tool-cordis` 仍在，
 * 但 `cordis_define`/`cordis_undefine`/`cordis_run`/`cordis_stop` 四个名字**已被删除**，
 * 现在只注册 `cordis_inspect_list`/`cordis_inspect_query`——旧名字留在名单里
 * 只会换来四条静默失效的 restrict（正是本名单最怕的失败模式），
 * 而新名字能读宿主运行期状态，属于必须隐藏的那一类，所以是**替换**不是删除。
 * 同一轮对账还补上了 0.1.7 新增的两个能力：
 *   - `load_workspace_dependencies`（自带 Python/Node/pnpm 的绝对路径 ⇒ 等于递上执行能力）
 *   - `list_subagent_models`（派生 agent 家族，暴露宿主模型路由配置）
 *
 * 来源包（0.1.7-rc.2）：
 *   dsh-tool-pwsh / -pwsh-persistent   → pwsh（persistent 变体注册的就是 "pwsh"）
 *   dsh-tool-bash / -bash-persistent   → bash（同上）
 *   dsh-tool-fs                        → read / read_image / write / edit
 *   dsh-tool-fs-search                 → glob / grep
 *   dsh-tool-str-replace-editor        → str_replace_editor
 *   dsh-tool-workspace-dependencies    → load_workspace_dependencies
 *                                        （返回内置 Python/Node/pnpm 的绝对路径）
 *   dsh-tool-subagent                  → subagent / subagent_fork / list_subagent_models
 *   dsh-tool-subagent-control          → send_message / interrupt_agent / list_agents
 *   dsh-tool-workflow / -ralph         → workflow / ralph
 *   dsh-tool-jobs                      → job_list / job_output / job_kill
 *   dsh-tool-todo / -skill / -present  → todo_write / skill / present
 *   dsh-tool-goal                      → get_goal / create_goal / update_goal
 *   dsh-tool-cordis                    → cordis_inspect_list / cordis_inspect_query
 *                                        （读宿主运行期状态；0.1.7 已无装载类工具名）
 *   dsh-plugin-guard（web profile bundle）→ dsh_snapshot / dsh_rollback / incident_resolved
 *                                        （读写 package.json/lockfile/patch 并 **spawn pnpm**）
 *   dsh-mode-boost（已装插件，当前未进 bundles）→ dev_mode_set / _status / _subagent
 *                                        （dev_mode_subagent 会派生 agent）
 *
 * ⚠️ 硬证据：2026-08-29 的一次 **qq-chat-v2 仿真会话**记录下来的工具清单里，
 * 除了 MCP 工具就只有 `ask_user_question`、`todo_write`、`dev_mode_*`、
 * `dsh_rollback`、`dsh_snapshot`、`incident_resolved`。也就是说
 * **`dsh_snapshot`/`dsh_rollback` 真的进过仿真会话的 schema**——本名单初版漏了它们。
 *
 * 2026-09-29 针对 DSH 0.2.0-rc.2 重新对账（同样不是逐个打补丁，而是拿安装包重扫）。
 * 对账工具：`node scripts/scan-dsh-tool-names.mjs`（可重复运行；它从已安装的
 * `@deepseek-ai/dsh-*` 里抽真实工具名，与本名单求双向差）。
 * 该轮结论：**旧名字全部还在**（0 个假名，0.1.7 那次替换后没有再次改名），
 * 但 0.2.0 的包里多出 13 个「危险语义」名字是名单没覆盖的，逐条判定如下：
 *
 *   ① 真的会进仿真会话、必须隐藏的（它们在**全局层**，所有 preset 都继承）：
 *      · `list_mcp_resources` / `list_mcp_resource_templates` / `read_mcp_resource`
 *        —— `dsh-base` 的 `mcp-resources` 行**默认启用**（cordis.patch.yml 里没有
 *        disabled），所以每个 QQ 会话都会继承这三个工具。`read_mcp_resource` 的
 *        `server` 参数可以指向**任意已配置的 MCP server**：用户一旦挂了
 *        filesystem 之类的能力型 MCP，QQ 群就通过它拿到了文件读取权。
 *        这正是 L7 要挡的那类越权路径，因此必须从 schema 里隐藏。
 *   ② 会派生 agent / 执行外部代码（当前只在 DSH 自带 preset 里挂载，QQ preset 不挂；
 *      列进来是**回归网**：别的 composition 一旦把它们推进全局层就被挡住）：
 *      · `subagent_codex` / `subagent_claude_code`（Codex / Claude Code 子智能体）
 *      · `spawn_teammate` / `team_task_create|get|list|update`（实验性 Team 模式）
 *   ③ 等于把插件装载权交出去 ⇒ 任意代码执行：
 *      · `plugin_manager`（安装/卸载/启停插件，内部会 spawn pnpm）
 *   ④ 无人值守的自我调度（`dsh-schedule`，0.2.0 起是可选 bundle）：
 *      · `schedule_create` / `schedule_list` / `schedule_update` / `schedule_delete`
 *
 * 2026-10-22 针对 DSH 0.2.1-rc.2 重新对账（`node scripts/scan-dsh-tool-names.mjs`）。
 * DSH 这轮把不少能力从「实验组合包」转正，工具面因此变了三处：
 *   ① **新增一个真的会进仿真会话的全局工具**：`dsh-base` 现在默认挂
 *      `working-directory` + `tool-working-directory` 两行，于是 `working_directory`
 *      和 `list_mcp_resources` 一样属于**全局层继承**——QQ 会话一定拿得到，
 *      必须从 schema 隐藏（`state/tool-restrict.log` 的 known global tools 实测可见）。
 *   ② 新增终端能力 `dsh-tool-terminal`（`terminal_open|send|read|signal|close|list`）：
 *      终端 = 直接 shell，是本名单第一优先级要挡的东西；当前 composition 没启用，
 *      列进来是**回归网**（一旦被插件市场/组合包装上就自动挡）。
 *   ③ 新增会话历史检索 `dsh-tool-session-query`
 *      （`session_search|trace`、`session_event_read|search|trace`）：
 *      能跨会话读事件正文 ⇒ 等于把别的聊天记录递给 QQ 群，列进来。
 *   另有两个「装载权」入口同轮补上：`plugin_market`（插件市场，等价 plugin_manager）
 *   与 `create_worktree`（写盘 + 起 git 进程）、`wait_agent`（team 家族同族）。
 *
 * ⚠️ 0.2.1 把 Codex / Claude Code 从内置 preset 改成**按需安装的可选插件**，
 *    因此 `subagent_codex` / `subagent_claude_code` 在默认安装里**不存在**——
 *    restrict 对它们必然抛错。但用户一旦装上那两个组合包，名字就会回到全局层，
 *    所以仍然保留为**可选项名单**（{@link OPTIONAL_BUNDLE_TOOL_NAMES}）而不是删掉；
 *    扫描器/测试把这一组排除在「拼错假名」判定之外，其余名字照旧逐个对账。
 */
const LOCAL_EXECUTION_TOOLS = [
  // shell / 进程
  'pwsh', 'bash',
  // 文件读写
  'read', 'read_image', 'write', 'edit', 'str_replace_editor',
  // 文件检索
  'glob', 'grep',
  // 自带运行时（Python/Node/pnpm 的绝对路径）⇒ 等于把"跑代码"递给模型
  'load_workspace_dependencies',
  // 派生 agent 与编排（都能间接拿到 shell）
  'subagent', 'subagent_fork', 'list_subagent_models',
  'send_message', 'interrupt_agent', 'list_agents',
  'workflow', 'ralph',
  // 插件/cordis 运行期检查：能读宿主状态（0.1.7 起只有这两个名字）
  'cordis_inspect_list', 'cordis_inspect_query',
  // 本机文件 + 进程：plugin-guard 会改写配置并 spawn pnpm
  'dsh_snapshot', 'dsh_rollback', 'incident_resolved',
  // 会话/交付/任务面
  // 注意：`todo_write` 与 `ask_user_question` **故意不在**此名单——它们是下面
  // SAFE_EXACT 允许的无害模型侧工具，两边不能自相矛盾。
  'job_list', 'job_output', 'job_kill', 'skill', 'present',
  'get_goal', 'create_goal', 'update_goal',
  // 0.2.0 新增对账（见上方长注释的 4 类判定）：
  //   ① 全局层默认启用 ⇒ 真的会进仿真会话
  'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
  //   ② 派生 agent / 执行外部代码
  'spawn_teammate', 'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update',
  //   ③ 插件装载权（= 任意代码执行）
  'plugin_manager',
  //   ④ 无人值守的自我调度
  'schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete',
  // 0.2.1 新增对账（2026-10-22，见上方长注释）：
  //   ① dsh-base 默认启用 ⇒ 全局层继承
  'working_directory',
  //   ② 终端（= shell）
  'terminal_open', 'terminal_send', 'terminal_read', 'terminal_signal', 'terminal_close', 'terminal_list',
  //   ③ 会话历史检索（能读别的会话的事件正文）
  'session_search', 'session_trace', 'session_event_read', 'session_event_search', 'session_event_trace',
  //   ④ 装载权 / 写盘起进程
  'plugin_market', 'create_worktree',
  //   ⑤ team 家族同族补齐
  'wait_agent',
  // 已装但当前未进 bundles 的插件（一旦加回就是新口子）
  'dev_mode_set', 'dev_mode_status', 'dev_mode_subagent',
]

/**
 * 0.2.1 起改为「按需安装」的可选能力包里才会注册的全局工具名。
 *
 * 它们默认**不存在**于安装树里（0.2.0 时写在 `dsh-web-app/presets/*.patch.yml`），
 * `tools.restrict()` 对它们必然抛错——守卫逐个 try/catch 正是为这种名字设计的。
 * 保留的收益：用户装上 Codex / Claude Code 组合包后，名字回到全局层时**立刻**被挡，
 * 不必等下一次对账。
 *
 * 扫描器与测试用这一组把「可选项」和「拼错的假名」区分开：只有不在本组、又扫不到的
 * 名字才判成假名。
 */
export const OPTIONAL_BUNDLE_TOOL_NAMES = Object.freeze([
  'subagent_codex',
  'subagent_claude_code',
])

const KNOWN_DANGEROUS_GLOBAL_TOOLS = [
  // 本地执行面（见上）
  ...LOCAL_EXECUTION_TOOLS,
  // 按需安装的可选能力包（0.2.1 起默认不存在；装上就要挡）
  ...OPTIONAL_BUNDLE_TOOL_NAMES,
  // dsh-super-injector / 开发注入器（0.1.7-rc.2 实测注册的全局工具）
  // 说明：这些名字是**运行时**才出现的（注入即注册、卸载即消失），所以只能尽力 restrict；
  // 真正的边界是下面的执行期白名单。
  'dev_build_plugin',
  'dev_clear_routes',
  'dev_fix_patch',
  'dev_heal_links',
  'dev_inject_plugin',
  'dev_injected_list',
  'dev_install_package',
  'dev_plugin_status',
  'dev_release_plugin',
  'dev_reload_package',
  'dev_scaffold_plugin',
  'dev_self_test',
  'dev_stage_add',
  'dev_stage_call',
  'dev_stage_demote',
  'dev_stage_list',
  'dev_stage_promote',
  'dev_uninject_plugin',
]

// 供 test-preset-local-tools.mjs 导入并与 DSH 真实工具名对账，避免两份名单漂移。
export const RESTRICTED_TOOL_NAMES = Object.freeze([...KNOWN_DANGEROUS_GLOBAL_TOOLS])

// 高权限命名空间：**默认不进内置基线**（2026-10-30 曾误并入、随即回退，见 RULES.md 第 2 条）。
//
// 风险说明：
//   · `mcp__phone__`    —— 经 adb 全权控制手机（点按/输入/截图/录屏/装 app/连任意 host:port），
//                          并能借 CDP 读写网易云私信；
//   · `mcp__companion__`—— 读写操作者的私人日记与按人记忆；
//   · `mcp__qzone__`    —— 以**本人身份对外发布内容**（发说说/点赞/评论）；
//                          说说删得掉，而评论发出去撤不回，且一律对外可见，
//                          等于把"用你的号公开发言"交给模型。
//
// 它们与 L7「无本地工具」铁律冲突：QQ 群会话的模型受**群友**提示词注入驱动，
// 一旦前缀在内置基线里，群友一句话就能让 AI 操作手机、发说说、读日记，
// 再用 `qq_send_message` 把内容回吐到群里。RULES.md / SECURITY_BASELINE.md
// 写的是「只允许三个命名空间」——这三个前缀**不在** BASE_SAFE_PREFIXES 里。
//
// 本常量只作为「操作者要显式开启时该加哪三个」的**清单来源**，不参与任何默认放行。
// 开启方式二选一（两步都要做，见 RULES.md）：
//   ① 挂 MCP：node scripts/setup-dsh.mjs web --enable=phone,companion,qzone
//   ② 放行前缀：控制台「工具白名单」加入前缀（写 state/whitelist-extra.json），
//      或把前缀写进 BASE_SAFE_PREFIXES（源码权威，需同步改 RULES.md）。
// 不要再往 BASE_SAFE_PREFIXES 里直接展开本数组——那等于默认放行，见上一条。
export const OPTIONAL_PRIVILEGED_PREFIXES = Object.freeze([
  'mcp__phone__',
  'mcp__companion__',
  'mcp__qzone__',
])

// 执行期白名单：不在这些范围内的工具一律拒绝。
// 前缀覆盖 DSH MCP client 暴露的命名空间工具。
// 注：这里是「内置基线」，外部追加条目见文件下方 loadExternalWhitelist()，
// 控制台「工具白名单」页写入的追加项在启动时合并进执行期的 SAFE_PREFIXES。
// 高权限命名空间（OPTIONAL_PRIVILEGED_PREFIXES）不在此列，需操作者显式开启。
export const BASE_SAFE_PREFIXES = [
  'mcp__snowluma__',
  'mcp__snowluma-host__',
  'mcp__web-search-safe__',
]

// 无害模型侧工具：ask_user_question 用于把问题转给管理员/用户，
// todo_write 仅维护任务列表。若后续 preset 不再挂载这些工具，保留无害。
//
// 内置基线的口径（2026-11-04 收紧）：**只放默认安装就存在的东西**。
// 之前这里还塞了 `compress`（billion-context）与 36 个 `bili_*`（dsh-bili-scroll）——
// 那两样都是**可选插件**，新用户默认没有，名字永远命中不到任何工具，却让基线看起来
// 像默认拥有 B 站 / 上下文压缩能力，把真正的默认权限面糊掉了。
//
// 现在它们改走「外部追加白名单」这条既有通道（与 mcp__phone__ / mcp__qzone__ 同一套机制）：
//   · 落盘位置：state/whitelist-extra.json，DSH 启动时合并进执行期 SAFE_EXACT
//   · 写入方式：控制台「访问与安全 → 工具白名单」，或直接编辑该 JSON
// 为什么不做成 `bili_` 前缀：前缀是 fail-open 的——插件以后新增任何 bili_* 工具都会
// 自动放行，连危险语义的也会。逐条精确名才是 fail-closed。
//
// 2026-11-04：仓库不再随分发附带任何可选插件的工具名。原先的声明式清单
// （plugin-tool-packs.json）与批量写入脚本（scripts/whitelist-add.mjs）已整体移除，
// 本文件也不再读 pack 文件 —— 需要放行某个插件的工具时，由使用者自行追加。
const BASE_SAFE_EXACT_SET = new Set([
  'ask_user_question',
  'todo_write',
])

// 供 bridge.js 控制台 / 测试脚本读取的「内置基线」视图（数组形式，仅读不改）。
export const BASE_SAFE_EXACT = Object.freeze([...BASE_SAFE_EXACT_SET])

// ── 外部追加白名单（state/whitelist-extra.json）──────────────────────────────
//
// 目的：让 Web 控制台「工具白名单」页能够**可视化管理追加条目**，替代手工改本文件。
// 原则（与文件头铁律一致，不弱化任何 fail-closed 语义）：
//   · 本文件仍是唯一权威源：内置基线（BASE_SAFE_EXACT / BASE_SAFE_PREFIXES）
//     只能在源码里改，API 无权增删；
//   · 外部 JSON 只存**追加**条目，启动时合并进执行期白名单（SAFE_EXACT/SAFE_PREFIXES），
//     删除追加条目同样只改 JSON，绝不回改源码；
//   · 合并后的执行期判定与原先完全一致：前缀命中或精确命中即放行，其余一律拒绝。
// 文件位置与 DIAG_FILE 同理：本文件位于 <repo>/plugins/qq-agent-presets/，
// 往上两层即仓库根（例如 D:\qq-bridge），无论经 junction 链从哪个安装点加载，
// 读到的都是同一份 <repo>/state/ 下的配置。
const EXTERNAL_WHITELIST_FILE = (() => {
  if (process.env.QQ_TOOL_RESTRICT_EXTRA) return path.resolve(process.env.QQ_TOOL_RESTRICT_EXTRA)
  try {
    return fileURLToPath(new URL('../../state/whitelist-extra.json', import.meta.url))
  } catch { return '' }
})()

function loadExternalWhitelist() {
  const empty = { exact: [], prefixes: [] }
  if (!EXTERNAL_WHITELIST_FILE) return empty
  try {
    if (!fs.existsSync(EXTERNAL_WHITELIST_FILE)) return empty
    const parsed = JSON.parse(fs.readFileSync(EXTERNAL_WHITELIST_FILE, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return empty
    const clean = (list) => (Array.isArray(list)
      ? [...new Set(list.map(String).map((s) => s.trim()).filter((s) => s && !/\s/.test(s)))]
      : [])
    return { exact: clean(parsed.exact), prefixes: clean(parsed.prefixes) }
  } catch {
    console.error('[qq-tool-restrict] 读取外部追加白名单失败，本次启动仅用内置基线：', EXTERNAL_WHITELIST_FILE)
    return empty
  }
}

const EXTERNAL_WHITELIST = loadExternalWhitelist()

// 合并后的执行期白名单（内置基线 + 外部追加）。变量名与原实现一致，
// apply() 的 guard 判定代码无需任何改动；导出供 bridge.js 读取当前生效视图。
export const SAFE_PREFIXES = Object.freeze([...BASE_SAFE_PREFIXES, ...EXTERNAL_WHITELIST.prefixes])
export const SAFE_EXACT = new Set([...BASE_SAFE_EXACT_SET, ...EXTERNAL_WHITELIST.exact])

// ── 放行模式（2026-11-04）────────────────────────────────────────────────────
//
// 问题：每装一个插件都要人肉找工具名、再往白名单里加，否则调用被 guard 拒绝。
// 这个成本随插件数线性增长（bili-scroll 一个包就 36 个名字），实操上不可持续。
//
// 三档模式，**判定顺序与语义**如下（`judge()` 是唯一实现，apply 与测试共用）：
//
//   allowlist（旧行为）：只放行 SAFE_EXACT / SAFE_PREFIXES，其余一律拒绝。
//   auto（默认）：      allowlist ∪ 「已装载插件注册的工具名」。插件清单来自
//                       <DSH_HOME>/profiles/<profile>/package.json 的 dsh.profile.bundles，
//                       **排除 @deepseek-ai/ 开头的核心包**（read / write / pwsh / terminal /
//                       session_* / subagent 全在核心包里，那是必须挡的那一面）。
//                       再减去 KNOWN_DANGEROUS_GLOBAL_TOOLS 做双保险。
//   open（全放行）：    不判定，除工具名为空外一律放行。等同于"把白名单丢掉"。
//                       保留它是因为**是否信任本机装的东西由操作者决定**；
//                       但默认值不是它，理由见下。
//
// 为什么 auto 可以作为默认值：装了插件 = 把它的代码放进本进程，插件本身已经拥有
// 完整 Node 权限（能 fs、能 spawn），guard 挡不住它，也不该假装能挡。guard 真正能挡、
// 且值得挡的是**模型能通过 QQ 群提示词注入去调用的宿主工具**——那些名字来自核心包与
// 别处 composition 的全局层，不在插件里。所以「装了才有的插件工具自动放行」不降低
// 这条边界，而「核心包工具与已知危险名始终拒绝」保住了它。
//
// 切换方式（优先级从高到低）：
//   1. 环境变量 QQ_TOOL_RESTRICT_MODE=allowlist|auto|open
//   2. <repo>/state/tool-restrict-mode.json  {"mode": "auto"}
//   3. 默认 auto
export const MODE_ALLOWLIST = 'allowlist'
export const MODE_AUTO = 'auto'
export const MODE_OPEN = 'open'
const VALID_MODES = new Set([MODE_ALLOWLIST, MODE_AUTO, MODE_OPEN])

const MODE_FILE = (() => {
  if (process.env.QQ_TOOL_RESTRICT_MODE_FILE) return path.resolve(process.env.QQ_TOOL_RESTRICT_MODE_FILE)
  try {
    return fileURLToPath(new URL('../../state/tool-restrict-mode.json', import.meta.url))
  } catch { return '' }
})()

/** 解析放行模式；非法值 fail-closed 回落到 allowlist，并留下可见的报错。 */
export function resolveMode({ env = process.env, modeFile = MODE_FILE } = {}) {
  const fromEnv = String(env.QQ_TOOL_RESTRICT_MODE ?? '').trim().toLowerCase()
  if (fromEnv) {
    if (VALID_MODES.has(fromEnv)) return fromEnv
    console.error(`[qq-tool-restrict] QQ_TOOL_RESTRICT_MODE="${fromEnv}" 非法（可选 allowlist/auto/open），已按 allowlist 处理`)
    return MODE_ALLOWLIST
  }
  if (modeFile) {
    try {
      const parsed = JSON.parse(fs.readFileSync(modeFile, 'utf8'))
      const fromFile = String(parsed?.mode ?? '').trim().toLowerCase()
      if (fromFile) {
        if (VALID_MODES.has(fromFile)) return fromFile
        console.error(`[qq-tool-restrict] ${modeFile} 里的 mode="${fromFile}" 非法，已按 allowlist 处理`)
        return MODE_ALLOWLIST
      }
    } catch { /* 文件不存在或损坏 —— 用默认值，不阻断启动 */ }
  }
  return MODE_AUTO
}

export const RESTRICT_MODE = resolveMode()

// ── auto 模式：从已装载插件里发现工具名 ──────────────────────────────────────
//
// 只扫「非核心 bundle」的包目录。判定依据是 profile/package.json 的 dsh.profile.bundles
// ——那是 DSH 真正装载的清单，比"node_modules 里有什么"更准（依赖树里常有一堆没挂载的包）。
//
// 扫描刻意保守：只认三种注册形状（与 scripts/dsh-tool-names.mjs 同一套正则），
// 有文件数 / 大小 / 深度上限，任何异常都吞掉并把该包记为"扫不到"——
// 扫不到只是回到 allowlist 行为，不会误放行。
const PLUGIN_TOOL_NAME_RE = /^[a-z][a-z0-9_-]{1,40}$/
const SCAN_FILE_RE = /\.(js|mjs|cjs|ts)$|\.d\.ts$|\.patch\.ya?ml$/
const SCAN_SKIP_DIRS = new Set(['node_modules', '.git', '.cache', 'test', 'tests', '__tests__'])

function dshHomeDir() {
  return process.env.DSH_HOME
    || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.dsh')
      : (process.env.HOME ? path.join(process.env.HOME, '.dsh') : ''))
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

/** 已装载的非核心 bundle 名 + 其包目录。核心包（@deepseek-ai/*）永不参与自动放行。 */
export function listInstalledPluginBundles({ home = dshHomeDir(), profile = process.env.DSH_PROFILE || 'web' } = {}) {
  if (!home) return []
  const profileDir = path.join(home, 'profiles', profile)
  const pkg = readJson(path.join(profileDir, 'package.json')) ?? {}
  const declared = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : []
  const deps = Object.keys(pkg?.dependencies ?? {})
  // bundles 是权威清单；dependencies 兜底，防止某些 profile 只用 dependencies 声明。
  const names = [...new Set([...declared, ...deps].map(String))]
    .filter((n) => n && !n.startsWith('@deepseek-ai/'))
  const out = []
  for (const name of names) {
    const dir = path.join(profileDir, 'node_modules', ...name.split('/'))
    if (!fs.existsSync(dir)) continue
    const meta = readJson(path.join(dir, 'package.json')) ?? {}
    out.push({ name: meta.name || name, dir })
  }
  // 用户插件目录（link: 安装的会重复出现，用 realpath 去重）
  const pluginsDir = path.join(home, 'plugins')
  let entries = []
  try { entries = fs.readdirSync(pluginsDir, { withFileTypes: true }) } catch { /* 没有就算了 */ }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue
    const dir = path.join(pluginsDir, e.name)
    const meta = readJson(path.join(dir, 'package.json')) ?? {}
    out.push({ name: meta.name || e.name, dir })
  }
  const seen = new Set()
  return out.filter((p) => {
    const key = (() => { try { return fs.realpathSync(p.dir) } catch { return p.dir } })()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** 从单个包目录里抽工具名（有界；失败返回空集）。 */
export function scanPackageToolNames(dir, { maxFiles = 4000, maxFileBytes = 512 * 1024, maxDepth = 5 } = {}) {
  const found = new Set()
  const add = (name) => { if (PLUGIN_TOOL_NAME_RE.test(name)) found.add(name) }
  let visited = 0
  const walk = (cur, depth) => {
    if (depth > maxDepth || visited >= maxFiles) return
    let entries = []
    try { entries = fs.readdirSync(cur, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (visited >= maxFiles) return
      if (e.name.startsWith('.') || SCAN_SKIP_DIRS.has(e.name)) continue
      const full = path.join(cur, e.name)
      if (e.isDirectory()) { walk(full, depth + 1); continue }
      if (!SCAN_FILE_RE.test(e.name)) continue
      visited += 1
      let text = ''
      try {
        const st = fs.statSync(full)
        if (st.size > maxFileBytes) continue
        text = fs.readFileSync(full, 'utf8')
      } catch { continue }
      for (const m of text.matchAll(/\.register\(\s*defineTool\(\{[\s\S]{0,400}?\bname:\s*["']([^"']+)["']/g)) add(m[1])
      for (const m of text.matchAll(/\btoolName:\s*["']([^"']+)["']/g)) add(m[1])
      for (const m of text.matchAll(/\btoolName:\s*[^;\n]*?\.default\(\s*["']([^"']+)["']/g)) add(m[1])
      for (const m of text.matchAll(/defineTool\(\{[\s\S]{0,200}?\bname:\s*["']([^"']+)["']/g)) add(m[1])
    }
  }
  walk(path.resolve(dir), 0)
  return found
}

/**
 * 读插件声明的 pack 清单（覆盖 Python/MCP 侧工具：那些名字在 JS 里扫不到）。
 *
 * 2026-11-04 起仓库不再附带 plugin-tool-packs.json（可选插件的工具名已整体剔除），
 * 所以默认返回空对象、pack 分支不生效 —— auto 模式只依赖扫包结果。机制本身保留：
 * 将来某个 MCP 型插件的工具名既扫不到、又确实需要放行时，重新放一份清单即可启用。
 */
function loadPluginPacks() {
  try {
    const file = fileURLToPath(new URL('./plugin-tool-packs.json', import.meta.url))
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    const packs = parsed?.packs
    return packs && typeof packs === 'object' ? packs : {}
  } catch { return {} }
}

let autoCache = null

/**
 * auto 模式额外放行集合 = 已装载插件包里扫到的工具名 ∪ 这些包对应 pack 的声明条目。
 * 结果缓存（模块生命周期内只算一次：DSH 启动时算一次即可，改插件要重启）。
 *
 * pack 可以声明两种东西：
 *   · exact[]    —— 精确工具名（JS 侧注册的名字，以及扫不到的 Python/MCP 工具名）
 *   · prefixes[] —— 命名空间前缀（`mcp__xxx__` 形式）。给**MCP 型插件**用：
 *                   MCP server 的工具名是 `mcp__<serverName>__<tool>`，由 DSH 的
 *                   mcp-client 动态注册，插件源码里没有 `name: '...'` 字面量，
 *                   扫盘永远扫不到 —— 只能靠前缀声明。
 *                   ⚠️ 前缀是 fail-open 的（该命名空间以后新增的工具一并放行），
 *                   所以只在 packs 里逐个插件显式声明，绝不写成全局 `mcp__` 通配。
 */
export function getAutoAllowed() {
  if (autoCache) return autoCache
  const allowed = new Set()
  const prefixes = new Set()
  const sources = []
  const denied = new Set(KNOWN_DANGEROUS_GLOBAL_TOOLS)
  const bundles = listInstalledPluginBundles()
  const packs = loadPluginPacks()
  const packByPackage = new Map()
  for (const [packName, pack] of Object.entries(packs)) {
    if (pack?.package) packByPackage.set(String(pack.package), { packName, pack })
  }
  for (const bundle of bundles) {
    let count = 0
    for (const name of scanPackageToolNames(bundle.dir)) {
      if (denied.has(name)) continue
      allowed.add(name); count += 1
    }
    const hit = packByPackage.get(bundle.name)
    if (hit) {
      for (const entry of Array.isArray(hit.pack.exact) ? hit.pack.exact : []) {
        const value = String(entry).trim()
        if (!value || denied.has(value) || !PLUGIN_TOOL_NAME_RE.test(value)) continue
        if (!allowed.has(value)) count += 1
        allowed.add(value)
      }
      for (const prefix of Array.isArray(hit.pack.prefixes) ? hit.pack.prefixes : []) {
        const value = String(prefix).trim()
        // 前缀必须形如 `mcp__ns__`：裸 `mcp__` 会让所有 MCP 命名空间一次性放行，
        // 等于把"高权限命名空间默认关闭"这条规则作废（RULES.md 第 2 条）。
        if (!/^[A-Za-z0-9_]+__[A-Za-z0-9_]*__$/.test(value) && !/^[A-Za-z0-9_]+__$/.test(value)) continue
        if (value === 'mcp__') continue
        if (!prefixes.has(value)) count += 1
        prefixes.add(value)
      }
    }
    sources.push(`${bundle.name}(${count})`)
  }
  autoCache = { allowed, prefixes, sources }
  return autoCache
}

/**
 * 唯一的放行判定。返回 undefined = 放行，返回字符串 = 拒绝原因。
 *
 * @param {string} name 工具名
 * @param {object} opts 测试可注入 mode / exact / prefixes / autoAllowed / autoPrefixes
 */
export function judge(name, {
  mode = RESTRICT_MODE,
  exact = SAFE_EXACT,
  prefixes = SAFE_PREFIXES,
  autoAllowed = null,
  autoPrefixes = null
} = {}) {
  if (typeof name !== 'string' || name.length === 0) return '工具名无效，已拒绝'
  if (mode === MODE_OPEN) return undefined
  if (exact.has(name)) return undefined
  if (prefixes.some((prefix) => name.startsWith(prefix))) return undefined
  if (mode === MODE_AUTO) {
    const auto = autoAllowed === null || autoPrefixes === null ? getAutoAllowed() : null
    const names = autoAllowed ?? auto.allowed
    const ns = autoPrefixes ?? auto.prefixes
    // 已知危险名即便被插件扫到也不放行（双保险：restrict 名单 + 这里）
    if (names.has(name) && !KNOWN_DANGEROUS_GLOBAL_TOOLS.includes(name)) return undefined
    if (ns.size && [...ns].some((prefix) => name.startsWith(prefix))) return undefined
  }
  return `工具 "${name}" 不在 QQ 桥接白名单内，已拒绝（仅允许 QQ MCP 工具与无害模型侧工具）`
}


// ── 诊断落盘：restrict 失败时到底为什么 ────────────────────────────────────
//
// 为什么必须落盘（2026-10-18 实测）：重启之后新建的 QQ 会话 schema 里，
// `dev_*` **仍然是 18 个**——说明 `ctx.tools.restrict({deny})` 根本没生效，
// 而失败被下面的 per-name try/catch 吞掉了。DSH 的 stderr 不落日志文件（只有启动失败
// 才会写 ~/.dsh/logs），所以「为什么失败」在现网完全不可观测。
//
// 这里把失败原因写到 <repo>/state/tool-restrict.log（有界、只写最近 20 行），
// 并把失败的名字在 3 秒后重试一次：如果只是「注入器比 preset 晚注册」的时序问题，
// 重试就能把工具真正藏掉；如果重试也失败，日志里会留下 DSH 的原始报错，
// 下次排查不用再猜。
const DIAG_FILE = (() => {
  // 测试可用 QQ_TOOL_RESTRICT_LOG 改到临时文件，避免污染真实 state/
  if (process.env.QQ_TOOL_RESTRICT_LOG) return path.resolve(process.env.QQ_TOOL_RESTRICT_LOG)
  try {
    // 本文件位于 <repo>/plugins/qq-agent-presets/，往上两层就是仓库根
    return fileURLToPath(new URL('../../state/tool-restrict.log', import.meta.url))
  } catch { return '' }
})()

function writeDiagnostics(lines) {
  if (!DIAG_FILE || !lines.length) return
  // 单行截断：DSH 的报错里会把**整份** known global tools 清单拼进去（实测单行 2KB+），
  // 不截就等于把日志变成噪声。保留开头足够定位的信息即可。
  const trim = (line) => (line.length > 240 ? `${line.slice(0, 240)}…` : line)
  try {
    const previous = (() => {
      try { return fs.readFileSync(DIAG_FILE, 'utf8').split('\n').filter(Boolean) } catch { return [] }
    })()
    // 有界：只保留最近 20 条（每次 agent 创建都会写一轮，别让文件无限长）
    const next = [...previous, ...lines.map(trim)].slice(-20)
    fs.mkdirSync(path.dirname(DIAG_FILE), { recursive: true })
    fs.writeFileSync(DIAG_FILE, next.join('\n') + '\n', 'utf8')
  } catch {}
}

export function apply(ctx) {
  // 1) 把已知危险全局工具从 schema 隐藏（restrict 只影响继承的全局层，
  //    不会误删 preset 自己注册的 scoped 工具）。
  // 逐个 restrict：当前 DSH 版本不存在的工具名会单独抛错并跳过，
  // 不会导致整批限制失败（restrict 的 unknown 校验是整批原子性的）。
  //
  // 口径（2026-09-27 实测 web profile 的全局层）：实际存在的全局工具只有
  // `dev_*`（注入器）与三个 MCP 命名空间的工具；`read`/`pwsh`/`subagent` 这类
  // 是**各 preset 行自己注册的 scoped 工具**，在 QQ preset 里根本没挂载，
  // 因此本名单主要防的是"别的 composition 把它们注册进全局层"这种回归，
  // 以及 MCP 之外的宿主工具（plugin-guard / cordis 检查工具等）。
  const stamp = new Date().toISOString()
  const failed = []
  const attempt = (names) => {
    let ok = 0
    for (const name of names) {
      try {
        ctx.tools.restrict({ deny: [name] })
        ok += 1
      } catch (error) {
        failed.push({ name, message: String(error?.message ?? error) })
      }
    }
    return ok
  }

  const firstOk = attempt(KNOWN_DANGEROUS_GLOBAL_TOOLS)
  const firstFailed = failed.slice()
  failed.length = 0

  if (firstFailed.length > 0) {
    // 逐个名字的报错收成一类，避免 18 行重复
    const reasons = [...new Set(firstFailed.map((f) => f.message))]
    console.error(
      `[qq-tool-restrict] restrict 失败 ${firstFailed.length}/${KNOWN_DANGEROUS_GLOBAL_TOOLS.length}：${reasons.join(' | ')}`
    )
    writeDiagnostics([
      `${stamp} restrict ok=${firstOk} failed=${firstFailed.length} 原因: ${reasons.join(' | ')}`,
      `${stamp} 失败样例: ${firstFailed.slice(0, 3).map((f) => f.name).join(', ')}`,
    ])
    // 时序兜底：注入器的工具可能在 preset apply 之后才注册进全局层。
    // 3 秒后重试失败项；成功则记一行，失败保留原因。
    const timer = setTimeout(() => {
      let ok = 0
      const still = []
      for (const { name } of firstFailed) {
        try { ctx.tools.restrict({ deny: [name] }); ok += 1 } catch (error) { still.push(`${name}: ${error?.message ?? error}`) }
      }
      if (ok > 0) console.error(`[qq-tool-restrict] 延迟重试补藏成功 ${ok} 个`)
      writeDiagnostics([
        `${new Date().toISOString()} 延迟重试 ok=${ok} 仍失败=${still.length}${still.length ? ` 原因: ${still[0]}` : ''}`,
      ])
    }, 3000)
    timer?.unref?.()
  }

  // 2) 执行期判定：统一走 judge()（放行模式见文件上方「放行模式」段）。
  //
  // 模式必须**每次启动都打一行**：判定放宽是安全相关的状态变更，不能让它在
  // stderr 里静默发生（旧实现里 restrict 失败被 try/catch 吞掉，就是靠
  // "为什么没生效"完全不可观测才拖了一周）。
  // 注意：模式行只走 stderr，**不写诊断文件** —— state/tool-restrict.log 是
  // "restrict 出问题了"的信号通道，正常启动往里写会让"日志非空"失去告警意义
  // （test-tool-restrict-guard.mjs 有断言守着这一点）。
  if (RESTRICT_MODE === MODE_OPEN) {
    console.error('[qq-tool-restrict] ⚠️  放行模式=open：执行期白名单已整体关闭，任何工具都会被放行（仅保留 tools.restrict 的隐藏名单）')
  } else if (RESTRICT_MODE === MODE_AUTO) {
    const { allowed, sources } = getAutoAllowed()
    console.error(`[qq-tool-restrict] 放行模式=auto：基线 ${SAFE_EXACT.size} 条 + 已装载插件自动放行 ${allowed.size} 条`
      + `${sources.length ? `（${sources.join(', ')}）` : '（未发现已装载插件）'}`)
  } else {
    console.error(`[qq-tool-restrict] 放行模式=allowlist：仅放行基线 ${SAFE_EXACT.size} 条`)
  }

  ctx.tools.guard((exec) => judge(exec?.name))
}
