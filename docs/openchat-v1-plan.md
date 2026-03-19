# OpenChat v1 方案

## 概述

OpenChat 是一个专用于 OpenClaw 的聊天产品，目标是提供类似 Telegram / Discord 的聊天体验，但不把用户消息交给 Telegram、Discord 这类第三方平台记录。

OpenChat 的核心设计原则已经收敛为：

- `OpenChat` 在 OpenClaw 中是一个独立的 `channel`
- `bot` 在 OpenClaw 中表现为 `openchat channel` 下的多个 `account`
- 每个 `account(bot)` 与一个 `agent` 严格 `1:1` 绑定
- bot 的规范身份是 `{hostId, accountId}`
- `OpenClaw` 是配置真相源；Host 上的 `account-state.json` 是 `activeSessionId` 真相源
- `account-state.json` 采用 `temp file -> fsync -> atomic rename` 写入，并保留 `.bak`
- `OpenChat` 可以发起 bot 创建，但 bot 只有在 OpenClaw 中成功创建对应 `account` 后才算存在
- 每个 bot 默认只有一个持续活跃会话，用户通过 `/new` 创建新会话
- `Relay` 不是历史真相源，`Host` 离线时只显示客户端本地缓存

系统链路固定为：

`Client -> Relay -> Edge -> OpenClaw Gateway -> Edge -> Relay -> Client`

## 核心模型

### 资源对象

- `User`
  OpenChat 用户
- `Device`
  用户设备，持有设备密钥并登记推送标识
- `Host`
  一台用户绑定的 OpenClaw 主机
- `Channel`
  OpenClaw 中的 `openchat` channel
- `Account`
  `openchat channel` 下的一个账号实例，在 OpenChat UI 中表现为一个 bot
- `AgentBinding`
  `account_id -> agent_id` 的严格 `1:1` 绑定
- `ActiveSession`
  某个 bot 当前唯一活跃的持续会话
- `ArchivedSession`
  用户通过 `/new` 切出的历史会话
- `MessageEvent`
  会话中的流式事件，例如 chunk、done、error、attachment

### 主路径

OpenChat 的主数据路径固定为：

`Host -> openchat channel -> account(bot) -> agent -> active session`

这里的重点是：

- `Channel` 不是产品层“频道”概念，而是 OpenClaw 配置层 channel
- 用户实际看到和操作的是 `account(bot)`
- 默认进入 bot 时，总是打开该 bot 当前的 `active session`
- `agentId` 在 v1 中不可变，rename 不改变 bot 身份

### 客户端视图

客户端主导航固定为：

- 顶层切换 `Host`
- 每个 `Host` 下展示该主机当前 `openchat accounts` 形成的 bot 列表
- 点进某个 bot 后直接进入其 `active session`
- bot 详情页中提供历史会话入口

## 系统设计

### 1. Client

首发以 Web 为基线，但协议和状态模型从第一天开始就要能支持 Web / iOS / Android / Desktop 共用。

客户端职责：

- 用户登录和设备身份管理
- Host 绑定和切换
- bot 列表展示
- bot 创建入口
- 聊天页和流式渲染
- `/new` 指令入口
- 本地消息缓存
- 附件上传下载
- 推送注册

关键限制：

- Client 不保存 bot 配置真相
- Client 不允许创建本地草稿 bot
- Host 离线时，Client 不能本地乐观创建 bot 或切 active session

### 2. Relay

Relay 是唯一公网入口，不直接运行 Agent，也不暴露 OpenClaw 管理面。

职责包括：

- 用户和设备鉴权
- `user_id + host_id` 路由
- Edge 长连接管理
- WebSocket 事件转发
- 短期未确认密文包缓存
- 推送通知分发
- 附件密文对象中转

约束：

- 不保存消息明文
- 不持有解密业务数据所需密钥
- 不作为配置真相源
- 不作为 session 真相源
- 不在 Host 离线时拼装“伪历史”

### 3. Edge

Edge 部署在 OpenClaw 主机本地，一端连接本地 Gateway，一端主动连接公网 Relay。

职责包括：

- 建立与 Relay 的长连接
- 维护本地主机身份
- 管理可信设备
- 解密客户端业务负载
- 把 OpenChat 请求翻译为 OpenClaw 配置变更或聊天调用
- 保存有限的主机侧恢复缓存

Edge 是唯一受信任适配层。

并且：

- 所有 `{hostId, accountId}` 级别的写操作都经过 per-bot mutex
- 只有 Edge 有权执行 `/new`
- v1 每台 Host 只支持一个 Edge 进程

### 4. OpenClaw Gateway 适配

Edge 只调用 OpenClaw Gateway 的聊天和配置相关能力，不暴露完整管理面。

v1 需要的适配能力：

- 读取 `openchat channel` 配置
- 列出 `openchat accounts`
- 创建 `openchat account`
- 维护 `account -> agent` 绑定
- 列出 session
- 读取 session 历史
- 发送消息到指定 account 对应的 agent / session
- 订阅流式响应
- 中断当前生成
- 附件元数据适配

bot 创建规则：

- 用户在 OpenChat 中点击“创建 bot”
- 请求经 Relay 发到目标 Host 的 Edge
- Edge 通过 `openclaw config get|set|unset` 创建 `openchat account`
- Edge 通过 `openclaw agents bind --bind openchat:<accountId>` 完成 agent 绑定
- 只有 OpenClaw 返回成功后，bot 才会在 Client 中显示
- 如果 OpenClaw 创建失败，OpenChat 不保留任何本地半成品 bot

## 会话模型

### Active Session 规则

每个 `account(bot)` 在任意时刻只有一个 `active session`。

默认行为：

- 进入某个 bot 时，总是打开这个 bot 当前的 `active session`
- 聊天消息默认都进入该 `active session`
- 旧会话不删除，只进入归档历史
- 发送消息必须显式带上 `targetSessionId`
- 如果 `targetSessionId` 过期，Edge 返回 `session_conflict`

### `/new` 规则

`/new` 是系统命令，不转发给 agent 本身。

执行规则：

1. Client 可把用户输入的 `/new` 转成显式 `session.new`
2. 只有 Edge 执行 `session.new`
3. Edge 获取 per-bot mutex
4. 如果当前有进行中的生成流，返回 `session_busy`
5. Edge 创建新的 session，并原子更新 `OPENCLAW_STATE_DIR/openchat/account-state.json`
6. 旧 session 标记为 archived
7. Client 收到确认事件后再切换 UI

约束：

- `/new` 只能在 Host 在线时执行
- `/new` 必须幂等，避免重试时切出多个新 session
- 重连后必须以 OpenClaw 当前 `active session` 为准，而不是以 Client 本地状态为准
- archived session 在 v1 中只读，不允许重新激活
- `commandId` 作用域为 `{hostId, accountId, deviceId}`，结果保留 10 分钟且跨 Edge 重启有效

## 加密与同步模型

### 加密边界

采用 `客户端到 Edge` 的端到端加密。

含义：

- Client 发往 bot 的消息，用对应 Host 的 Edge 公钥加密
- Relay 只能看见路由元数据和密文包
- Edge 解密后再调用本地 OpenClaw Gateway
- Gateway 返回事件后，Edge 重新加密再经 Relay 发回 Client

### 真相源分层

必须固定为：

- `OpenClaw`：配置真相源 + session 真相源
- `Edge`：受信任适配层 + 有限恢复缓存
- `Relay`：在线路由层 + 短期密文转发层
- `Client`：本地展示缓存

其中：

- `activeSessionId` 保存在 `OPENCLAW_STATE_DIR/openchat/account-state.json`
- Relay 只允许看到 `requestId`、`eventId`、`hostId`、`deviceId`、`cursor`、`eventType`、`ttlExpiresAt`
- Relay 短期 buffer TTL 固定为 5 分钟，只支持按 `deviceId + hostId + cursor` replay

### Host 离线语义

Host 离线时：

- Client 只能显示本地缓存
- 不保证新设备能拿到完整历史
- 不能创建 bot
- 不能执行 `/new`
- 不能修改 bot 配置

Host 恢复上线后：

- Edge 重新连上 Relay
- Client 先刷新 bot 列表，再刷新权威 `activeSessionId`，然后才解除只读状态

### 历史读取规则

- 在线时：优先由 Edge 从 OpenClaw 读取，再返回 Client
- 离线时：Client 只显示本地缓存，并标记为离线快照
- Relay 不负责长期历史归档

## 配对和配置

### Host 绑定

首次绑定某台 OpenClaw 主机时采用一次性配对码：

1. 用户在主机侧生成配对码
2. Client 输入或扫码提交到 Relay
3. Relay 将绑定请求转发到对应 Edge
4. Edge 校验配对码并登记该 Device
5. Edge 返回 Host 元数据和必要公钥信息

### 配置真相源

`OpenClaw` 是唯一配置真相源。

OpenChat 允许发起配置变更，但所有 bot 列表和 bot 有效性都以 OpenClaw 当前配置为准：

- OpenChat 中 bot 的存在性取决于 OpenClaw 中是否存在对应 `openchat account`
- OpenChat 刷新 bot 列表时，应直接从 OpenClaw 读取
- OpenChat 不单独维护 bot 真相表

v1 只做：

- `list`
- `create`

v1 不做：

- `rename`
- `delete`
- `rebind`

## 协议设计

### Client <-> Relay

公开接口最小集合：

- `auth.login_device`
- `host.list`
- `host.pair.begin`
- `bot.list`
- `bot.create`
- `session.current`
- `session.history`
- `message.send`
- `message.abort`
- `stream.subscribe`
- `stream.resume`
- `device.push.register`
- `attachment.upload.begin`
- `attachment.upload.complete`

协议约束：

- 所有请求都带 `request_id`
- 所有流式事件都带 `event_id`
- 客户端断线重连必须支持 `cursor` 恢复
- 消息发送必须支持 `client_message_id` 幂等去重
- `/new` 作为系统指令处理，而不是普通消息语义
- `message.send` 必须带 `targetSessionId`
- 协议必须定义 `session_conflict`、`session_busy`、`bot_create_failed`、`offline_read_only`

### Relay <-> Edge

内部隧道事件最小集合：

- `edge.hello`
- `edge.register_host`
- `edge.route.request`
- `edge.route.response`
- `edge.stream.event`
- `edge.stream.done`
- `edge.stream.error`
- `edge.cursor.commit`
- `edge.device.pair.approve`

协议约束：

- Edge 只能处理自己注册过的 `host_id`
- Relay 不解包业务密文
- Relay 只做投递、短期缓存、游标推进和重试
- Relay 不提供任何按 bot 或按 session 查询历史的接口

## 数据存储

### Relay 持久化

- 用户
- 设备
- Host 绑定关系
- Device Push Token
- Edge 在线状态
- 短期密文事件缓存索引
- 附件对象索引

### Edge 本地存储

- 已信任设备列表
- Host 密钥材料
- 有限恢复缓存
- 待投递事件队列

### 客户端本地存储

- 设备私钥
- Host 列表缓存
- bot 元数据缓存
- 当前 active session 展示缓存
- 归档 session 列表缓存
- 消息密文和展示缓存
- 附件密钥引用

## MVP 范围

第一阶段只做以下能力：

- Web 客户端
- 用户设备登录
- 单用户多 Host 绑定
- 从 OpenClaw 读取 `openchat accounts` 形成 bot 列表
- 在 OpenChat 中创建 bot，并写入 OpenClaw 成功后展示
- 每个 bot 对应一个 active session
- `/new` 创建新会话
- 文本消息流式收发
- 断线恢复和短期事件补偿

暂不包含：

- 多用户共享同一台主机
- 多租户权限系统
- 长期离线历史同步
- Relay 端历史真相存储
- 完整管理台能力
- bot rename/delete/rebind

## 当前实现状态（2026-03-18）

仓库当前已经落地并验证的部分：

- `packages/protocol`、`packages/crypto`、`packages/store`、`packages/openclaw-client` 均有单测覆盖
- Web 已实现 host-first bot 导航、pairing 指纹页、bot 创建页、active session、`/new`、归档只读、离线快照
- Playwright 已覆盖一条浏览器纵向链路：
  pairing 指纹展示、bot 列表、Host 确认后创建 bot、消息流、`/new`、离线只读、重连刷新、`session_conflict`
- `activeSessionId` 的 Host 侧真相源已经固化为 `OPENCLAW_STATE_DIR/openchat/account-state.json`

仓库当前还没有落地的部分：

- Web 还没有接入真实 relay/edge 网络 transport
- Relay / Edge 还没有独立的 CLI 进程入口
- Relay SQLite 还没有仓库级默认文件路径约定
- 配对 UI 还没有把“短校验码 / 二维码”真正接到页面，只完成了 `edgeKeyFingerprint` trust-on-first-use 页面
- `pnpm test` 当前只跑 workspace smoke，不是全量验证入口

## 测试与验收

### 链路测试

- 单 Host 单 Device 下消息能正常流式返回
- 单用户多 Host 下消息能被正确路由
- bot 列表与 OpenClaw 当前 `openchat accounts` 一致
- `bot.create` 只有在 OpenClaw 成功后才出现在 UI 中
- 客户端重连后能按 `cursor` 补齐缺失事件
- 重复发送同一个 `client_message_id` 不产生重复消息
- stale `targetSessionId` 会收到 `session_conflict`

### 安全测试

- Relay 无法读取消息正文
- 非可信设备不能访问已绑定 Host
- 失效、伪造、重复使用的配对码会被拒绝
- 推送通知不泄露消息正文
- `edgeKeyFingerprint` 变化后必须重新配对

### 产品行为测试

- 进入 bot 时自动打开当前 active session
- `/new` 成功后旧 session 被归档，新 session 成为 active session
- Host 离线时不能创建 bot
- Host 离线时不能执行 `/new`
- Host 离线时客户端只显示离线快照
- archived session 只能查看，不能继续发送

### 验收标准

- 用户可通过公网 Client 使用自己的本地 OpenClaw
- Gateway 无需暴露公网端口
- Relay 不保存明文消息
- 一个用户可稳定绑定至少两台 Host
- 一个 Host 下可维护多个 `openchat accounts`，每个都可独立聊天
- `activeSessionId` 从 `OPENCLAW_STATE_DIR/openchat/account-state.json` 恢复

## 默认假设

- OpenClaw Gateway 继续监听本地 `127.0.0.1`
- OpenClaw 当前具备足够的配置、session、history、send、stream 能力供 Edge 适配
- Web 是首发基线，但协议必须能直接扩展到 iOS / Android / Desktop
- v1 以个人使用场景为主，不做团队协作和多租户权限
