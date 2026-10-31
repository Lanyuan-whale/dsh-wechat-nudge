// DSH「微信叫醒」网页半边
//
// 只干一件事：在 DSH 设置左边栏加一页「微信叫醒」，把 wechat-nudge.json 里那些
// 数字与开关摆出来，改完点保存写回宿主（宿主那边是合并保存，只覆盖传上去的键）。
//
// ⚠ 这里不碰会话、不发消息、不读聊天 —— 只是往 /dsh-wechat-nudge/* 这组路由上读写。
//    真正的监听、分类、叫醒全在宿主半边（lib/host.js），逻辑只有一份。
//
// ⚠ 插槽名是 'settings.section'，dsh-speak-up / dsh-write 用的都是同一个。
window.__ModuleLoader__.load({
  id: 'dsh-wechat-nudge',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const inject = ['slots']

    const B = '/dsh-wechat-nudge'
    const get = (p) => fetch(B + p, { cache: 'no-store' }).then((r) => r.json()).catch(() => null)
    const post = (p, body) =>
      fetch(B + p, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
        .then((r) => r.json())
        .catch(() => null)

    const h = React.createElement

    // 样式贴着主题变量走，换皮肤、换深浅色都跟着变（照 dsh-speak-up 的做法）
    const S = {
      wrap: {
        padding: '12px 14px 24px',
        fontSize: 13,
        lineHeight: 1.7,
        background: 'var(--dsw-alias-bg-layer-1, rgba(255,255,255,.92))',
        border: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08))',
        borderRadius: 12,
      },
      h: { fontSize: 14, fontWeight: 600, margin: '16px 0 8px' },
      dim: { opacity: 0.62, fontSize: 12 },
      card: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 8,
        padding: '10px 12px',
        marginBottom: 10,
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      row: { display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 8, flexWrap: 'wrap' },
      lab: { minWidth: 150, paddingTop: 3, fontSize: 12.5 },
      ctl: { flex: '1 1 260px', minWidth: 200 },
      hint: { opacity: 0.6, fontSize: 11.5, marginTop: 2 },
      input: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        padding: '4px 8px',
        background: 'transparent',
        color: 'inherit',
        fontSize: 12.5,
        width: '100%',
      },
      small: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        padding: '4px 8px',
        background: 'transparent',
        color: 'inherit',
        fontSize: 12.5,
        width: 90,
      },
      area: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        padding: '6px 8px',
        background: 'transparent',
        color: 'inherit',
        fontSize: 12.5,
        width: '100%',
        minHeight: 72,
        resize: 'vertical',
        fontFamily: 'inherit',
        lineHeight: 1.6,
      },
      btn: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        padding: '4px 12px',
        background: 'transparent',
        color: 'inherit',
        fontSize: 12.5,
        cursor: 'pointer',
      },
      btnOn: {
        border: '1px solid transparent',
        borderRadius: 6,
        padding: '4px 12px',
        background: 'var(--dsw-alias-brand-primary, #2f6fed)',
        color: '#fff',
        fontSize: 12.5,
        cursor: 'pointer',
      },
      badge: {
        display: 'inline-block',
        padding: '1px 8px',
        borderRadius: 10,
        fontSize: 11.5,
        border: '1px solid var(--dsw-alias-border-l2)',
      },
      mon: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 11.5 },
      悬浮保存条: {
        position: 'sticky',
        bottom: 0,
        display: 'flex',
        gap: 10,
        alignItems: 'center',
        padding: '8px 12px',
        marginTop: 8,
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2, rgba(255,255,255,.96))',
        boxShadow: '0 2px 12px rgba(0,0,0,.12)',
      },
    }

    const 时刻 = (iso) => {
      if (!iso) return '—'
      const d = new Date(iso)
      if (Number.isNaN(d.getTime())) return '—'
      const p = (n) => String(n).padStart(2, '0')
      return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
    }

    /** 会话 id 的两种写法（带不带 session- 前缀）只当同一个。 */
    const 键 = (v) => {
      const s = String(v == null ? '' : v).trim()
      return s.startsWith('session-') ? s.slice('session-'.length) : s
    }
    const 短id = (id) => {
      const s = String(id)
      return s.length <= 8 ? s : s.slice(-8)
    }
    const 题 = (r) => (r && r.标题 && String(r.标题).trim() !== '' ? r.标题 : '（还没起名 · ' + 短id(r.id) + '）')

    function Section() {
      const [态, 设态] = React.useState(null)
      const [草, 设草] = React.useState(null)
      const [脏, 设脏] = React.useState(false)
      const [忙, 设忙] = React.useState(false)
      const [说, 设说] = React.useState('')

      const 拉 = React.useCallback(async () => {
        const r = await get('/state')
        if (r && r.ok) {
          设态(r)
          设草((旧) => 旧 || { ...r.配置 })
        } else {
          设说('读不到宿主那边的状态（插件加载了吗？）')
        }
      }, [])

      React.useEffect(() => { 拉() }, [拉])
      // 页面开着的时候每 5 秒看一眼运行状态（只看，不动表单）
      React.useEffect(() => {
        const t = setInterval(() => { 拉() }, 5000)
        return () => clearInterval(t)
      }, [拉])

      if (!态 || !草) {
        return h('div', { style: S.wrap },
          h('div', { style: S.h }, '微信叫醒'),
          h('div', { style: S.dim }, '读取中…'))
      }

      /** 改「要点保存」的字段（数字 / 文案）→ 置脏。 */
      const 改 = (k, v) => {
        设草((旧) => ({ ...旧, [k]: v }))
        设脏(true)
        设说('')
      }

      /** 点一下就落盘的字段（总开关、目标会话）。 */
      const 即存 = async (补丁, 话) => {
        设草((旧) => ({ ...旧, ...补丁 }))
        设说(话)
        const r = await post('/save', 补丁)
        if (!r || !r.ok) 设说('没存进去，看宿主的日志')
        拉()
      }

      const 存 = async () => {
        设忙(true)
        const r = await post('/save', {
          intervalSec: 草.intervalSec,
          cooldownSec: 草.cooldownSec,
          dailyLimit: 草.dailyLimit,
          quietStart: 草.quietStart,
          quietEnd: 草.quietEnd,
          classifyWindowMin: 草.classifyWindowMin,
          text: 草.text,
        })
        设忙(false)
        if (r && r.ok) {
          设脏(false)
          设说(r.提醒 || '已保存')
          设草({ ...r.配置 })
          拉()
        } else {
          设说('没存进去，看宿主的日志')
        }
      }

      const 房间们 = Array.isArray(态.房间) ? 态.房间 : []
      const 选中 = 键(草.target)
      const 目标在列表里 = 房间们.some((r) => 键(r.id) === 选中)
      const 运行中 = !!草.enabled
      const 日限 = Number(草.dailyLimit) || 0
      const 数 = (k, 步, 后缀) => h('span', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
        h('input', {
          type: 'number',
          value: 草[k] === undefined || 草[k] === null ? '' : 草[k],
          step: 步 || 1,
          style: S.small,
          onChange: (e) => 改(k, e.target.value),
        }),
        后缀 ? h('span', { style: S.dim }, 后缀) : null)

      const 行 = (标签, 控件, 提示) =>
        h('div', { style: S.row },
          h('div', { style: S.lab }, 标签),
          h('div', { style: S.ctl }, 控件, 提示 ? h('div', { style: S.hint }, 提示) : null))

      return h('div', { style: S.wrap },

        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
          h('div', { style: { fontSize: 15, fontWeight: 600 } }, '微信叫醒'),
          h('span', { style: S.badge }, 'v' + (态.版本 || '?')),
          h('span', {
            style: {
              ...S.badge,
              borderColor: 运行中 ? 'transparent' : 'var(--dsw-alias-border-l2)',
              background: 运行中 ? 'rgba(46,160,67,.16)' : 'transparent',
              color: 运行中 ? '#2ea043' : 'inherit',
            },
          }, 运行中 ? '监听中' : '已暂停'),
          h('span', { style: S.dim }, '微信库一动就判是谁发的，不是你就叫醒你'),
        ),

        // —— 一眼看得见的运行状态 ——
        h('div', { style: { ...S.card, marginTop: 10 } },
          h('div', { style: { display: 'flex', gap: 18, flexWrap: 'wrap' } },
            h('div', null, h('div', { style: S.dim }, '今日叫醒'), h('div', null, '第 ' + (态.今日次数 || 0) + (日限 > 0 ? ' / ' + 日限 : '') + ' 次')),
            h('div', null, h('div', { style: S.dim }, '上次叫醒'), h('div', { style: S.mon }, 时刻(态.上次叫醒))),
            h('div', null, h('div', { style: S.dim }, '上次分类'), h('div', { style: S.mon }, 时刻(态.上次分类))),
            h('div', null, h('div', { style: S.dim }, '最新一条来自'), h('div', null, 态.最新发送者 || '—')),
            h('div', null, h('div', { style: S.dim }, '基线'), h('div', { style: S.mon }, 时刻(态.基线))),
            h('div', null, h('div', { style: S.dim }, '轮询'), h('div', null, (态.间隔秒 || 0) + ' 秒')),
          ),
          h('div', { style: { ...S.dim, marginTop: 6 } },
            '配置文件 ' + (态.配置文件 || '') + '（改了会自动留一份 .bak）'),
          h('div', { style: { ...S.dim, marginTop: 2 } },
            '基线时间不动 ＝ 还没发现库有新动静；上面这几个数是宿主报的，不是猜的。'),
        ),

        // —— 总开关 ——
        h('div', { style: S.card },
          h('label', { style: { display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' } },
            h('input', {
              type: 'checkbox',
              checked: 运行中,
              onChange: (e) => 即存({ enabled: e.target.checked }, e.target.checked ? '已开始监听' : '已暂停监听'),
            }),
            h('span', { style: { fontWeight: 600 } }, '启用监听'),
          ),
          h('div', { style: S.hint }, '勾上就在跑；取消只是不叫醒，不动微信、不删任何东西。点一下即生效。'),
        ),

        // —— 目标会话（单选的：叫醒只往一间房投） ——
        h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '叫醒投到哪间房'),
          h('div', { style: S.hint, marginBottom: 6 },
            '点一下即生效。只有这间房开着的时候才叫得醒——它没活着就只记日志，不冷启动（省 token）。'),
          房间们.length === 0
            ? h('div', { style: S.dim }, '现在没有活着的会话（DSH 刚起来时也会这样，等几秒）')
            : 房间们.map((r) =>
                h('label', {
                  key: r.id,
                  style: { display: 'flex', gap: 8, alignItems: 'center', padding: '3px 0', cursor: 'pointer' },
                },
                  h('input', {
                    type: 'radio',
                    name: 'nudge-target',
                    checked: 键(r.id) === 选中,
                    onChange: () => 即存({ target: r.id }, '目标改到「' + 题(r) + '」'),
                  }),
                  h('span', null, 题(r)),
                  r.状态 ? h('span', { style: S.dim }, '· ' + r.状态) : null,
                )),
          !目标在列表里 && 选中
            ? h('div', { style: { ...S.hint, color: '#c0392b' } },
                '现在配的目标 ' + 短id(草.target) + ' 不在活着的列表里（可能没开着）。')
            : null,
        ),

        // —— 节流 ——
        h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '叫多密'),
          行('轮询间隔', 数('intervalSec', 1, '秒'), '每几秒看一眼微信库。改了要重启 DSH 才生效，其余都是热的。'),
          行('冷却', 数('cooldownSec', 5, '秒'), '两次叫醒之间至少隔多久，免得一串消息把你叫醒好几遍。'),
          行('日限', 数('dailyLimit', 10, '次'), '一天最多叫几次，填 0 表示不限。本机记账，重启归零。'),
          行('分类窗口', 数('classifyWindowMin', 1, '分钟'), '判「最新一条是谁发的」时往回看多久。'),
        ),

        // —— 安静时段 ——
        h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '安静时段'),
          行('起 / 止', h('span', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
            数('quietStart', 1, '点'),
            h('span', { style: S.dim }, '到'),
            数('quietEnd', 1, '点'),
          ), '按 24 小时填。两格填一样（比如都 0）＝ 不设安静时段。跨夜直接填，例如 23 到 7。'),
        ),

        // —— 叫醒文案 ——
        h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '叫醒时投的那句话'),
          h('textarea', {
            style: S.area,
            value: 草.text === undefined || 草.text === null ? '' : 草.text,
            placeholder: '留空就用默认的那段（先让你去采一次、按需读、该回就回、不必复述这条提示）。',
            onChange: (e) => 改('text', e.target.value),
          }),
          h('div', { style: { display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' } },
            h('button', {
              style: S.btn,
              onClick: () => 改('text', 态.默认文案 || ''),
            }, '填入默认文案'),
            h('button', {
              style: S.btn,
              onClick: () => 改('text', ''),
            }, '清空（＝用默认）'),
          ),
          h('div', { style: S.hint }, '这段话是以「别人转来的提示」身份进那一轮的，不会冒充你本人说话。'),
        ),

        // —— 日志 ——
        h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '最近发生了什么'),
          Array.isArray(态.日志) && 态.日志.length
            ? h('div', null, 态.日志.slice(-10).reverse().map((l, i) =>
                h('div', { key: i, style: { display: 'flex', gap: 8, padding: '1px 0' } },
                  h('span', { style: { ...S.mon, ...S.dim, flex: '0 0 auto' } }, l.时间),
                  h('span', { style: { fontSize: 12 } }, l.文本),
                )))
            : h('div', { style: S.dim }, '还没有记录。'),
          !态.最后错误 ? null : h('div', { style: { ...S.hint, color: '#c0392b', marginTop: 6 } }, '最后错误：' + 态.最后错误),
        ),

        // —— 悬浮的保存条：有没保存的改动才冒出来 ——
        脏
          ? h('div', { style: S.悬浮保存条 },
              h('span', { style: { fontWeight: 600, color: '#c0392b' } }, '⚠ 有改动还没保存'),
              h('span', { style: S.dim }, '数字和文案改完点这里'),
              h('button', { style: S.btnOn, disabled: 忙, onClick: 存 }, 忙 ? '保存中…' : '保存设置'),
            )
          : null,

        说 ? h('div', { style: { ...S.hint, marginTop: 6 } }, 说) : null,
      )
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('settings.section', () =>
        slots.register(
          { name: 'settings.section', id: 'wechat-nudge', order: 54, label: () => '微信叫醒' },
          Section,
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
