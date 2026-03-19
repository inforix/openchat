# Local Development

## Scope

这个仓库当前更接近“可验证的 vertical slice + 领域服务集合”，而不是已经能独立启动三进程并手动完成聊天的成品。

现实状态如下：

- `apps/web` 可以单独启动并渲染 UI
- `apps/relay` 已有真实 CLI/bootstrap 入口，会启动 HTTP/WebSocket relay 并初始化 SQLite store
- `apps/edge` 已有真实 CLI/bootstrap 入口，会连接 relay，并通过本机 `openclaw` CLI / gateway 调用 Host 能力
- Web 的 Playwright e2e 通过浏览器内 `OpenChatE2EHarness` 驱动权威场景，不经过真实 relay/edge 网络链路

## Prerequisites

- Node.js 22+
- `pnpm` 10.x
- macOS 上若跑 Playwright，建议系统已安装 Chrome；当前配置使用 `channel: "chrome"`

安装依赖：

```bash
pnpm install
```

## Environment Variables

当前没有必须配置的运行时环境变量，但 `relay` 已支持以下可选 env：

- `OPENCHAT_RELAY_HOST`
  Relay 监听地址，默认 `127.0.0.1`
- `OPENCHAT_RELAY_PORT`
  Relay 监听端口，默认 `3001`；也支持 `0` 让系统分配临时端口
- `OPENCHAT_RELAY_STATE_DIR`
  Relay 状态目录，默认 `<cwd>/.openchat-state`
- `OPENCHAT_RELAY_SQLITE_PATH`
  Relay SQLite 文件路径，默认 `<cwd>/.openchat-state/relay/relay.sqlite`
- `OPENCHAT_EDGE_HOST_ID`
  Edge 所属 Host ID，必填
- `OPENCHAT_EDGE_DEVICE_ID`
  Edge 设备 ID，必填
- `OPENCHAT_EDGE_RELAY_WS_URL`
  Relay WebSocket 地址，必填，例如 `ws://127.0.0.1:3001/relay`
- `OPENCHAT_EDGE_STATE_DIR`
  Edge 状态目录，默认 `<cwd>/.openchat-state`
- `OPENCHAT_EDGE_OPENCLAW_BIN`
  OpenClaw CLI 可执行文件，默认 `openclaw`
- `OPENCHAT_EDGE_OPENCLAW_PROFILE`
  可选 OpenClaw profile，例如 `dev`

补充说明：

- `NEXT_PUBLIC_OPENCHAT_E2E=1`
  只在 Playwright 中由 [playwright.config.ts](/Users/wyp/develop/openchat/.worktrees/task-3-crypto/playwright.config.ts) 自动注入，用来挂载浏览器侧 harness。
- `hostId`、`deviceId`、`stateDir`
  目前是 `createEdgeMain()` / `createOpenClawClient()` 的代码级输入，不是仓库里已经约定好的 shell env。

## Running What Exists Today

### Web

```bash
pnpm --filter @openchat/web dev
```

这会启动 Next.js UI。默认情况下页面没有真实 Host 数据注入，所以手工打开只会看到空壳 UI。

如果你想手工研究 e2e harness，可显式打开测试态：

```bash
NEXT_PUBLIC_OPENCHAT_E2E=1 pnpm --filter @openchat/web exec next dev --hostname 127.0.0.1 --port 3100
```

然后在浏览器控制台里调用 `window.__openchatE2E`。

### Relay

```bash
pnpm --filter @openchat/relay dev
```

现在会启动一个真实的 relay 进程，并输出监听地址与 SQLite 路径。默认监听：

- HTTP: `http://127.0.0.1:3001`
- WebSocket: `ws://127.0.0.1:3001/relay`

如果你只想直接启动一次而不是 watch：

```bash
pnpm --filter @openchat/relay start
```

`src/index.ts` 仍然保留为库导出面；真正的进程入口是 `src/cli.ts`，它会读取 env、创建 store、启动服务并处理 `SIGINT` / `SIGTERM`。

默认状态路径以进程工作目录为基准。通过 `pnpm --filter @openchat/relay start` 启动时，`cwd` 实际是 `apps/relay`，所以默认 SQLite 会落在：

- `apps/relay/.openchat-state/relay/relay.sqlite`

当前 relay 的真实验证方式是：

```bash
pnpm --filter @openchat/relay typecheck
pnpm --filter @openchat/relay vitest run
```

### Edge

```bash
pnpm --filter @openchat/edge dev
```

现在会启动一个真实的本地 Edge 进程。最小示例：

```bash
OPENCHAT_EDGE_HOST_ID=host-1 \
OPENCHAT_EDGE_DEVICE_ID=device-1 \
OPENCHAT_EDGE_RELAY_WS_URL=ws://127.0.0.1:3001/relay \
pnpm --filter @openchat/edge start
```

`src/index.ts` 仍然保留为库导出面；真正的进程入口是 `src/cli.ts`，它会读取 env、创建 relay client、创建 OpenClaw CLI-backed transport，并处理 `SIGINT` / `SIGTERM`。

默认状态路径同样以进程工作目录为基准。通过 `pnpm --filter @openchat/edge start` 启动时，`cwd` 实际是 `apps/edge`，所以默认状态目录会落在：

- `apps/edge/.openchat-state`

当前 edge runtime 的前置条件和硬限制：

- 本机必须有可用的 `openclaw` CLI
- 本机 OpenClaw gateway 必须可达
- OpenChat bot 列表来自 OpenClaw 顶层 `bindings` 中形如 `{ agentId, match: { channel: "openchat", accountId } }` 的 canonical 绑定
- 当前实现会保留所有非 OpenChat bindings，不会把 `bindings` 当成 OpenChat 私有配置区
- 当前 runtime 通过 `chat.history` 只稳定支持 active session transcript；archived transcript 的历史 `sessionId` 读取还没有完全打通

一个最小可识别的 `bindings` 例子：

```json
[
  {
    "agentId": "writer-bot",
    "match": {
      "channel": "openchat",
      "accountId": "writer"
    }
  },
  {
    "agentId": "discord-bot",
    "match": {
      "channel": "discord",
      "guildId": "123456"
    }
  }
]
```

排障要点：

- 如果 `bindings` 不是合法数组，Edge 会报 `bindings is not a valid OpenClaw bindings array`
- 如果同一个 OpenChat `accountId` 同时绑定到多个 `agentId`，Edge 会报 `openchat account <id> is bound to multiple agents`
- OpenChat 只接收 canonical OpenChat 绑定；带 `peer`、`guildId`、`teamId`、`roles` 的记录不会被当成 OpenChat bot

当前 edge 的真实验证方式是：

```bash
pnpm --filter @openchat/edge typecheck
pnpm --filter @openchat/edge vitest run
```

## Verification Matrix

建议使用下面这组命令，而不是只跑根 `pnpm test`：

```bash
pnpm --filter @openchat/web typecheck
pnpm --filter @openchat/web vitest run
pnpm --filter @openchat/relay vitest run
pnpm --filter @openchat/edge vitest run
pnpm --filter @openchat/protocol vitest run
pnpm --filter @openchat/crypto vitest run
pnpm --filter @openchat/openclaw-client vitest run
pnpm --filter @openchat/store vitest run
pnpm playwright test tests/e2e/openchat-flow.spec.ts
```

根脚本的语义：

- `pnpm test`
  当前只跑 workspace smoke
- `pnpm build`
  会 fan-out 到各包，但 `@openchat/relay` / `@openchat/edge` 当前只是 `echo "No build yet"`

## Storage and State Paths

### Host-side session truth

`activeSessionId` 与归档 session 摘要由 Host 侧 OpenClaw client 维护在：

- `OPENCLAW_STATE_DIR/openchat/account-state.json`

对应实现见 [packages/openclaw-client/src/account-state.ts](/Users/wyp/develop/openchat/.worktrees/task-3-crypto/packages/openclaw-client/src/account-state.ts)。

所有权边界：

- Client 不拥有这个文件
- Relay 不拥有这个文件
- Host 侧 `packages/openclaw-client` 通过原子写入维护它

### Edge local state

Edge 当前会在传入的 `stateDir` 下使用：

- `<stateDir>/edge/device-keypair.json`
- `<stateDir>/edge/trusted-devices.json`

对应实现见 [apps/edge/src/config.ts](/Users/wyp/develop/openchat/.worktrees/task-3-crypto/apps/edge/src/config.ts)。

### Relay SQLite

Relay 运行时默认会把 SQLite 文件放到：

- `<cwd>/.openchat-state/relay/relay.sqlite`

通过 `pnpm --filter @openchat/relay start` 启动时，这里的 `<cwd>` 实际是 `apps/relay`。

如果需要覆盖，可以设置：

- `OPENCHAT_RELAY_STATE_DIR`
- `OPENCHAT_RELAY_SQLITE_PATH`

测试里仍然主要使用 `:memory:`，见 [apps/relay/src/__tests__/relay.test.ts](/Users/wyp/develop/openchat/.worktrees/task-3-crypto/apps/relay/src/__tests__/relay.test.ts)。

## Fake OpenClaw Transport in Tests

当前有两层“假的 Host/transport”：

- `packages/openclaw-client` 的 Vitest 使用内存 transport stub，模拟 `config get|set|unset`、agent 绑定、session 创建和消息发送
- Web Playwright e2e 使用浏览器侧 harness：
  - [apps/web/src/lib/e2e-harness.tsx](/Users/wyp/develop/openchat/.worktrees/task-3-crypto/apps/web/src/lib/e2e-harness.tsx)
  - [tests/e2e/fixtures/fake-openclaw.ts](/Users/wyp/develop/openchat/.worktrees/task-3-crypto/tests/e2e/fixtures/fake-openclaw.ts)
  - [tests/e2e/fixtures/fake-edge.ts](/Users/wyp/develop/openchat/.worktrees/task-3-crypto/tests/e2e/fixtures/fake-edge.ts)

这个 harness 的目标是验证：

- pairing 指纹展示与 trust pin
- bot 只在 Host 确认后出现
- 消息流与 `/new`
- 离线快照
- reconnect 后的权威刷新
- `session_conflict` 恢复

它不是生产 transport。

## Current v1 Limitations

- 真实 `web -> relay -> edge` 联网收发还没有接好
- 还没有用户登录、设备凭证持久化、推送、附件
- relay 与 edge 现在都具备可启动入口，但 edge 仍受 OpenClaw `openchat` channel 支持与 archived transcript 读取缺口限制
- relay/edge 的 `build` 脚本还不是实际产物构建
- Next dev 会提示 workspace root warning，但当前不影响测试通过
