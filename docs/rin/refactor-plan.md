# Rin 整理 / 重构总方案

> 目标：在不改变 Rin 核心功效的前提下，以第一性原理与 KISS 为准，系统性降低代码复杂度、架构耦合和设计重量。

## 1. 总体目标

Rin 的第一性定义应明确为：

**Rin = 一个有长期记忆和后台执行能力的本地会话助手。**

围绕这个定义，Rin 真正的一等公民只有三类：

- `session`
- `memory`
- `tasks`

其余能力都应围绕这三者服务，而不是与之并列成为系统主轴。

---

## 2. 保留不动的关键设计决策

以下方向已经正确，应保留并强化，而不是推倒重来：

### 2.1 `src/app` / `src/core` 分层

当前的产品装配层与核心运行层分离思路正确：

- `src/app/` 负责产品装配与可执行入口
- `src/core/` 负责可复用、可独立运行的核心实现

后续应继续强化这条边界。

### 2.2 memory 以 markdown 为 source of truth

当前 memory 系统选择：

- markdown + frontmatter
- event ledger
- lexical retrieval
- relation graph

这是符合 Rin 产品定位的轻量、可读、可维护方案，应继续保留。

### 2.3 daemon + worker pool + session 复用

Rin 的长期运行能力依赖：

- daemon
- worker pool
- session 复用

这一套是 Rin 区别于单次对话型 agent 的关键，不应轻易动摇。

### 2.4 保留 SearXNG 搜索方案

搜索能力目前由本地 SearXNG sidecar 支撑。虽然实现重量较高，但：

- 职责边界单纯
- 第三方替代不成熟
- 自行重造轮子不符合 KISS

因此不替换搜索方案本体，只整理其外围架构。

### 2.5 scheduled tasks 作为内建能力

定时任务能力是 Rin 作为“长期助手”而不只是“聊天 agent”的关键特征，应继续保留并强化。

---

## 3. 设计层目标架构

建议将 Rin 重新收束为四层：

## 3.1 Core Domain

真正核心层，只保留：

- session runtime
- memory store / retrieval
- scheduled tasks

## 3.2 Product Shell

产品壳层：

- CLI
- TUI
- installer
- updater
- doctor

## 3.3 Capability Extensions

扩展能力层：

- memory derivation（extractor / episode / onboarding）
- web-search tool
- koishi tools
- subagent
- attention resources 等

## 3.4 Infrastructure / Sidecars

基础设施层：

- daemon
- worker pool
- koishi bridge runtime
- searxng sidecar
- lock / state / process 管理

这四层的目标是：

- 主轴只保留 session / memory / tasks
- 其余能力从中枢地位回落为壳层、扩展层或基础设施层

---

## 4. 需要减重和收边界的设计项

## 4.1 session 必须成为唯一核心对象

### 现状问题

当前多个模块都在直接管理 session 生命周期：

- daemon worker
- cron
- koishi
- tui runtime
- subagent

这导致：

- session 创建逻辑分散
- 恢复/切换策略分散
- 输出收集方式分散
- 不同入口下行为容易出现微差异

### 目标

所有“跑一次 agent turn”的行为，都经过统一 session façade。

### 建议结构

新增统一层：

- `src/core/session/factory.ts`
- `src/core/session/runner.ts`
- `src/core/session/binding.ts`

统一负责：

- 创建 session
- 恢复 session
- 绑定 session 文件/名称
- prompt + wait for idle
- 读取最终输出
- 扩展绑定

### 预期收益

- session 成为真正主轴
- cron / koishi / worker / tui 行为一致
- 降低横向耦合

---

## 4.2 memory 拆为 core 与 derivation 两层

### 现状问题

当前 memory 系统除存储与检索外，还承担：

- extractor
- episode synthesis
- onboarding / init
- compile 逻辑
- event processing
- relation graph

问题不在 markdown，而在于 memory 逐渐膨胀成一个超级中枢。

### 目标

将 memory 分成两层：

#### Memory Core

负责：

- markdown doc
- frontmatter normalize
- event ledger
- relation graph
- retrieval
- compile

#### Memory Derivation

负责：

- extractor
- episode synthesis
- onboarding / init
- 未来其他总结/派生流程

### 建议目录

- `extensions/memory/core/*`
- `extensions/memory/derivation/*`

### 预期收益

- memory 本体保持稳定
- 智能派生流程可独立演进
- 避免所有“会理解历史的流程”都塞进同一后端文件

---

## 4.3 Koishi 从“重桥接子系统”降为 chat bridge adapter

### 现状问题

当前 Koishi 相关代码同时承担：

- transport adapter
- inbound persistence
- reply / quote 关系
- trust / identity policy
- session binding
- outbox delivery
- typing 状态
- attachment 处理

这使 Koishi 不再只是 bridge，而像一个大而全的聊天接入子系统。

### 目标

系统概念应从 `Koishi` 上升为 `Chat Bridge`。

Koishi 只是其中一种 adapter/runtime，而非系统主概念。

### 目标拆分

拆为三个概念层：

- `chat-transport`
- `chat-session-binding`
- `chat-policy`

Koishi 负责：

- transport glue
- 平台接入
- 少量 adapter-specific 逻辑

### 预期收益

- 降低 Koishi 对全局架构的占位
- 权限策略、会话绑定、平台接入不再糊成一团
- 后续 bridge 替换或扩展更自然

---

## 4.4 installer / updater 从“全能入口”拆为三段

### 现状问题

当前安装体系同时承担：

- install
- update
- runtime publish
- daemon service config
- docs install
- provider auth init
- koishi config
- target discovery
- manifest maintenance

问题不是功能多，而是边界过宽。

### 目标

将安装体系分为三段：

#### bootstrap

负责：

- 安装 runtime
- 写入 launcher
- 准备运行目录

#### configure

负责：

- provider auth
- 初始 settings
- koishi config

#### operate

负责：

- update
- doctor
- repair
- migrate

### 预期收益

- install / update / repair 不再混成一个动作
- 结构更像产品而非大型脚本

---

## 4.5 search 保留方案，只收边界

### 结论

搜索不替换，不重做，不试图自行发明轻量替代。

### 只做这些调整

- 视其为基础设施组件，而不是产品核心逻辑
- sidecar 生命周期纳入统一管理模型
- 将其复杂度约束在自身模块内部，不向全局扩散

### 原则

search 的问题不是“太重”，而是“实现重但职责单纯”。

这类组件应：

- 保留选型
- 整理外围基础设施
- 不进行概念级重写

---

## 5. 代码层核心改造项

## 5.1 彻底移除 jiti

### 目标

统一运行模型：

- 开发态也尽量通过构建产物运行
- 安装态只运行 dist
- 不再允许 source fallback 成为正式运行路径

### 需要完成的事情

- 将 `extensions/*` 纳入构建输出
- `src/app/builtin-extensions.ts` 指向构建产物路径
- `extensions/memory/lib.ts` 不再动态加载 `.ts`
- `extensions/koishi-get-message/index.ts` 不再在 `src` / `dist` 间双找
- `src/core/rin-lib/loader.ts` 去掉 jiti 相关逻辑

### 预期收益

- 运行边界统一
- 安装包更稳定
- 调试路径更清晰
- 明显降低环境差异问题

---

## 5.2 消灭 source / dist 混跑

### 原则

正式运行环境应只存在两种状态：

- dev build
- installed dist runtime

不应再出现“部分模块从 dist 运行，部分模块回退到 src 动态加载”的混合状态。

---

## 5.3 抽公共 platform primitives

### 建议新增目录

- `src/core/platform/fs.ts`
- `src/core/platform/process.ts`
- `src/core/platform/json-state.ts`
- `src/core/platform/lock.ts`
- `src/core/platform/user-env.ts`

### 统一收口的内容

- `safeString`
- `ensureDir`
- `ensurePrivateDir`
- `writeJsonAtomic`
- `isPidAlive`
- `sleep`
- `shellQuote`
- `runPrivileged`
- 用户切换与目标用户 runtime env 构造

### 预期收益

- 消除重复基础设施实现
- 不同模块行为更一致
- 以后侧重“抽象复用”，而非继续复制粘贴

---

## 5.4 抽 sidecar 公共层

### 建议新增目录

- `src/core/sidecar/registry.ts`
- `src/core/sidecar/instance.ts`
- `src/core/sidecar/lock.ts`
- `src/core/sidecar/status.ts`

### 适用对象

- `src/core/rin-koishi/service.ts`
- `src/core/rin-web-search/service.ts`

### 统一内容

- instance state 管理
- lock 文件获取/释放
- orphan cleanup
- start / stop / status 模型

### 预期收益

- sidecar 生命周期管理一致化
- 降低 Koishi / web-search 模块内部重复
- 避免未来新增 sidecar 时继续复制相同模式

---

## 5.5 给系统边界建立 schema

### 需要 schema 化的边界

- RPC command / response
- cron task record
- koishi message record
- sidecar state
- memory doc metadata

### 原则

不追求厚重框架，只追求：

- 边界清晰
- 输入可验证
- 状态结构可演进

### 预期收益

- 降低“静默容错”导致的脏状态风险
- 重构时更容易识别破坏面
- 有利于 doctor / migrate / repair 能力演进

---

## 6. 超级文件拆分方案

## 6.1 `src/core/rin/main.ts`

建议拆分为：

- `src/core/rin/cli.ts`
- `src/core/rin/daemon-control.ts`
- `src/core/rin/update.ts`
- `src/core/rin/doctor.ts`
- `src/core/rin/tmux.ts`

并在拆分过程中清理当前遗留的未使用逻辑。

---

## 6.2 `src/core/rin-install/main.ts`

建议拆分为：

- `install/interactive.ts`
- `install/publish.ts`
- `install/bootstrap.ts`
- `install/configure-provider.ts`
- `install/configure-koishi.ts`
- `install/service-systemd.ts`
- `install/service-launchd.ts`
- `install/update-targets.ts`
- `install/manifest.ts`

---

## 6.3 `extensions/memory/store.ts`

建议拆分为：

- `memory/core/schema.ts`
- `memory/core/markdown.ts`
- `memory/core/layout.ts`
- `memory/core/events.ts`
- `memory/core/graph.ts`
- `memory/core/search.ts`
- `memory/core/compile.ts`
- `memory/core/actions.ts`

---

## 6.4 `src/core/rin-koishi/main.ts`

建议拆分为：

- `rin-koishi/controller.ts`
- `rin-koishi/inbound.ts`
- `rin-koishi/outbound.ts`
- `rin-koishi/attachments.ts`
- `rin-koishi/prompt-meta.ts`
- `rin-koishi/policy.ts`

---

## 6.5 `src/core/rin-tui/runtime.ts`

建议拆分为：

- `rin-tui/session-state.ts`
- `rin-tui/remote-agent.ts`
- `rin-tui/reconnect.ts`
- `rin-tui/extensions.ts`
- `rin-tui/stats.ts`

---

## 7. 组件处理策略总表

| 组件                   | 策略   | 说明                                            |
| ---------------------- | ------ | ----------------------------------------------- |
| session                | 强化   | 成为唯一核心对象                                |
| memory store           | 强化   | 保留 markdown 本体，只拆职责                    |
| memory derivation      | 减重   | extractor / episode / onboarding 从 core 中拆出 |
| koishi bridge          | 减重   | 从重子系统收束为 chat bridge adapter            |
| installer / updater    | 减重   | 从全能入口拆为多阶段模型                        |
| search / SearXNG       | 收边界 | 保留选型，只治理生命周期与重复基础设施          |
| jiti / source fallback | 删除   | 纯运行边界负债，直接砍掉                        |

---

## 8. 推荐实施顺序

## 阶段 1：先打基础，不改产品行为

### 目标

降低后续重构风险。

### 任务

1. 给关键边界补 characterization tests
2. schema 化 RPC / cron / sidecar state
3. 抽 platform primitives
4. 抽 sidecar primitives

### 结果

后续拆文件和改结构时更稳。

---

## 阶段 2：清运行边界

### 目标

移除 jiti，消灭 source / dist 混跑。

### 任务

1. 扩展进入 build
2. 所有 runtime 只跑 dist
3. 移除 source fallback
4. 删除 jiti 依赖链

### 结果

系统运行模型统一。

---

## 阶段 3：拆大文件，收硬边界

### 目标

显著降低维护复杂度。

### 任务

1. 拆 `src/core/rin/main.ts`
2. 拆 `src/core/rin-install/main.ts`
3. 拆 `extensions/memory/store.ts`
4. 拆 `src/core/rin-koishi/main.ts`
5. 拆 `src/core/rin-tui/runtime.ts`

### 结果

代码结构开始真实反映设计结构。

---

## 阶段 4：做概念级重构

### 目标

让系统真正符合第一性定义。

### 任务

1. 落地 session façade
2. 落地 memory core / derivation 分层
3. 落地 chat bridge 模型
4. 落地 installer 三段模型

### 结果

Rin 从“整理后的代码库”进化为“设计清楚的长期产品”。

---

## 9. 可立即开始的执行项

建议优先开工顺序如下：

### 第一批

1. 移除 jiti 的完整路线图
2. 扩展构建产物化
3. 抽 `platform/fs` 与 `platform/process`
4. 清理并拆分 `src/core/rin/main.ts`

### 第二批

5. 抽 sidecar 基础层
6. 拆 `src/core/rin-install/main.ts`
7. 拆 `extensions/memory/store.ts`

### 第三批

8. 落地统一 session façade
9. 重构 koishi 为 chat bridge 结构
10. 整理 memory derivation

---

## 10. 最终目标状态

整理完成后的 Rin，应满足以下标准：

### 运行上

- 安装态只运行 dist
- 无 source fallback
- 无 jiti
- sidecar 生命周期统一

### 代码上

- 无超级文件
- 公共基础设施不重复
- 核心边界具备 schema
- session 相关逻辑集中

### 设计上

- session 是唯一主对象
- memory store 与智能派生分离
- koishi 是 bridge，不是中枢
- installer / updater 职责分明
- search 保持稳定，不瞎折腾

---

## 11. 一句话总结

本次整理的核心不是“重写 Rin”，而是：

**把已经正确的产品方向保留下来，把历史累积的运行边界混乱、重复基础设施、超级文件和组件过重问题系统性清掉。**
