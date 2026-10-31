# dsh-wechat-nudge

微信来了新消息，把一条「去看看」的提示投进你指定的 DSH 会话。

它不读聊天内容、不发消息、也不判断该不该回——只负责叫醒。叫醒之后要不要回、怎么回，交给那个会话说。

- 只看微信本地库文件的**修改时间**，不看正文
- 采集与索引全在本机完成，不联网
- 不点击微信窗口、不模拟输入、不发送任何消息

---

## 它怎么工作

1. 每 `intervalSec` 秒 `stat` 一次微信消息库的 `message_0.db-wal`（只拿 mtime）
2. 时间变了 → 调 `dsh-better-wechat` 的 `python/bridge.py` 做一次**增量**采集
3. `review` 最近 `classifyWindowMin` 分钟，取最新一条的 `sender_label`
4. 不是你发的 → 往目标会话 `followup` 一条 `source.kind = 'mail'` 的提示，把那一轮叫醒
   是你自己发的 → 只记日志，不叫醒

为什么不自己解密微信库：那件事 `dsh-better-wechat` 已经做完了，而且它内部有现成的增量采集接口。本插件不重复实现，只调用。

---

## 和另外两个插件的关系

一个能用的「微信通道」是三段：

| 段 | 插件 | 干什么 |
| --- | --- | --- |
| 读 | `dsh-better-wechat` | 解密本地库、建索引、给会话读消息 |
| 叫 | **本插件** | 有新消息时把会话叫醒 |
| 回 | `dsh-computer-use-win` | 真键鼠点微信、打字、回车发送 |

只装前两个就已经很好用：**只有读和叫，零输入风险**——不会替你按任何键，最多是让会话里多一条提示。要让她真的能回话，再补上键鼠那一段；键鼠是可选的，不是必需的。

---

## 前置条件

- DeepSeek Harness（desktop 或 web profile 均可）
- 已安装并跑通 [`dsh-better-wechat`](https://github.com/CH3SH-LC/dsh-better-wechat)：它的 `wechat_refresh` 能采到新消息
- Windows（默认按微信 4.x 的目录去探测消息库；其它系统在配置里手填 `watchPath`）

---

## 安装

本地包要**两处登记**，缺一不可：

1. profile 的 `package.json` → `dependencies` 里加 `"dsh-wechat-nudge": "link:<本仓库路径>"`
2. 同一个文件的 `dsh.profile.bundles` 数组里加 `"dsh-wechat-nudge"`

然后用 pnpm 装（用 DSH 自带的那个 pnpm 最省事），重启 DSH。

装好后在 DSH 设置里会多一页「微信叫醒」。

---

## 配置

配置文件：`~/.dsh/wechat-nudge.json`（可用环境变量 `DSH_WECHAT_NUDGE_CONFIG` 指到别处）。

**仓库里没有任何本机路径**，下面几项留空就自动探测：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `target` | `""` | 叫醒投到哪个会话（session id）。在设置页里点选，不用手填 |
| `watchPath` | 自动 | 微信消息库 `-wal` 的路径。留空＝在 `~/Documents/xwechat_files/*/db_storage/message/message_0.db-wal` 里找第一个 |
| `bridgePython` | 自动 | 采集器的 Python。优先用 better-wechat 的私有运行器，没有就 `python` |
| `bridgeScript` | 自动 | `bridge.py` 的路径。留空＝从已安装的 `dsh-better-wechat` 包里找 |
| `bridgeState` | 自动 | 采集器的 state 目录 |
| `intervalSec` | `5` | 轮询间隔。**改了要重启 DSH**，其它项都是热的 |
| `cooldownSec` | `60` | 两次叫醒之间至少隔多久 |
| `dailyLimit` | `200` | 一天最多叫几次，`0` ＝ 不限（内存计数，重启归零） |
| `quietStart` / `quietEnd` | `0` / `0` | 安静时段（24 小时制）。两者相等 ＝ 不设；可跨夜，例如 `23` 到 `7` |
| `classifyWindowMin` | `3` | 判「最新一条是谁发的」时往回看多久 |
| `text` | `""` | 叫醒时投的那句话。留空用内置默认 |

`save` 是**合并**语义：只覆盖你提交的键，写之前把旧的存一份 `.bak`。

---

## 设置页

DSH 设置 → 微信叫醒：

- 顶部一眼看到状态：监听中／已暂停、今日第几次、上次叫醒、上次分类、最新一条来自谁、基线时间
- 总开关、目标房间（单选）、轮询间隔、冷却、日限、分类窗口、安静时段、叫醒文案
- 底部是最近十条日志和最后一次错误

总开关与目标房间**点一下即生效**；数字与文案走底部那条保存条——故意分开，免得手滑点错一个数字就改了行为。

---

## 已知限制

- 依赖 `dsh-better-wechat` 的 `bridge.py` 内部接口（短 action 名 `refresh` / `review`）。上游若改接口，这里要跟着改
- 判「谁发的」依赖采集结果里 `sender_label` 的约定（自己发的标成「我」）
- 目标会话没开着时**不冷启动唤醒**（省 token），只记日志
- 采集器正在刷新时会回 `busy`，这里等 5 秒重试，最多三次
- 分类失败时仍会叫醒——宁可多叫一次，不漏
- 只在 Windows 上验证过

---

## 致谢

- [`dsh-better-wechat`](https://github.com/CH3SH-LC/dsh-better-wechat)（MIT AND Apache-2.0）：微信本地库的解密、采集、索引与 `bridge.py` 全部是它的工作。本插件只是站在它上面按了一下门铃
- [`dsh-speak-up`](https://github.com/Yuuyuko-uu/dsh-speak-up)（Yuuyuko-uu）：设置页的形态照它抄的——`settings.section` 插槽、`window.__ModuleLoader__` 的客户端写法、贴着主题变量的样式
- [DeepSeek Harness](https://github.com/deepseek-ai)：插件的宿主

## License

MIT
