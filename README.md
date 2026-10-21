# dsh-one-memory

DeepSeek Harness 插件：一份**全局记忆** + 一组**键值记忆**，会话开始时注入全局记忆和所有 key 的目录；主 agent 的对话轮次归档进本地 SQLite，模型可以按 session id + turn 回放原始对话。

- 全局记忆使用保留 key `@global`；
- 键值记忆由模型通过工具手动创建、更新、删除；不做自动抽取、自动合并或自动过期；
- 来源以 Markdown 内联引用写在记忆正文里：`[1](m-lq2x9d3f:12)`；插件**不解析**引用，模型读 id 后自己调用 `memory_recall`；
- 会话 id 由插件统一生成（`m-...`），映射宿主的原生 session id；
- 一轮对话 = 一个用户消息（或同轮 steering 消息）+ 该轮最终的 assistant 文本；工具调用、思维链、注入上下文都不归档。

## 存储

`~/.agents/one-memory/one-memory.db`（目录 0700、文件 0600、WAL）：

```text
~/.agents/one-memory/one-memory.db
├── meta(key, value)                        # schema 版本、全局 revision
├── memory_entry(...)                       # 全局 + 键值记忆
├── memory_tombstone(...)                   # 增量注入用的删除记录
├── memory_session(id, agent, native_id)    # 统一会话 id ↔ 宿主原生 id
└── round(agent, session, turn, time, user_text, answer, text)
```

- 与 [opencode-one-memory](../opencode-one-memory) 共用同一个库；
- 首次启动会从旧位置 `~/.agent-memory/agent-memory.db` 复制一份（`VACUUM INTO`），并导入更早的 `~/.dsh/memory/memory.json`；
- 运行时适配：Node 用 `node:sqlite`，Bun 用 `bun:sqlite`（见 `src/core/db.ts`），插件本体零运行时依赖。

## 工具

| 工具 | 作用 |
| --- | --- |
| `memory_get({ key? })` | 读一条记忆；不传 key 返回全局记忆 + 完整 key 目录 + 当前 session id / turn |
| `memory_set({ key, value, description? })` | 创建/更新；`key = "@global"` 更新全局记忆 |
| `memory_delete({ key })` | 删除；`@global` 清空全局记忆 |
| `memory_recall({ session_id?, turn?, before?, after? })` | 从归档回放一轮；默认当前会话 + 最新一轮 |
| `session_list({ query?, include_subagents?, offset?, limit? })` | 会话列表；每行给统一 id 和宿主 id |
| `session_search({ query, session_id?, max_sessions?, limit? })` | 先搜归档，归档为空才回退到 DSH 的 FTS/字面扫描 |

## 安装

```bash
cd /path/to/dsh-one-memory && npm install && npm run build
```

然后在 DSH 里安装这个目录作为 bundle（profile 用 `link:` 指向该目录，因此必须已经构建出 `lib/`，且目录自包含）。

## 界面

插件带一个浏览器面板：左侧栏「全局面板」里的**记忆**图标，主区打开管理页面，可编辑全局记忆、增删改键值记忆，每 5 秒轮询外部改动。

## 开发

```bash
npm test        # 构建 + node --test
```
