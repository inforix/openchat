# OpenChat

OpenChat 是一个面向 OpenClaw 的聊天前端与传输层设计仓库。目标是提供类似 Telegram / Discord 的 bot 聊天体验，但消息真相源和会话真相源始终留在用户自己的 OpenClaw Host 上。

## Current Status

当前仓库已经实现并验证了 v1 vertical slice 的核心模型：

- `openchat` 被建模为 OpenClaw 的一个 `channel`
- 每个 bot 对应 `openchat` 下的一个 `account`
- bot 身份固定为 `{hostId, accountId}`
- `activeSessionId` 由 Host 侧 `account-state.json` 持久化
- Web 侧支持 host-first bot 导航、active session、`/new`、归档会话只读、离线快照
- Playwright e2e 已覆盖配对展示、bot 创建确认、消息流、`/new`、离线只读、重连刷新、`session_conflict`

当前仓库还没有把 `apps/web -> apps/relay -> apps/edge` 接成真实联网运行链路。现阶段的端到端演示使用浏览器侧 harness，而不是实际 relay/edge 进程。

## Repository Map

- `apps/web`
  Next.js Web 客户端，当前 UI 与 e2e harness 都在这里。
- `apps/relay`
  Relay 领域逻辑与测试，当前是库级 main/service 组合，还不是完整 CLI 进程。
- `apps/edge`
  Edge 领域逻辑与测试，当前是库级 main/service 组合，还不是完整 CLI 进程。
- `packages/protocol`
  OpenChat 协议、ID 和错误定义。
- `packages/crypto`
  设备密钥、加密 envelope、pairing token 校验。
- `packages/openclaw-client`
  Host 侧 OpenClaw 配置与 session 状态适配器。
- `packages/store`
  Relay SQLite metadata store。
- `packages/ui`
  Web 共享组件。
- `tests/e2e`
  Workspace smoke 与 Playwright vertical-slice 流程。

## Verification

推荐用下面这组命令验证当前仓库：

```bash
pnpm --filter @openchat/web typecheck
pnpm --filter @openchat/web vitest run
pnpm --filter @openchat/relay vitest run
pnpm --filter @openchat/edge vitest run
pnpm --filter @openchat/protocol vitest run
pnpm --filter @openchat/crypto vitest run
pnpm --filter @openchat/openclaw-client vitest run
pnpm playwright test tests/e2e/openchat-flow.spec.ts
```

`pnpm test` 目前只跑 workspace smoke，不等于全量单测或 e2e。

## Task 11 Checklist

- `relay`
  当前只有库级 service 与测试，还没有可直接启动的网络进程入口。
- `edge`
  当前只有库级 service 与测试，还没有可直接启动的网络进程入口。
- `web`
  可用 `pnpm --filter @openchat/web dev` 启动 UI。
- `pair host`
  当前通过 Playwright harness 验证 `edgeKeyFingerprint` 展示与本地 trust pin。
- `create bot`
  当前通过 Playwright harness 验证“只有 Host 确认后才显示 bot”。
- `use /new`
  当前通过 Playwright harness 验证 active session 切换与归档只读。
- `reconnect after offline`
  当前通过 Playwright harness 验证离线快照、重连刷新 bot 列表与 `activeSessionId`。

## Limitations

- Web 客户端还没有真实接入 relay/edge transport。
- Relay/Edge 的 `build` 脚本当前只返回占位成功信息，不产出实际构建物。
- 配对 UI 当前只展示 `edgeKeyFingerprint` 的 trust-on-first-use 流程；短校验码 / 二维码还停留在设计与服务层。
- Relay SQLite 路径还没有仓库级默认值，当前由 `createRelayStore({ filename })` 的调用方决定。
