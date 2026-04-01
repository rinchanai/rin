# Rin 重构执行清单

- [x] 去掉 jiti，统一运行边界为 dist-only runtime
- [x] 将 extensions 纳入构建产物，消灭 source/dist 混跑
- [x] 抽取公共 platform primitives，清理重复基础设施
- [x] 抽取公共 sidecar primitives，统一 koishi / web-search 生命周期管理
- [x] 为关键边界补 schema / 类型收口（RPC、cron、sidecar state 等）
- [x] 为主要模块补基础测试覆盖，并接入统一 `npm test`
- [x] 拆分 `src/core/rin/main.ts`
- [x] 拆分 `src/core/rin-install/main.ts`
- [x] 拆分 `extensions/memory/store.ts`
- [x] 拆分 `src/core/rin-koishi/main.ts`
- [x] 拆分 `src/core/rin-tui/runtime.ts`
- [x] 落地统一 session façade
- [x] 拆分 memory core / derivation
- [x] 将 koishi 收束为 chat bridge 结构
- [x] 跑通构建、自检并清理残留依赖
