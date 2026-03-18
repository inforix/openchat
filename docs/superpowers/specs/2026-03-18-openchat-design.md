# OpenChat Design Spec

## Goal

构建一个专用于 OpenClaw 的聊天产品 `OpenChat`，让用户可以通过公网客户端安全地访问自己本地运行的 OpenClaw，并获得接近 Telegram / Discord 的聊天体验，同时避免把消息内容交给第三方 IM 平台。

这个产品优先服务于：

- 个人用户
- 多主机使用场景
- 多 bot 使用场景
- 长期架构稳定性优先于短期功能堆叠

## Product Model

### Core Principle

OpenChat 不重新发明 OpenClaw 的 `channel/account` 模型，而是直接沿用它。

在最终设计中：

- `OpenChat` 是 OpenClaw 中的一个 `channel`
- `bot` 是该 `openchat channel` 下的一个 `account`
- 每个 `account(bot)` 与一个 `agent` 严格 `1:1` 绑定
- 每个 bot 默认只有一个 `active session`
- 用户通过 `/new` 显式切换到一个新的会话

主数据路径固定为：

`Host -> openchat channel -> account(bot) -> agent -> active session`

这意味着：

- UI 里真正稳定的一级对象是 bot，而不是“频道”
- 旧设计中的“产品层 Channel”概念不再作为主结构
- OpenClaw 现有配置与路由语义可以被直接复用

### Canonical Identity

bot 的规范身份固定为 `{hostId, accountId}`。

硬规则：

- `accountId` 是 bot 的唯一稳定键
- `hostId` 是必选作用域，不能省略
- UI 展示名称只是可变元数据，不参与身份判断
- `agentId` 在 v1 中是不可变绑定
- v1 不支持把一个既有 bot 重新绑定到另一个 agent
- v1 不支持本地生成与 OpenClaw 无关的 synthetic bot id

这意味着：

- URL、缓存键、路由键都使用 `{hostId, accountId}`
- rename 不改变 bot 身份
- `agentId` 只能在创建 bot 时指定

## Source of Truth

### Configuration

`OpenClaw` 是唯一配置真相源。

虽然 OpenChat 可以提供 bot 管理界面操作，但这些操作只有在 OpenClaw 中成功写入后才生效。

硬规则：

- 如果 OpenClaw 中没有对应的 `openchat account`，这个 bot 就不存在
- OpenChat 不保留本地草稿 bot
- OpenChat 刷新 bot 列表时，必须直接从 OpenClaw 当前配置读取

v1 进一步收缩为：

- 必做：`list`、`create`
- 延后：`rename`、`delete`、`rebind`

### Sessions

会话真相源拆成两层，但都必须留在 Host 上：

- `OpenClaw` 会话存储是真实消息历史的真相源
- `OpenChat host-local account state` 是 `activeSessionId` 的真相源

`activeSessionId` 的宿主固定为：

- `OPENCLAW_STATE_DIR/openchat/account-state.json`
- 该 registry 只记录 `{hostId, accountId} -> activeSessionId` 和归档会话索引
- 该 registry 只能由 Host 侧 `openclaw-client` 适配层读写
- Relay 和 Client 不得持久化或推断这个映射

该文件的持久化规则固定为：

- 写入必须采用 `temp file -> fsync -> atomic rename`
- 必须保留最近一次成功快照的 `.bak`
- 启动时如果主文件损坏，允许回退到 `.bak`
- 不允许以“写一半仍可继续启动”的宽松策略吞掉损坏

这意味着：

- 哪个 session 是当前 `active session`
- bot 历史会话有哪些
- `/new` 后切到了哪个新 session

这些状态最终都必须以 Host 上的会话存储和 account-state registry 为准，而不能由 Relay 或 Client 主导。

## System Architecture

### Client

Client 是用户接触到的产品层，首发以 Web 为基线，协议设计需支持未来扩展到 iOS / Android / Desktop。

职责：

- 设备身份管理
- Host 选择
- bot 列表展示
- bot 创建与管理入口
- 聊天页和流式渲染
- `/new` 入口
- 本地缓存

限制：

- 不维护 bot 真相
- 不维护 session 真相
- Host 离线时不做乐观状态切换

### Relay

Relay 是唯一公网入口。

职责：

- 用户与设备鉴权
- Host/Edge 路由
- 长连接管理
- 密文包在线转发
- 短期断线补偿
- 推送桥接

限制：

- 不是配置真相源
- 不是 session 真相源
- 不是消息明文真相源
- 不负责长期历史归档

Relay 可见明文字段必须收缩为：

- `requestId`
- `eventId`
- `hostId`
- `deviceId`
- `cursor`
- `eventType`
- `ttlExpiresAt`

Relay 不得看到：

- 消息正文
- `agentId`
- `session transcript`
- archived session 内容

Relay 中的短期 buffer 规则固定为：

- 默认 TTL 为 5 分钟
- 只能按 `deviceId + hostId + cursor` 做 replay
- 不提供任何“按 bot 查看历史”或“按 session 查询历史”的接口

### Edge

Edge 部署在用户自己的 OpenClaw 主机上。

职责：

- 接收并认证来自 Relay 的请求
- 解密 Client 发来的业务负载
- 读取和修改本地 OpenClaw 配置
- 把 bot/chat 请求翻译成 OpenClaw 能执行的调用
- 返回加密后的结果给 Client

Edge 是整个系统中唯一的受信任远程适配层。

Edge 还承担 Host 侧并发串行化职责：

- 所有 `{hostId, accountId}` 级别的写操作都必须经过同一个 per-bot mutex
- 写操作包括：`create bot`、发送消息、`/new`、终止当前流
- 同一 bot 在同一时刻只允许一个变更中的 session-state operation

部署前提固定为：

- v1 每台 Host 只支持一个 Edge 进程
- 不支持多个 Edge 进程同时挂接同一个 Host 状态目录

### OpenClaw

OpenClaw 是主机侧核心系统，负责：

- 保存 `openchat channel` 与其下 accounts
- 保存 `account -> agent` 的绑定关系
- 承担 bot 对话的 session 管理
- 返回历史与流式响应

## Bot Lifecycle

### Listing Bots

bot 列表直接来源于 OpenClaw 当前的 `openchat accounts`。

OpenChat 每次刷新列表时，应请求目标 Host 的 Edge，再由 Edge 读取 OpenClaw 当前配置。Relay 只负责转发。

### Creating Bots

OpenChat 可以发起创建 bot，但采用“受控创建”模型：

1. 用户在 OpenChat 中发起创建 bot
2. 请求经过 Relay 发到目标 Host 的 Edge
3. Edge 使用受支持的 Host-local CLI/config path 在 OpenClaw 中写入新的 `openchat account`
4. Edge 使用 account-scoped routing binding 完成 `account -> agent` 的 1:1 绑定
5. 只有在 OpenClaw 返回成功后，该 bot 才显示在 OpenChat 中

如果任一步失败：

- UI 不应保留半成品 bot
- 下次 bot 列表刷新仍完全以 OpenClaw 当前状态为准

v1 写入路径固定为：

- 读取/写入 `channels.openchat.accounts` 使用 `openclaw config get|set|unset`
- 建立 account-scoped agent binding 使用 `openclaw agents bind --bind openchat:<accountId>`
- 禁止直接改写 `~/.openclaw/openclaw.json`

## Session Model

### Active Session

每个 bot 在任意时刻只有一个 `active session`。

默认进入 bot 时，直接进入这个 `active session`，而不是先展示一个会话列表。

每次发送消息都必须显式带上 `targetSessionId`。

Edge 校验规则：

- 如果 `targetSessionId` 与 Host 当前 `activeSessionId` 一致，则允许发送
- 如果不一致，Edge 返回 `session_conflict`，并附带权威的 `activeSessionId`
- Client 收到 `session_conflict` 后必须刷新 bot 当前会话，而不是继续乐观发送

### Archived Sessions

旧会话不删除，而是归档保存。

归档会话可以在 bot 详情页中查看，但不是主入口。

v1 中归档会话是只读对象：

- 允许查看
- 不允许继续发送消息
- 不允许重新激活为 active session
- `/new` 是 v1 中唯一合法的 session 切换路径

### `/new`

`/new` 是系统命令，而不是普通聊天消息。

执行规则：

1. Client 可以把用户输入的 `/new` 转换成显式 `session.new` 系统命令
2. 只有 Edge 有权执行 `session.new`
3. Edge 先获取该 bot 的 per-bot mutex
4. 如果当前 bot 有进行中的生成流，则返回 `session_busy`
5. 如果没有进行中的生成流，Edge 创建新的 session
6. Edge 原子更新 Host 上的 `activeSessionId`
7. 原来的 session 被归档
8. Client 收到确认后再切换 UI

约束：

- 只有 Host 在线时才能执行 `/new`
- `/new` 必须幂等
- 重连后必须重新向 Host 查询当前 active session
- 普通用户消息正文恰好等于 `/new` 时，只有在被 Client 显式包装成系统命令后才触发切换；否则按普通文本处理

`/new` 的幂等键规则固定为：

- `commandId` 作用域是 `{hostId, accountId, deviceId}`
- Edge 必须把最近 10 分钟的 `commandId -> resultingSessionId` 结果写入 Host 本地状态
- 如果相同 `commandId` 重试，Edge 必须返回第一次成功创建的 `resultingSessionId`
- 幂等结果在 Edge 重启后仍然有效

## Security and Sync

### Encryption Boundary

采用 `Client <-> Edge` 端到端加密。

效果：

- Relay 无法读取消息正文
- Relay 仅可见必要的路由元数据和密文包
- 业务明文只出现在 Client、Edge、OpenClaw 所在主机侧

### Pairing and Trust

v1 配对 ceremony 固定为首次配对 pin `Edge public key fingerprint`：

1. Host 侧 Edge 生成一次性 pairing token
2. pairing token 载荷必须包含：`hostId`、`edgePublicKey`、`edgeKeyFingerprint`、`expiresAt`、`pairingNonce`
3. Host 侧显示二维码和短校验码
4. Client 扫码后，把二维码中的 `edgeKeyFingerprint` 与短校验码一起展示给用户确认
5. 用户确认后，Client 把自己的 `devicePublicKey` 和 pairing token 提交给 Edge
6. Edge 校验 token、校验过期时间、校验 nonce 未被复用，然后把该 device 写入 trusted devices
7. Client 在本地 pin 住该 `edgeKeyFingerprint`

v1 的硬规则：

- 如果 `edgeKeyFingerprint` 变化，旧配对立即失效，必须重新配对
- Relay 不参与任何公钥信任判断
- Client 不接受“仅凭 Relay 转发就信任 Edge 公钥”

### Offline Semantics

Host 是唯一真相源，因此 Host 离线时系统行为必须收缩：

- Client 只能查看本地缓存
- 不保证新设备拿到完整历史
- 不允许创建 bot
- 不允许执行 `/new`
- 不允许修改 bot 配置

这种设计牺牲了一部分多端一致性体验，但换来更稳定的职责边界和更低的长期复杂度。

重连规则固定为：

1. Client 重连后必须先请求 Host 当前 bot 列表
2. Client 再请求目标 bot 当前的权威 `activeSessionId`
3. 只有在完成这两个刷新后，Client 才能解除只读状态

### History Reads

在线时：

- 历史由 Edge 从 OpenClaw 读取
- Relay 只做转发

离线时：

- 只显示 Client 本地缓存
- UI 必须标记“离线快照”

## Why This Design

这套设计最终被选中，原因有四个：

1. 它与 OpenClaw 现有 `channel/account` 模型对齐，避免重新定义核心语义。
2. 它消除了“双真相源”问题，降低了配置和状态漂移风险。
3. 它让 `Relay` 长期保持简单，不会膨胀成第二套聊天后端。
4. 它支持未来扩展到多平台客户端，而不需要重写主协议模型。

## Non-Goals for v1

v1 不做：

- 多用户共享主机
- 多租户权限系统
- Relay 端长期历史存储
- Host 离线时的强同步体验
- 把 OpenChat 做成完整的 OpenClaw 管理台
- bot rename/delete/rebind

## Fixed v1 Decisions

这些决策在 v1 中已经锁定，不再留给实现者自行决定：

- bot 的 canonical identity 是 `{hostId, accountId}`
- `agentId` 绑定在 v1 中不可变
- `activeSessionId` 存在 Host 上的 `OPENCLAW_STATE_DIR/openchat/account-state.json`
- bot 配置写入通过 `openclaw config get|set|unset` 与 `openclaw agents bind`
- `/new` 的唯一执行者是 Edge
- archived session 在 v1 中只读、不可重激活
- Relay buffer 默认 TTL 为 5 分钟，且只能做 cursor replay
