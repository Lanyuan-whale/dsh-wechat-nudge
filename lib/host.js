/**
 * dsh-wechat-nudge（微信监听 + 分类 + 叫醒）
 *
 * 2026-10-31 v0.3.0：把外部的 pwsh 监听脚本收进插件，自己一条龙做完：
 *   1) 盯微信本地库 message_0.db-wal 的 mtime（每 5 秒 stat，不读正文）
 *   2) 一变就通过 bridge.py 走**插件自己的采集路径**刷新一次（快、增量）
 *   3) 再 review 最近几分钟，取最新一条看是谁发的
 *   4) 不是"我"发的 → 往目标会话 followup 一条提示，把这一轮叫醒
 *      是"我"发的 → 只记日志，不叫醒（自己发的不吵自己）
 *
 * 为什么要走 bridge.py 而不是 tools\微信.py：后者刷新走 setup.py 全量采集（几十秒到两分钟），
 * 永远慢一拍，会把主人的新消息误判成"没有新消息"。bridge.py 用的是和插件工具同一份索引与增量路径。
 *
 * 配置：默认在 ~/.dsh/wechat-nudge.json（可用环境变量 DSH_WECHAT_NUDGE_CONFIG 覆盖）。
 * 仓库里不带任何本机路径：watchPath 与 bridge* 三项目默认留空，运行时自动探测。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

export const name = 'wechat-nudge'
export const inject = ['agents', 'sessions', 'sessionTitle', 'webServer']

const SOURCE_KIND = 'mail'

/** 配置文件：放 ~/.dsh 下，和工作区、和仓库都不相干；环境变量可以另指一处。 */
const CONFIG_FILE = process.env.DSH_WECHAT_NUDGE_CONFIG
  || path.join(os.homedir(), '.dsh', 'wechat-nudge.json')

/** 版本只认 package.json 一处，别再两边对不上（0.3.0 那次就吃过亏）。 */
const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

const MY_LABEL = '我'

function localAppData() {
  return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
}

const DEFAULTS = {
  enabled: true,
  target: '',
  /** 要被监视的文件（微信消息库的 -wal）。留空＝运行时自动找。 */
  watchPath: '',
  /** 调 better-wechat 采集器要用的三样。留空＝运行时自动找。 */
  bridgePython: '',
  bridgeScript: '',
  bridgeState: '',
  intervalSec: 5,
  cooldownSec: 60,
  dailyLimit: 200,
  quietStart: 0,
  quietEnd: 0,
  classifyWindowMin: 3,
  refreshTimeoutMs: 90000,
  reviewTimeoutMs: 30000,
  text: '',
  /** 群里怎么算"在叫我"：凡出现「@昵称」就算。留空＝群消息一律不叫醒（宁可安静）。 */
  我的群昵称: [],
  /** false ＝群里不管有没有 @ 都叫（默认 false，只在调试时打开）。 */
  群仅被at才叫: true,
  /**
   * 分类投递：群消息走专线，私聊按关键词轻规则分到各间，判不准落默认。
   * 词表宁可窄——没命中就落默认，比误分类好。`启用: false` 时整个退回只用 target。
   * 默认三项都空着：没配就等于不分类，群消息与私聊都走 `target`（行为跟没有这块时一样）。
   * 照这样填即可：
   *   "分类投递": {
   *     "群投递": "群",
   *     "默认": "日常",
   *     "规则": [ { "房间": "工作", "词": ["报告", "会议"] } ]
   *   }
   */
  分类投递: {
    启用: true,
    群投递: '',
    默认: '',
    规则: [],
  },
}

/**
 * 自动找微信消息库：微信 4.x 把每个登录账号放在
 * ~/Documents/xwechat_files/<账号目录>/db_storage/message/message_0.db-wal。
 * 多个账号时取第一个找得到的（要指哪个就在配置里写死 watchPath）。
 */
function autoWatchPath() {
  const base = path.join(os.homedir(), 'Documents', 'xwechat_files')
  try {
    for (const name of fs.readdirSync(base)) {
      const p = path.join(base, name, 'db_storage', 'message', 'message_0.db-wal')
      if (fs.existsSync(p)) return p
    }
  } catch { /* 没装微信 / 没登录过，就是空的 */ }
  return ''
}

/** 从已安装的 dsh-better-wechat 包里找 bridge.py。装法不同解析失败就留空，由配置兜。 */
function autoBridgeScript() {
  try {
    const entry = createRequire(import.meta.url).resolve('dsh-better-wechat')
    return path.join(path.dirname(entry), 'python', 'bridge.py')
  } catch {
    return ''
  }
}

/** 采集器的 Python：优先用 better-wechat 自己装的那个私有运行器，没有就退回系统 python。 */
function autoBridgePython() {
  const exe = process.platform === 'win32' ? 'python.exe' : 'python3'
  const local = path.join(localAppData(), 'dsh-better-wechat', 'collector-runtime', 'Scripts', exe)
  try {
    if (fs.existsSync(local)) return local
  } catch { /* 看不见就走系统 python */ }
  return 'python'
}

/** 把留空的项补全成实际值（只补空，配置里写了的说了算）。 */
function complete(cfg) {
  const out = { ...cfg }
  if (!out.watchPath) out.watchPath = autoWatchPath()
  if (!out.bridgeScript) out.bridgeScript = autoBridgeScript()
  if (!out.bridgePython) out.bridgePython = autoBridgePython()
  if (!out.bridgeState) out.bridgeState = path.join(localAppData(), 'dsh-better-wechat')
  return out
}

const DEFAULT_TEXT =
  '（系统转来的一条提示，不是他本人说的话：微信那边进了新消息。'
  + '先 wechat_refresh 采一次，按需读；该回就回，不该回就当没看见，'
  + '不用回应这条提示本身，也不必向他复述它。）'

function readConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
    return complete({ ...DEFAULTS, ...raw })
  } catch {
    return complete({ ...DEFAULTS })
  }
}

function hhmm(ts) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 调一次 bridge.py：stdin 送 {action, params}，stdout 收 JSON。 */
function callBridge(cfg, action, params, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    let child
    const finish = (v) => { if (!settled) { settled = true; resolve(v) } }
    try {
      child = spawn(cfg.bridgePython, ['-X', 'utf8', '-B', cfg.bridgeScript, '--state', cfg.bridgeState], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
      })
    } catch (e) {
      finish({ ok: false, error: 'spawn: ' + String((e && e.message) || e) })
      return
    }
    let out = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
      finish({ ok: false, error: 'timeout ' + timeoutMs + 'ms' })
    }, timeoutMs)
    child.stdout.on('data', (d) => { out += d.toString('utf8') })
    child.on('error', (e) => { clearTimeout(timer); finish({ ok: false, error: 'proc: ' + String((e && e.message) || e) }) })
    child.on('close', () => {
      clearTimeout(timer)
      const text = out.trim()
      if (!text) { finish({ ok: false, error: 'empty-output' }); return }
      try {
        finish(JSON.parse(text.split('\n').pop()))
      } catch {
        finish({ ok: false, error: 'bad-json' })
      }
    })
    try {
      child.stdin.write(JSON.stringify({ action, params: params || {} }))
      child.stdin.end()
    } catch (e) {
      clearTimeout(timer)
      finish({ ok: false, error: 'stdin: ' + String((e && e.message) || e) })
    }
  })
}

/**
 * 群里是不是在叫我。微信群里 @ 人长这样：「@蓝沅\u2005在吗」——中间那个窄空格
 * 是微信自己插的，直接搜「@蓝沅」经常搜不到，所以先把各种空格与全角 @ 归一。
 * 没配昵称时一律当作"没叫我"：群里人多，宁可安静，也不要每句都叫醒。
 */
function 被点名了(文本, cfg) {
  const t = String(文本 || '').replace(/[\u2005\u00a0]/g, ' ').replace(/＠/g, '@')
  const 名单 = Array.isArray(cfg.我的群昵称)
    ? cfg.我的群昵称
    : (cfg.我的群昵称 ? [cfg.我的群昵称] : [])
  const 有 = 名单.map((n) => String(n || '').trim()).filter(Boolean)
  if (有.length === 0) return false
  return 有.some((n) => t.includes('@' + n))
}

/**
 * 从 review 回来的消息里挑「最新一条人说的话」，顺带认出会话与是否 @ 我。
 * 系统消息（进群、撤回、企业微信提示…）既不用回也不该叫醒——2026-11-01 被拉进测试群时
 * 就是这么白叫了一次。纯函数，方便单测（见 __测试）。
 */
function 归类(msgs, cfg) {
  const 表 = Array.isArray(msgs) ? msgs : []
  if (表.length === 0) return { ok: true, sender: 'none', time: null }
  const 排好的 = 表.slice().sort((a, b) => String(a && a.time).localeCompare(String(b && b.time)))
  const 实 = 排好的.filter((m) => {
    const 类型 = String((m && m.message_type) || '')
    const 谁 = String((m && m.sender_label) || '')
    return 类型 !== 'system' && 谁 !== '系统'
  })
  if (实.length === 0) return { ok: true, sender: 'none', time: null, 只有系统消息: true }
  const last = 实[实.length - 1]
  const kind = String(last.kind || '')
  const 原文 = String(last.text || '').slice(0, 200)
  return {
    ok: true,
    sender: String(last.sender_label || ''),
    time: String(last.time || ''),
    kind,
    会话: String(last.conversation_label || ''),
    会话id: String(last.conversation_id || ''),
    原文,
    atMe: kind === 'group' ? 被点名了(原文, cfg) : false,
  }
}

/**
 * 这条消息该投哪间房（2026-11-01 他定：群走专线，私聊轻规则，判不准落默认）。
 * 词表窄一点没坏处——没命中就落默认，比误投好；规则顺序＝优先级，先命中先算。
 * 纯函数，方便单测（见 __测试）。
 */
function 选房间(cfg, 详情) {
  const d = 详情 || {}
  const 类 = (cfg && cfg.分类投递) || {}
  const 开 = 类.启用 !== false
  const 原文 = String(d.原文 || '')

  if (开 && d.kind === 'group') {
    const room = String(类.群投递 || '').trim()
    if (room) return { 房间: room, 依据: '群消息专线', 类: 'group' }
  }
  if (开) {
    for (const r of (Array.isArray(类.规则) ? 类.规则 : [])) {
      if (!r || !r.房间) continue
      for (const w of (Array.isArray(r.词) ? r.词 : [])) {
        if (w && 原文.includes(w)) return { 房间: String(r.房间), 依据: '命中「' + w + '」', 类: 'rule' }
      }
    }
    const 默认 = String(类.默认 || '').trim()
    if (默认) return { 房间: 默认, 依据: '没有规则命中，落默认', 类: 'default' }
  }
  return { 房间: String((cfg && cfg.target) || '').trim(), 依据: '分类投递关着，走 target', 类: 'off' }
}

/**
 * 把一封消息压成一个指纹，用来挡「同一条消息被相邻两轮各处理一次」。
 * 为什么需要：落信这条路不更新冷却（冷却只记叫醒成功），所以同一条 @ 会落两封。
 * 只挡一模一样的那一条——时间、会话、发送者、正文任一不同就算新消息。
 * 纯函数，方便单测（见 __测试）。
 */
function 消息指纹(详情) {
  const d = 详情 || {}
  return [
    String(d.kind || ''),
    String(d.会话id || ''),
    String(d.time || ''),
    String(d.发送者 || ''),
    String(d.原文 || ''),
  ].join('|')
}

/** 给单测用：这几件事是纯函数，不必起整个插件。 */
export const __测试 = { 归类, 被点名了, 选房间, 消息指纹 }
/** 给单测用：内置默认配置（尤其那张分类词表）也一起暴露，免得测试抄一份走样。 */
export const __默认 = DEFAULTS

export function apply(ctx) {
  const log = []
  let lastMtime = null
  let lastNudge = 0
  let lastSender = ''
  let lastKind = ''
  let lastConversation = ''
  let lastClassifiedAt = null
  let dayKey = new Date().toDateString()
  let dayCount = 0
  let nudgeCount = 0
  let busy = false
  let lastError = ''
  let warnedMissing = false
  /** 上一封已处理消息的指纹：同一条被相邻两轮各采到一次时，只处理第一轮。 */
  let lastHandled = ''

  function note(text) {
    const line = { 时间: hhmm(Date.now()), 文本: String(text) }
    log.push(line)
    if (log.length > 60) log.shift()
    try { ctx.logger.info('wechat-nudge: ' + line.文本) } catch { /* logger 不在就算了 */ }
    return line
  }

  /** 磁盘上的配置原文（**不叠默认值**）——保存时拿它当底，免得把没传上来的项冲掉。 */
  function readRawConfig() {
    try {
      const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
      return raw && typeof raw === 'object' ? raw : {}
    } catch {
      return {}
    }
  }

  const 回 = (res, body) => {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }

  const 读体 = async (req) => {
    let body = ''
    try {
      for await (const chunk of req) body += chunk
      return JSON.parse(body || '{}')
    } catch {
      return {}
    }
  }

  /** 活着的房间：id + 标题，给设置页的「目标会话」单选列表用。 */
  function roomList() {
    const out = []
    const seen = new Set()
    let agents = []
    try { agents = ctx.agents.list() || [] } catch { /* 查不动就当没有 */ }
    for (const a of agents) {
      const id = String((a && (a.id || (a.session && a.session.id))) || '').trim()
      if (!id || seen.has(id)) continue
      seen.add(id)
      let title = ''
      try {
        const svc = ctx.get ? ctx.get('sessionTitle') : undefined
        let s = a.session
        if (!s && ctx.sessions && typeof ctx.sessions.get === 'function') s = ctx.sessions.get(id)
        const snap = s && svc && typeof svc.get === 'function' ? svc.get(s) : undefined
        title = String((snap && snap.title) || '')
      } catch { /* 没标题就显示 id 尾巴 */ }
      out.push({ id, 标题: title, 状态: a.status === undefined || a.status === null ? '' : String(a.status) })
    }
    out.sort((x, y) => {
      if (x.标题 !== y.标题) {
        if (!x.标题) return 1
        if (!y.标题) return -1
        return x.标题.localeCompare(y.标题, 'zh')
      }
      return x.id.localeCompare(y.id)
    })
    return out
  }

  function clampInt(v, lo, hi, dflt) {
    const n = Math.round(Number(v))
    if (!Number.isFinite(n)) return dflt
    return Math.min(hi, Math.max(lo, n))
  }

  /**
   * 合并保存：只认白名单里的键，数值都夹在合理区间。
   * 写完把旧的留一份 .bak —— 页面上的数字点错一下不至于把配置弄丢。
   */
  function saveConfig(patch) {
    const cur = readRawConfig()
    const next = { ...cur }
    const p = patch && typeof patch === 'object' ? patch : {}
    if ('enabled' in p) next.enabled = Boolean(p.enabled)
    if ('target' in p) next.target = String(p.target == null ? '' : p.target).trim()
    if ('watchPath' in p && String(p.watchPath || '').trim() !== '') next.watchPath = String(p.watchPath).trim()
    if ('intervalSec' in p) next.intervalSec = clampInt(p.intervalSec, 3, 600, 5)
    if ('cooldownSec' in p) next.cooldownSec = clampInt(p.cooldownSec, 0, 86400, 60)
    if ('dailyLimit' in p) next.dailyLimit = clampInt(p.dailyLimit, 0, 10000, 200)
    if ('quietStart' in p) next.quietStart = clampInt(p.quietStart, 0, 23, 0)
    if ('quietEnd' in p) next.quietEnd = clampInt(p.quietEnd, 0, 23, 0)
    if ('classifyWindowMin' in p) next.classifyWindowMin = clampInt(p.classifyWindowMin, 1, 60, 3)
    if ('text' in p) next.text = String(p.text == null ? '' : p.text).slice(0, 2000)
    // 分类投递是嵌套对象，浅合并：只传一部分字段也不会把其余规则冲掉。
    // 基底要取「合并后的配置」而不是磁盘原文——磁盘上可能压根没有这一块，
    // 那就成了从空对象合并，默认值和整张词表会被一个 {群投递} 一次冲光。
    if (p['分类投递'] && typeof p['分类投递'] === 'object') {
      const 基底 = (cur && cur['分类投递']) || readConfig()['分类投递'] || {}
      next['分类投递'] = { ...基底, ...p['分类投递'] }
    }
    try { fs.writeFileSync(CONFIG_FILE + '.bak', JSON.stringify(cur, null, 2), 'utf8') } catch { /* 备份没成也继续写 */ }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2) + '\n', 'utf8')
    return next
  }

  function findAgent(id) {
    const raw = String(id == null ? '' : id).trim()
    if (!raw) return undefined
    const candidates = [raw]
    if (raw.startsWith('session-')) candidates.push(raw.slice('session-'.length))
    else candidates.push('session-' + raw)
    for (const one of candidates) {
      try {
        const a = ctx.agents.get(one)
        if (a !== undefined) return a
      } catch { /* 查不动就当没找到 */ }
    }
    return undefined
  }

  function inQuietHours(cfg) {
    const qs = Number(cfg.quietStart) || 0
    const qe = Number(cfg.quietEnd) || 0
    if (qs === qe) return false
    const h = new Date().getHours()
    return qs < qe ? (h >= qs && h < qe) : (h >= qs || h < qe)
  }

  function rollDay() {
    const k = new Date().toDateString()
    if (k !== dayKey) { dayKey = k; dayCount = 0 }
  }

  /** 问采集器：最近窗口里最新一条**人说的话**是谁发的（系统消息不算）。 */
  async function classify(cfg) {
    // bridge.py 认的是短 action 名（refresh / review），不是工具名 wechat_refresh。
    const refreshOnce = () => callBridge(cfg, 'refresh', {}, Number(cfg.refreshTimeoutMs) || 90000)
    const isBusy = (r) => {
      const e = r && r.error
      if (!e) return false
      const s = typeof e === 'string' ? e : JSON.stringify(e)
      return s.indexOf('busy') >= 0 || s.indexOf('正在刷新') >= 0
    }
    let refreshed = await refreshOnce()
    if (!refreshed || refreshed.ok !== true) {
      // 采集器常被另一处刷新占着（我自己刚调的 refresh 也在用它）。等一会儿重试，
      // 不要立刻判失败——判失败会白叫醒一次。
      if (isBusy(refreshed)) {
        for (let i = 0; i < 3 && isBusy(refreshed); i++) {
          note(`采集器忙，等 5 秒重试（第 ${i + 1} 次）`)
          await new Promise((r) => setTimeout(r, 5000))
          refreshed = await refreshOnce()
        }
      }
      if (!refreshed || refreshed.ok !== true) {
        const e = refreshed && refreshed.error
        return { ok: false, error: 'refresh: ' + (typeof e === 'string' ? e : JSON.stringify(e || 'unknown')) }
      }
    }
    const now = new Date()
    const from = new Date(now.getTime() - (Number(cfg.classifyWindowMin) || 3) * 60000)
    const reviewed = await callBridge(cfg, 'review', {
      start_time: from.toISOString(),
      end_time: new Date(now.getTime() + 60000).toISOString(),
      limit: 20,
    }, Number(cfg.reviewTimeoutMs) || 30000)
    if (!reviewed || reviewed.ok !== true) {
      const e = reviewed && reviewed.error
      return { ok: false, error: 'review: ' + (typeof e === 'string' ? e : JSON.stringify(e || 'unknown')) }
    }
    const data = reviewed.data || {}
    const msgs = Array.isArray(data.messages) ? data.messages : []
    return 归类(msgs, cfg)
  }

  /**
   * 把配置里的 target 解析成一个会话 id。
   * 先问路由插件（它认别名、也认读盘兜底），拿不到就退回「当成 id 用」——
   * 软依赖：session-router 没装或没加载，这里照旧按 id 走，不会跟着坏。
   */
  function resolveTarget(target) {
    try {
      const router = ctx.get ? ctx.get('sessionRouter') : undefined
      if (router && typeof router.resolve === 'function') {
        const r = router.resolve(target)
        if (r && !r.error && r.id) return { id: r.id, 方式: 'router' }
        if (r && r.error === 'ambiguous') return { id: '', 方式: 'router', 说: r.说 }
      }
    } catch { /* 路由不在就退回 id */ }
    return { id: target, 方式: 'id' }
  }

  /**
   * 投不进去的时候别让消息消失：问路由插件的收件箱要一格，落一封信，等那间房亮灯。
   * 软依赖——路由插件不在（或还是 0.2.0 没有 inbox），就只记日志，行为跟以前一样。
   */
  function 落信到收件箱(target, text, reason) {
    try {
      const router = ctx.get ? ctx.get('sessionRouter') : undefined
      const box = router && router.inbox
      if (!box || typeof box.落 !== 'function') return null
      const key = box.落(target, text, SOURCE_KIND, reason)
      if (key) note(`已落收件箱「${key}」（${reason}），那间房亮灯后门房会递`)
      return key
    } catch (e) {
      note('落收件箱失败：' + String((e && e.message) || e))
      return null
    }
  }

  async function nudge(cfg, why, 详情) {
    const 选 = 选房间(cfg, 详情)
    const target = 选.房间
    if (!target) { note('没配 target、也没有分类默认，跳过'); return }

    // 同一条消息会被相邻两轮各采到一次（库的 mtime 变了两次）。叫醒那条路有冷却挡着，
    // 落信这条路没有——2026-11-01 就因此给同一个 @ 落了两封。指纹只挡一模一样的那条。
    const 指纹 = 消息指纹(详情)
    if (指纹 === lastHandled) { note('同一条消息刚处理过，跳过'); return }
    lastHandled = 指纹

    // 叫醒的时候顺手把「谁、在哪、说了什么」带上：不然醒来还得自己再翻一次库，
    // 而那一次刷新又是一趟活。原文截 200 字，够判断要不要回。
    const 出处 = 详情 && 详情.会话
      ? `\n\n（来自 ${详情.会话}｜${详情.发送者 || ''}：${String(详情.原文 || '').slice(0, 200)}）`
      : ''
    // 只有规则判出来的才注明依据：兜底默认是常态，写出来只是噪音。
    const 判语 = 选.类 === 'rule' ? `\n（这条按${选.依据}判给${选.房间}）` : ''
    const text = (String(cfg.text || '').trim() || DEFAULT_TEXT) + 出处 + 判语
    const 信文 = text + '\n\n（门房注：这条本来是微信叫醒，来时这间房没开着，所以由门房代收。原因：' + why + '）'
    const 解 = resolveTarget(target)
    if (!解.id) {
      note(`目标「${target}」解析失败（${解.说 || '读不到这个房间'}），不叫醒`)
      落信到收件箱(target, 信文, 'not-found')
      return
    }
    const agent = findAgent(解.id)
    if (!agent) {
      note(`目标「${target}」→ ${解.id.slice(0, 18)} 没活着，不冷启动唤醒`)
      落信到收件箱(target, 信文, 'not-alive')
      return
    }

    const message = {
      id: 'nudge-' + crypto.randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: SOURCE_KIND },
    }
    try {
      // 必须 await：followup reject 会变成未处理 rejection，Node 22+ 会直接退掉宿主
      await agent.followup(message)
      lastNudge = Date.now()
      dayCount++
      nudgeCount++
      note(`已叫醒（${why}；→ ${target}（${选.依据}）；今日第 ${dayCount} 次，累计 ${nudgeCount} 次）`)
      try {
        if (ctx.sessions && typeof ctx.sessions.flush === 'function') await ctx.sessions.flush(agent.session)
      } catch { /* 落盘没确认就算了 */ }
    } catch (error) {
      lastError = String((error && error.message) || error)
      note('followup 失败：' + lastError)
      落信到收件箱(target, 信文, 'followup-failed')
    }
  }

  async function tick() {
    if (busy) return
    const cfg = readConfig()
    rollDay()
    if (!cfg.enabled) return

    // 没配好就先别动：缺微信库或缺 bridge.py 时硬跑只会每轮都判"分类失败"
    // 然后把不该叫的全叫醒。只在第一次说一声，别每 5 秒刷一条。
    if (!cfg.watchPath || !cfg.bridgeScript) {
      if (!warnedMissing) {
        warnedMissing = true
        note('配置不全（' + (!cfg.watchPath ? '没找到微信消息库' : '没找到 better-wechat 的 bridge.py')
          + '）→ 暂停监听，等配置好再点启用')
      }
      return
    }
    warnedMissing = false

    let st
    try { st = fs.statSync(String(cfg.watchPath || '')) } catch { return }
    const m = st.mtimeMs

    if (lastMtime === null) {
      lastMtime = m
      note('armed，基线 ' + hhmm(m) + '（每 ' + cfg.intervalSec + ' 秒看一次）')
      return
    }
    if (m <= lastMtime) return
    lastMtime = m

    const now = Date.now()
    if (now - lastNudge < Number(cfg.cooldownSec) * 1000) {
      note(`有动静，但在冷却里（${Math.round((now - lastNudge) / 1000)}s），先不叫`)
      return
    }
    const limit = Number(cfg.dailyLimit) || 0
    if (limit > 0 && dayCount >= limit) { note(`有动静，但今日已到上限 ${limit} 次`); return }
    if (inQuietHours(cfg)) { note('有动静，但在安静时段，跳过'); return }

    busy = true
    try {
      note('库动了 ' + hhmm(m) + ' -> 分类中')
      const r = await classify(cfg)
      lastClassifiedAt = Date.now()
      if (!r.ok) {
        lastError = r.error
        note('分类失败（' + r.error + '）→ 仍然叫醒，宁可多叫不漏')
        await nudge(cfg, '分类失败')
        return
      }
      lastSender = r.sender
      lastKind = r.kind || 'friend'
      lastConversation = r.会话 || ''
      if (r.sender === MY_LABEL) {
        note('最新一条是我发的（' + r.time + '）-> 不叫醒')
        return
      }
      if (r.sender === 'none') {
        note('窗口里没有可回的消息' + (r.只有系统消息 ? '（只有系统消息）' : '') + ' -> 不叫醒')
        return
      }
      if (r.kind === 'group') {
        if (cfg.群仅被at才叫 !== false && !r.atMe) {
          note(`群消息没 @ 我（${r.会话 || r.会话id.slice(0, 12)}）-> 不叫醒`)
          return
        }
        note(`群里被 @（${r.会话 || ''} ${r.time}）-> 叫醒`)
        await nudge(cfg, '群里被 @', { 会话: r.会话, 会话id: r.会话id, 发送者: r.sender, 原文: r.原文, time: r.time, kind: 'group' })
        return
      }
      note('最新一条是别人发的（' + r.sender + ' ' + r.time + '）-> 叫醒')
      await nudge(cfg, '新消息 ' + r.sender, { 会话: r.会话, 会话id: r.会话id, 发送者: r.sender, 原文: r.原文, time: r.time, kind: r.kind || 'friend' })
    } catch (e) {
      lastError = String((e && e.message) || e)
      note('tick 出错：' + lastError)
    } finally {
      busy = false
    }
  }

  const cfg0 = readConfig()
  const every = Math.max(3, Number(cfg0.intervalSec) || 5) * 1000
  ctx.effect(() => {
    const h = setInterval(() => { tick().catch(() => {}) }, every)
    return () => clearInterval(h)
  })

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-wechat-nudge/state',
    handler: async (req, res) => {
      try {
        const cfg = readConfig()
        回(res, {
          ok: true,
          版本: VERSION,
          配置: cfg,
          间隔秒: every / 1000,
          房间: roomList(),
          基线: lastMtime ? new Date(lastMtime).toISOString() : null,
          上次叫醒: lastNudge ? new Date(lastNudge).toISOString() : null,
          上次分类: lastClassifiedAt ? new Date(lastClassifiedAt).toISOString() : null,
          最新发送者: lastSender,
          最新类型: lastKind,
          最新会话: lastConversation,
          忙碌: busy,
          今日次数: dayCount,
          累计叫醒: nudgeCount,
          最后错误: lastError,
          配置文件: CONFIG_FILE,
          默认文案: DEFAULT_TEXT,
          日志: log.slice(-25),
        })
      } catch (e) {
        回(res, { ok: false, 说: String((e && e.message) || e) })
      }
    },
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-wechat-nudge/save',
    handler: async (req, res) => {
      try {
        const patch = await 读体(req)
        const saved = saveConfig(patch)
        const keys = Object.keys(patch || {})
        note('设置已保存（' + (keys.join('、') || '空提交') + '）')
        回(res, {
          ok: true,
          配置: { ...DEFAULTS, ...saved },
          提醒: 'intervalSec' in (patch || {}) ? '轮询间隔要重启 DSH 才生效，其余都是热的' : '',
        })
      } catch (e) {
        回(res, { ok: false, 说: String((e && e.message) || e) })
      }
    },
  }))

  note('已加载（v' + VERSION + '）：监听 + 分类 + 叫醒，设置页挂在 DSH 设置里')
}
