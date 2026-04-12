[English](README.md) | [中文](README.zh-CN.md) | [日本語](README.ja.md) | [Español](README.es.md) | [Français](README.fr.md)

# Rin

Rin 是一个终端优先的本地 AI 助手，而且不是一次性对话用完就丢的那种。

它可以聊天、改文件、记住长期偏好、联网搜索、跑定时任务，还能通过 Koishi 接到聊天平台上，统一围绕一个入口：`rin`。

## Rin 适合做什么

Rin 适合那些希望把助手长期留在日常工作流里，而不是每次都重新开一个一次性 agent 的人。

你可以用它来：

- 在终端里查看和修改代码库
- 保留稳定记忆和可复用技能
- 设置提醒和周期检查
- 不跳出当前工作流就查询最新信息
- 在终端和聊天里延续同一个助手

## 当前项目状态

Rin 已经可以使用，但仍然处于持续打磨阶段。

核心方向已经比较稳定：

- 本地优先工作流
- 内建记忆与回忆
- 内建定时任务
- 内建 Web 搜索与页面抓取
- 支持 Koishi 聊天桥
- 安装、运行、更新路径统一

但可靠性、交互体验和文档还在持续收敛。如果你现在就尝试它，看到的会是一个持续进化中的产品，而不是完全冻结的平台。

## 快速开始

安装：

```bash
./install.sh
```

打开 Rin：

```bash
rin
```

需要时检查状态：

```bash
rin doctor
```

## 核心命令

```bash
rin            # 打开 Rin
rin doctor     # 检查健康状态和配置
rin start      # 启动 daemon
rin stop       # 停止 daemon
rin restart    # 重启 daemon
rin update     # 更新已安装的 Rin 运行时
```

## 你可以直接这样让 Rin 做事

比如：

- `帮我看看这个目录里什么最重要。`
- `把这个 README 重写一下。`
- `整理一下这个配置文件。`
- `记住我喜欢简短回答。`
- `明天下午提醒我检查日志。`
- `帮我查一下这个工具最新的官方文档。`
- `每小时看看这个目录有没有变化。`

## 默认内建能力

Rin 默认就接好了这些能力：

- 长期记忆与回忆
- 定时任务和提醒
- 实时 Web 搜索
- 直接 URL 抓取
- subagent
- Koishi 聊天桥

## 更新 Rin

对于正常安装的运行时，直接使用：

```bash
rin update
```

如果当前账号下没有 `rin`，不要立刻判断 Rin 没装。更常见的原因是当前 shell 用户并不是 launcher 所属用户。

完整的恢复 / 更新路径可以看：

- [`docs/user/getting-started.md`](docs/user/getting-started.md)
- [`docs/troubleshooting.md`](docs/troubleshooting.md)

## 文档

面向用户的文档：

- [`docs/user/getting-started.md`](docs/user/getting-started.md)
- [`CHANGELOG.md`](CHANGELOG.md)
- [`docs/troubleshooting.md`](docs/troubleshooting.md)
- [`docs/roadmap.md`](docs/roadmap.md)

面向贡献者的文档：

- [`docs/development.md`](docs/development.md)
- [`CONTRIBUTING.md`](CONTRIBUTING.md)
- [`docs/architecture.md`](docs/architecture.md)
- [`docs/security.md`](docs/security.md)
- [`docs/dependency-upgrades.md`](docs/dependency-upgrades.md)
- [`docs/release-management.md`](docs/release-management.md)

面向 agent / runtime 的文档：

- [`docs/rin/README.md`](docs/rin/README.md)
- [`docs/rin/docs/capabilities.md`](docs/rin/docs/capabilities.md)
- [`docs/rin/docs/runtime-layout.md`](docs/rin/docs/runtime-layout.md)
- [`docs/rin/docs/builtin-extensions.md`](docs/rin/docs/builtin-extensions.md)

## 一句话总结

装好它，运行 `rin`，然后把助手长期留在你的工作流里。

这就是 Rin 的核心意义。
