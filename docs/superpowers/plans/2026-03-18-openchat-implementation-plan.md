# OpenChat Implementation Plan

> **For agentic workers:** REQUIRED: Use `superpowers:subagent-driven-development` (if subagents available) or `superpowers:executing-plans` to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first working OpenChat system for personal OpenClaw usage: a web client, a public relay, and a host-side edge service that treat `openchat` as an OpenClaw channel, expose OpenClaw `accounts` as bots, support one active session per bot, and create new sessions via `/new`.

**Architecture:** Use a TypeScript monorepo. `apps/web` is the user-facing client, `apps/relay` is the public WebSocket/API service, and `apps/edge` runs beside OpenClaw and talks to the local Gateway on `127.0.0.1`. Shared protocol, crypto envelopes, and config schemas live in `packages/*`. OpenClaw config plus host-local `account-state.json` remain the only bot/session source of truth.

**Tech Stack:** `pnpm`, TypeScript, Next.js (web), Fastify + WebSocket (relay), Node.js service (edge), SQLite for relay metadata, `better-sqlite3`, `zod`, `tweetnacl` or `libsodium`, Vitest, Playwright.

---

## File Structure

Create this structure before feature work so boundaries stay stable:

- `package.json`
- `pnpm-workspace.yaml`
- `tsconfig.base.json`
- `vitest.workspace.ts`
- `playwright.config.ts`
- `apps/web/`
- `apps/relay/`
- `apps/edge/`
- `packages/protocol/`
- `packages/crypto/`
- `packages/openclaw-client/`
- `packages/store/`
- `packages/ui/`
- `tests/e2e/`
- `docs/superpowers/specs/2026-03-18-openchat-design.md`

Responsibilities:

- `apps/web`: login, host list, bot list, chat UI, `/new`, offline snapshot state
- `apps/relay`: device auth, host routing, WebSocket fanout, short-lived encrypted event buffering
- `apps/edge`: pairing, device trust, relay tunnel, OpenClaw config/session adapter
- `packages/protocol`: request/response/event schemas, ids, cursor semantics
- `packages/crypto`: device keys, host key verification, envelope encode/decode
- `packages/openclaw-client`: host-local OpenClaw Gateway/config/account-state adapter used only by edge
- `packages/store`: relay SQLite schema and typed persistence helpers
- `packages/ui`: shared React components for bot list and chat shell

Hard v1 decisions this plan assumes and must encode:

- canonical bot identity is `{hostId, accountId}`
- `agentId` binding is immutable after bot creation
- `activeSessionId` is persisted in `OPENCLAW_STATE_DIR/openchat/account-state.json`
- `account-state.json` writes use temp-file + fsync + atomic rename with `.bak` fallback
- bot config writes use `openclaw config get|set|unset`
- account-to-agent binding uses `openclaw agents bind --bind openchat:<accountId>`
- only Edge executes `session.new`
- `session.new` idempotency is keyed by `{hostId, accountId, deviceId, commandId}` with 10-minute retention
- archived sessions are read-only
- relay buffer TTL is 5 minutes and replay-only by `deviceId + hostId + cursor`
- v1 supports exactly one Edge process per Host

## Task 1: Bootstrap the Monorepo

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `vitest.workspace.ts`
- Create: `playwright.config.ts`
- Create: `apps/web/package.json`
- Create: `apps/relay/package.json`
- Create: `apps/edge/package.json`
- Create: `packages/protocol/package.json`
- Create: `packages/crypto/package.json`
- Create: `packages/openclaw-client/package.json`
- Create: `packages/store/package.json`
- Create: `packages/ui/package.json`

- [ ] **Step 1: Write the failing workspace smoke test**

Create `tests/e2e/workspace-smoke.test.ts`:

```ts
import { describe, expect, it } from "vitest";

describe("workspace", () => {
  it("loads shared packages", async () => {
    const protocol = await import("@openchat/protocol");
    expect(protocol).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/e2e/workspace-smoke.test.ts`  
Expected: fail because workspace and package aliases do not exist yet

- [ ] **Step 3: Create the monorepo scaffolding**

Implement:

- workspace root scripts: `dev`, `build`, `test`, `lint`, `typecheck`
- TS path aliases for `@openchat/*`
- minimal app/package manifests
- `apps/web` as Next.js app router app
- `apps/relay` and `apps/edge` as Node TypeScript services

- [ ] **Step 4: Run the smoke test again**

Run: `pnpm install && pnpm vitest run tests/e2e/workspace-smoke.test.ts`  
Expected: pass

- [ ] **Step 5: Commit**

```bash
git add .
git commit -m "chore: bootstrap openchat monorepo"
```

## Task 2: Define the Core Domain Model and Protocol

**Files:**
- Create: `packages/protocol/src/index.ts`
- Create: `packages/protocol/src/domain.ts`
- Create: `packages/protocol/src/client-relay.ts`
- Create: `packages/protocol/src/relay-edge.ts`
- Create: `packages/protocol/src/errors.ts`
- Create: `packages/protocol/src/__tests__/protocol.test.ts`

- [ ] **Step 1: Write failing protocol tests**

Cover:

- bot resource is modeled as `openchat` channel account
- canonical bot identity is `{hostId, accountId}`
- every bot has exactly one `activeSessionId`
- `/new` is represented as a system command, not a normal chat message
- message send requires `targetSessionId`
- relay event envelopes carry `requestId`, `eventId`, `hostId`, `deviceId`, `cursor`, `eventType`
- protocol defines `session_conflict`, `session_busy`, `bot_create_failed`, and `offline_read_only`
- protocol defines stream event variants `chunk`, `done`, `error`

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @openchat/protocol vitest run`  
Expected: fail because protocol modules do not exist

- [ ] **Step 3: Implement the shared schemas**

Use `zod` for:

- `Host`
- `BotAccount`
- `ActiveSession`
- `ArchivedSessionSummary`
- `MessageEnvelope`
- `BotCreateRequest`
- `SessionNewCommand`
- `MessageSendRequest`
- relay-edge events: `edge.hello`, `edge.registerHost`, `edge.stream.event`, `edge.cursor.commit`, `edge.bot.create.result`, `edge.session.snapshot`

Hard rules to encode:

- `channelType` is fixed to `"openchat"` for bot resources
- `agentId` is required on bot creation
- `systemCommand` is a tagged union separate from `userMessage`
- `botId` is derived only from `{hostId, accountId}`
- `session.new` carries `expectedActiveSessionId` and `commandId`
- relay-visible metadata excludes message body, `agentId`, and transcript content

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @openchat/protocol vitest run`  
Expected: pass

- [ ] **Step 5: Commit**

```bash
git add packages/protocol
git commit -m "feat: add openchat domain protocol"
```

## Task 3: Implement Crypto Envelopes and Pairing Verification

**Files:**
- Create: `packages/crypto/src/index.ts`
- Create: `packages/crypto/src/device-keys.ts`
- Create: `packages/crypto/src/envelope.ts`
- Create: `packages/crypto/src/pairing.ts`
- Create: `packages/crypto/src/__tests__/crypto.test.ts`

- [ ] **Step 1: Write failing crypto tests**

Cover:

- device keypair generation
- envelope encryption/decryption between client and edge
- pairing payload binds `hostId`, `edgePublicKey`, and a fingerprint
- tampering with host fingerprint fails verification
- fingerprint changes invalidate an existing trust record
- pairing token expiry and nonce replay are rejected

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @openchat/crypto vitest run`  
Expected: fail

- [ ] **Step 3: Implement minimal crypto package**

Implement:

- device keypair generation
- sealed-box style envelope encode/decode
- pairing verifier that rejects mismatched host fingerprints
- pairing token verifier with `expiresAt` and nonce replay protection
- local trust record pinning of `edgeKeyFingerprint`

Do not implement key rotation yet.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @openchat/crypto vitest run`  
Expected: pass

- [ ] **Step 5: Commit**

```bash
git add packages/crypto
git commit -m "feat: add envelope crypto and pairing verification"
```

## Task 4: Build the Relay Metadata Store

**Files:**
- Create: `packages/store/src/index.ts`
- Create: `packages/store/src/schema.ts`
- Create: `packages/store/src/devices.ts`
- Create: `packages/store/src/hosts.ts`
- Create: `packages/store/src/cursors.ts`
- Create: `packages/store/src/__tests__/store.test.ts`

- [ ] **Step 1: Write failing store tests**

Cover:

- register device
- bind device to host
- store edge online state
- store and read short-lived event cursor records
- no bot config tables are persisted in relay

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @openchat/store vitest run`  
Expected: fail

- [ ] **Step 3: Implement the SQLite store**

Create tables only for:

- `users`
- `devices`
- `hosts`
- `device_host_bindings`
- `edge_connections`
- `event_cursors`
- `push_tokens`

Explicitly exclude bot configuration tables.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @openchat/store vitest run`  
Expected: pass

- [ ] **Step 5: Commit**

```bash
git add packages/store
git commit -m "feat: add relay metadata store"
```

## Task 5: Build the Host-Local OpenClaw Adapter

**Files:**
- Create: `packages/openclaw-client/src/index.ts`
- Create: `packages/openclaw-client/src/config.ts`
- Create: `packages/openclaw-client/src/account-state.ts`
- Create: `packages/openclaw-client/src/sessions.ts`
- Create: `packages/openclaw-client/src/errors.ts`
- Create: `packages/openclaw-client/src/__tests__/adapter.test.ts`

- [ ] **Step 1: Write failing adapter tests against a fake OpenClaw transport**

Cover:

- list `openchat` accounts
- create a new `openchat` account with required `agentId`
- resolve the current active session for a bot
- create a new session and promote it to active
- persist `activeSessionId` in `OPENCLAW_STATE_DIR/openchat/account-state.json`
- reject a send when `targetSessionId` does not match current `activeSessionId`
- preserve `commandId -> resultingSessionId` for 10 minutes across Edge restart
- recover from a corrupted primary state file by falling back to `.bak`

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @openchat/openclaw-client vitest run`  
Expected: fail

- [ ] **Step 3: Implement the adapter interface**

Expose:

- `listOpenChatBots()`
- `createOpenChatBot()`
- `getActiveSession()`
- `listArchivedSessions()`
- `createNextSession()`
- `sendMessage()`
- `abortMessage()`

Use an abstract transport so the package can be tested without a live OpenClaw host.

Hard implementation rules:

- bot config reads/writes go through `openclaw config get|set|unset`, not raw file edits
- account binding goes through `openclaw agents bind`
- `activeSessionId` reads/writes go through `account-state.ts`
- `createNextSession()` must take `expectedActiveSessionId` and `commandId`
- state writes use `temp file -> fsync -> atomic rename`
- v1 does not expose rename/delete/rebind methods from this package

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @openchat/openclaw-client vitest run`  
Expected: pass

- [ ] **Step 5: Commit**

```bash
git add packages/openclaw-client
git commit -m "feat: add openclaw host adapter"
```

## Task 6: Implement the Edge Service

**Files:**
- Create: `apps/edge/src/main.ts`
- Create: `apps/edge/src/config.ts`
- Create: `apps/edge/src/relay-tunnel.ts`
- Create: `apps/edge/src/pairing-service.ts`
- Create: `apps/edge/src/bot-service.ts`
- Create: `apps/edge/src/session-service.ts`
- Create: `apps/edge/src/__tests__/edge-services.test.ts`

- [ ] **Step 1: Write failing edge service tests**

Cover:

- edge registers itself to relay with `hostId`
- edge pairing response includes `edgePublicKey`, `edgeKeyFingerprint`, `expiresAt`, and nonce-backed token data
- edge lists bots from OpenClaw on demand
- edge creates bot only after OpenClaw confirms account creation
- `/new` creates a fresh session and returns the new `activeSessionId`
- `/new` returns `session_busy` when a stream is in flight
- sends with stale `targetSessionId` return `session_conflict`
- duplicate `commandId` returns the original `resultingSessionId` after Edge restart

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @openchat/edge vitest run`  
Expected: fail

- [ ] **Step 3: Implement the edge services**

Rules:

- pairing writes trusted device records locally
- pairing rejects expired or replayed nonces and trusts only confirmed fingerprints
- bot reads/writes go only through the OpenClaw adapter
- bot list responses are always fresh reads from OpenClaw
- `/new` is handled as a system command and never forwarded as user content
- all bot mutations are serialized by a per-bot mutex
- Edge is the only authority that can execute `session.new`
- deployment assumes exactly one Edge process per Host

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @openchat/edge vitest run`  
Expected: pass

- [ ] **Step 5: Commit**

```bash
git add apps/edge
git commit -m "feat: add edge relay and openclaw services"
```

## Task 7: Implement the Relay Service

**Files:**
- Create: `apps/relay/src/main.ts`
- Create: `apps/relay/src/http.ts`
- Create: `apps/relay/src/ws.ts`
- Create: `apps/relay/src/auth.ts`
- Create: `apps/relay/src/router.ts`
- Create: `apps/relay/src/buffer.ts`
- Create: `apps/relay/src/__tests__/relay.test.ts`

- [ ] **Step 1: Write failing relay tests**

Cover:

- device can authenticate and connect
- relay accepts only paired device credentials and never vouches for Edge keys
- relay routes a bot list request to the correct host
- relay buffers encrypted events for short reconnect windows
- relay never persists bot config data
- relay buffer entries expire after 5 minutes
- relay replay works only by `deviceId + hostId + cursor`
- relay never stores `agentId`, message body, or transcript text as cleartext

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @openchat/relay vitest run`  
Expected: fail

- [ ] **Step 3: Implement the relay**

Implement:

- HTTP auth bootstrap
- WebSocket session for client and edge
- host-aware request routing
- short-lived encrypted event buffering by `deviceId + hostId + cursor`
- replay-only buffer API with 5-minute TTL
- no query surface for “history by bot” or “history by session”

Auth bootstrap rules:

- relay authenticates device identity and host binding only
- Edge key trust is validated at pairing time by client and edge, not by relay

Do not implement long-term history storage.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @openchat/relay vitest run`  
Expected: pass

- [ ] **Step 5: Commit**

```bash
git add apps/relay
git commit -m "feat: add relay routing service"
```

## Task 8: Implement the Web Client Shell

**Files:**
- Create: `apps/web/src/app/layout.tsx`
- Create: `apps/web/src/app/page.tsx`
- Create: `apps/web/src/app/pair/page.tsx`
- Create: `apps/web/src/app/hosts/[hostId]/bots/[botId]/page.tsx`
- Create: `apps/web/src/app/hosts/[hostId]/bots/new/page.tsx`
- Create: `apps/web/src/lib/client-protocol.ts`
- Create: `apps/web/src/lib/device-store.ts`
- Create: `apps/web/src/lib/offline-cache.ts`
- Create: `packages/ui/src/bot-list.tsx`
- Create: `packages/ui/src/bot-create-form.tsx`
- Create: `packages/ui/src/chat-shell.tsx`
- Create: `apps/web/src/__tests__/bot-list.test.tsx`

- [ ] **Step 1: Write failing UI tests**

Cover:

- host switcher renders host list
- pairing screen displays `edgeKeyFingerprint` confirmation before trust is stored
- bot list renders OpenClaw-backed bots
- create-bot form submits `accountId` + `agentId` and only renders success after host confirmation
- create-bot failure renders host-authored error and does not leave draft UI state
- entering bot page loads current active session
- offline host state renders cached snapshot banner
- reconnect re-fetches authoritative bot list and `activeSessionId`

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @openchat/web vitest run`  
Expected: fail

- [ ] **Step 3: Implement the web shell**

Rules:

- home screen is host list then bot list, not channel list
- bot page loads active session directly
- offline state is read-only
- UI never shows “draft bot” status
- create-bot is a first-class feature in this task, not deferred to e2e glue
- bot routes and caches key by `{hostId, accountId}`

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @openchat/web vitest run`  
Expected: pass

- [ ] **Step 5: Commit**

```bash
git add apps/web packages/ui
git commit -m "feat: add web shell and bot navigation"
```

## Task 9: Implement Messaging and `/new`

**Files:**
- Modify: `apps/web/src/lib/client-protocol.ts`
- Modify: `apps/web/src/app/hosts/[hostId]/bots/[botId]/page.tsx`
- Modify: `apps/edge/src/session-service.ts`
- Modify: `packages/protocol/src/client-relay.ts`
- Create: `apps/web/src/__tests__/chat-session.test.tsx`

- [ ] **Step 1: Write failing messaging tests**

Cover:

- normal message streams chunks into active session
- `/new` sends a `session.new` system command instead of user content
- after `/new`, UI reloads the new active session
- duplicate `/new` retries do not create multiple new sessions
- stale `targetSessionId` produces `session_conflict` and refreshes authoritative session state
- archived sessions render read-only and cannot send

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @openchat/web vitest run chat-session`  
Expected: fail

- [ ] **Step 3: Implement message and session-switch flow**

Implement:

- streaming renderer for chunk/done/error
- `/new` conversion to explicit `session.new` command in client protocol
- optimistic UI only after host confirmation
- archived session list entry for the previous session
- send payloads always include `targetSessionId`

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @openchat/web vitest run chat-session`  
Expected: pass

- [ ] **Step 5: Commit**

```bash
git add apps/web apps/edge packages/protocol
git commit -m "feat: add active session chat and new-session command"
```

## Task 10: End-to-End Integration

**Files:**
- Create: `tests/e2e/openchat-flow.spec.ts`
- Create: `tests/e2e/fixtures/fake-openclaw.ts`
- Create: `tests/e2e/fixtures/fake-edge.ts`
- Modify: `playwright.config.ts`

- [ ] **Step 1: Write failing end-to-end tests**

Cover:

- pair device to host
- verify pairing pins and displays `edgeKeyFingerprint`
- list bots from OpenClaw
- create a bot and verify it appears only after OpenClaw confirms
- send message and receive stream
- execute `/new` and verify active session switches
- disconnect host and verify read-only offline snapshot
- verify offline mode blocks `bot.create` and `session.new`
- reconnect and verify client re-fetches authoritative bot list and `activeSessionId`
- stale session send gets `session_conflict` and UI recovers

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm playwright test tests/e2e/openchat-flow.spec.ts`  
Expected: fail

- [ ] **Step 3: Implement the missing glue for the flow**

Only add the minimum integration code needed to satisfy the e2e tests. Do not add attachments or push notifications yet.

- [ ] **Step 4: Run end-to-end tests**

Run: `pnpm playwright test tests/e2e/openchat-flow.spec.ts`  
Expected: pass

- [ ] **Step 5: Run the full test suite**

Run: `pnpm test`  
Expected: pass

- [ ] **Step 6: Commit**

```bash
git add .
git commit -m "feat: deliver openchat v1 vertical slice"
```

## Task 11: Documentation and Operator Notes

**Files:**
- Modify: `docs/openchat-v1-plan.md`
- Modify: `docs/superpowers/specs/2026-03-18-openchat-design.md`
- Create: `README.md`
- Create: `docs/local-dev.md`

- [ ] **Step 1: Write failing docs acceptance checklist**

Create a short checklist in `README.md` comments or notes for:

- starting relay
- starting edge
- running web
- pairing a host
- creating a bot
- using `/new`
- reconnecting after host offline

- [ ] **Step 2: Document the actual developer flow**

Include:

- required env vars
- SQLite location
- how fake OpenClaw transport works in tests
- where `account-state.json` lives and what owns it
- current v1 limitations

- [ ] **Step 3: Sanity-check docs**

Run:

```bash
pnpm test
pnpm --filter @openchat/web build
pnpm --filter @openchat/relay build
pnpm --filter @openchat/edge build
```

Expected: all succeed

- [ ] **Step 4: Commit**

```bash
git add README.md docs
git commit -m "docs: add openchat operator and developer guides"
```

## Acceptance Criteria

- The system boots as three processes: web, relay, edge.
- Bot list is sourced from OpenClaw `openchat accounts`, not relay-owned config.
- Creating a bot only succeeds when OpenClaw account creation succeeds.
- Each bot exposes exactly one active session at a time.
- `/new` creates a new session and archives the previous one.
- `activeSessionId` is restored from `OPENCLAW_STATE_DIR/openchat/account-state.json`.
- Relay never becomes the bot or session source of truth.
- Host offline mode is explicitly read-only and shows cached state only.
- All unit and e2e tests pass.

## Assumptions and Defaults

- Package manager is `pnpm`.
- All services are written in TypeScript for v1 consistency.
- SQLite is sufficient for relay metadata in v1.
- The OpenClaw host-side adapter uses `openclaw config get|set|unset` and `openclaw agents bind`, not raw JSON file edits.
- The Host-side account-session pointer lives in `OPENCLAW_STATE_DIR/openchat/account-state.json`.
- Attachments, push notifications, and key rotation are intentionally deferred until the vertical slice is stable.
