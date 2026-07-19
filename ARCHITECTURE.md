# Galaxy-M365-MCP — Architecture

> **What this repo is.** `Galaxy-M365-MCP` is a hard fork of
> [`softeria/ms-365-mcp-server`](https://github.com/Softeria/ms-365-mcp-server) — a
> stateless **TypeScript** MCP server that proxies Microsoft Graph. In Galaxy it is
> deployed as the container **`vortex-m365-mcp`** (legacy alias `nexus-m365-mcp`),
> a **BYOT** sidecar: it accepts a per-request Microsoft Graph bearer token and
> forwards it to Graph, holding **no Azure secrets** (`docker-compose.yml:1-12`).
>
> **Read this before trusting the tool names.** The 38 curated `m365_*` tools that
> AI agents actually see are **NOT defined in this repo.** They live in a *separate,
> first-party Python FastMCP server* — `Galaxy-Nexus/mcp_servers/galaxy-m365-mcp/server.py`
> (container `galaxy-m365-mcp`) — which AgentOps binds directly. This TS fork exposes
> ~142 raw **kebab-case** Graph tools instead (`list-mail-messages`, `send-mail`, …),
> and Galaxy seeds describe it as the **"fallback during cutover"**
> (`Galaxy-Nexus/agentops/backend/database/seed_m365_assistant.sql`). See
> [§3 Component map](#3-component-map). The two servers share the confusable "m365-mcp"
> name; do not conflate them.
>
> **Stale-doc warning.** This repo's `README.md` and `docs/deployment.md` are the
> *upstream* softeria docs. They describe a generic "each MCP client runs its own
> OAuth" model that Galaxy does **not** use. Where they disagree with this document
> or `docker-compose.yml`, this document is authoritative.

---

## 1. Purpose

Give Galaxy AI agents (and, via the connector facade, external MCP clients) the
ability to act on a user's Microsoft 365 tenant — Outlook mail, calendar, Teams
chats/meetings, OneDrive/SharePoint files, To-Do — through Microsoft Graph,
**strictly within that one user's own delegated authority** (agent = a virtual
person holding the user's key). This TS server is a stateless Graph proxy over MCP
on the internal Docker network; identity/token-minting is done elsewhere.

## 2. Tech stack (this repo)

| Concern              | Choice |
| -------------------- | ------ |
| Language / runtime   | TypeScript, Node.js 24 Alpine, ESM (`package.json:5`, `Dockerfile:1`) |
| MCP SDK / transport  | `@modelcontextprotocol/sdk` ^1.29, Express 5 + `StreamableHTTPServerTransport`, stateless (`server.ts:3,708`) |
| Graph auth library   | `@azure/msal-node` — present but **dormant** under BYOT |
| Tool surface         | Generated from Graph OpenAPI → `src/generated/client*.ts` + `src/endpoints.json` (311 endpoints) |
| Hardening            | `helmet`, `express-rate-limit`, retry + circuit-breaker (`src/lib/graph-resilience.ts`) |
| Observability        | OpenTelemetry Node auto-instrumentation → `otel-collector:4318` (`docker-compose.yml:32-40`) |
| Build / test         | `tsup` → `dist/`; `vitest` (48 test files under `test/`) |

## 3. Component map

The Galaxy Microsoft 365 integration is **four** tiers. This repo is one of them.

```
 INTERNAL agents                         EXTERNAL MCP clients
 (AgentOps react_agent)                  (Claude.ai / ChatGPT / Claude Code)
        │                                        │
        │ binds MCP server (DB seed)             │ OAuth 2.1 (RS256, PKCE, DCR)
        │ http://galaxy-m365-mcp:3000/mcp        │ https://ai.skyplatform.net/m365-mcp/mcp
        ▼                                        ▼
┌─────────────────────────────┐         ┌──────────────────────────────────────┐
│ PRIMARY  galaxy-m365-mcp     │         │ vortex-m365-connector                │
│ Python FastMCP server        │         │ (services/m365-connector, FastAPI)   │
│ mcp_servers/galaxy-m365-mcp/ │         │ OAuth 2.1 resource facade:           │
│ server.py — defines all 38   │         │ verify Galaxy RS256 token → read sub │
│ m365_* tools, calls Graph    │         │ → broker-swap for Graph token →      │
│ directly (BYOT).             │         │ reverse-proxy to M365_SIDECAR_URL    │
└───────────────┬──────────────┘         └───────────────┬──────────────────────┘
                │                                         │ M365_SIDECAR_URL default =
                │  Authorization: Bearer <graph token>    │ http://galaxy-m365-mcp:3000  (!)
                ▼                                         ▼   see §8 finding S1
        Microsoft Graph                       ┌───────────────────────────────────┐
        (graph.microsoft.com)                 │ THIS REPO  vortex-m365-mcp        │
                                              │ (nexus-m365-mcp) TS softeria fork │
                                              │ BYOT sidecar, ~142 kebab Graph    │
                                              │ tools. "fallback during cutover". │
                                              └───────────────┬───────────────────┘
                                                              ▼  Bearer <graph token> (verbatim)
                                                       Microsoft Graph

 TOKEN SUPPLY (out of band, shared by all paths):
┌───────────────────────────────────────────────────────────────────────────────┐
│ identity_service M365 broker (Galaxy-Nexus/identity_service)                    │
│  • User links mailbox once: /m365/connect/init → callback → encrypted refresh   │
│    token in linked_identities (provider azure_ad_m365).                         │
│  • Per turn: POST /internal/m365/graph-token (X-Service-Secret) mints a FRESH   │
│    delegated Graph access token from that user's saved refresh token.           │
└───────────────────────────────────────────────────────────────────────────────┘
```

- **PRIMARY (not this repo):** `Galaxy-Nexus/mcp_servers/galaxy-m365-mcp/server.py`,
  container `galaxy-m365-mcp`. Native `m365_*` FastMCP tools, bound by AgentOps in
  `seed_m365_assistant.sql:21` (`"url":"http://galaxy-m365-mcp:3000/mcp"`,
  `"galaxy_auth":"m365"`). Reads the request bearer into a `ContextVar` and calls
  `GRAPH="https://graph.microsoft.com/v1.0"` directly (`server.py:39,920-933`).
- **THIS REPO:** container `vortex-m365-mcp` / `nexus-m365-mcp`. TS BYOT sidecar,
  kebab-case Graph tools. Exposed to external clients via the connector.
- **Connector (not this repo):** `Galaxy-Nexus/services/m365-connector`, container
  `vortex-m365-connector`. OAuth 2.1 resource-server facade for external clients
  (RFC 9728 PRM + RFC 8707 audience). Verifies a Galaxy RS256 token, swaps `sub` for
  a Graph token via the broker, reverse-proxies MCP (`app/main.py:1-53`).
- **Broker (not this repo):** `Galaxy-Nexus/identity_service`. Mailbox connect +
  per-user Graph-token mint. See [§6](#6-auth--acts-as-user-model).

## 4. Request lifecycle (this repo, BYOT path)

1. A caller (the connector, or AgentOps if pointed here) sends
   `POST /mcp` with `Authorization: Bearer <graph-token>` + a JSON-RPC `tools/call`.
2. `microsoftBearerTokenAuthMiddleware` (`lib/microsoft-auth.ts:91-150`) requires the
   header and, **for JWTs only**, checks `exp` is not past (`isJwtExpired`,
   `microsoft-auth.ts:46-56`). It does **not** verify signature/audience/issuer —
   Graph is the validator. Token → `req.microsoftAuth.accessToken`.
3. `--obo` is intentionally **off** (`docker-compose.yml:23-24`); the bearer is used
   directly (no On-Behalf-Of exchange). The handler runs the request inside
   `requestContext.run({ accessToken }, …)` (`server.ts:766-772`), an
   `AsyncLocalStorage` (`request-context.ts`).
4. A fresh stateless `McpServer` + transport is created per request
   (`server.ts:707-710,752-755`).
5. Tool handler → `executeGraphTool` (`graph-tools.ts:631`) → `GraphClient.makeRequest`,
   which reads the token from the request context **first** (`graph-client.ts:95-97`)
   and calls Graph through the resilience layer (`graph-client.ts:182-210`).
6. One JSON audit line per call, UPN decoded from the token (`audit-log.ts:99-133`).

Because the token always arrives via `requestContext`, the MSAL/`AuthManager` paths
(`auth.ts`) are dormant here: no token cache, no device-code login, no client secret.
With no context token and no MSAL cache, `GraphClient` throws `No access token
available` (`graph-client.ts:99`) — fail-closed.

## 5. MCP tool inventory

### 5a. Agent-facing `m365_*` tools — 38 total (defined in the sibling Python server)

These are the tools an AI agent invokes. **Provenance:** every one is an `@mcp.tool()`
in `Galaxy-Nexus/mcp_servers/galaxy-m365-mcp/server.py` (NOT this repo); each calls
Graph `v1.0` directly. Write tools carry an "OUTWARD-FACING — only call after the user
confirms" gate in their description (human-in-the-loop at the tool layer). Grouped:

| Group | `m365_*` tool → Graph endpoint (`server.py` line) |
| ----- | ------------------------------------------------- |
| **Mail (14)** | `list_mail` GET `/me/mailFolders/{f}/messages` `:146` · `get_mail` GET `/me/messages/{id}` `:162` · `search_mail` GET `/me/messages?$search` `:177` · `draft_reply` POST `createReply[All]` `:197` · `create_draft` POST `/me/messages` `:210` · `send_reply` POST `reply[All]` `:225` · `send_mail` POST `/me/sendMail` `:235` · `forward_mail` POST `/forward` `:252` · `mark_read` PATCH `/me/messages/{id}` `:264` · `move_mail` POST `/move` `:272` · `delete_mail` DELETE `/me/messages/{id}` `:281` · `list_folders` GET `/me/mailFolders` `:289` · `list_attachments` GET `/attachments` `:300` · `get_attachment` GET `/attachments/{aid}` `:309` |
| **Calendar (10)** | `list_events` GET `/me/calendarView` `:332` · `check_free_busy` POST `/me/calendar/getSchedule` `:366` · `schedule_teams_meeting` POST `/me/events` (online) `:404` · `reschedule_event` PATCH `/me/events/{id}` `:429` · `cancel_event` POST `/cancel` `:440` · `respond_event` POST `accept|decline|tentativelyAccept` `:448` · `get_event` GET `/me/events/{id}` `:471` · `create_event` POST `/me/events` `:488` · `update_event` PATCH `/me/events/{id}` `:515` · `find_meeting_times` POST `/me/findMeetingTimes` `:545` |
| **Teams (4)** | `list_chats` GET `/me/chats` `:595` · `get_chat_messages` GET `/me/chats/{id}/messages` `:608` · `send_chat_message` POST `/me/chats/{id}/messages` `:626` · `create_chat` POST `/chats` `:635` |
| **Files (4)** | `search_files` POST `/search/query` (driveItem) `:832` · `list_drive_files` GET `/me/drive/root/children` `:854` · `get_file_download_url` GET driveItem → `@microsoft.graph.downloadUrl` `:874` · `create_upload_session` POST `…/createUploadSession` `:893` |
| **To-Do (6)** | `list_task_lists` GET `/me/todo/lists` `:702` · `list_tasks` GET `/me/todo/lists/{lid}/tasks` `:717` · `create_task` POST `…/tasks` `:735` · `complete_task` PATCH `…/tasks/{id}` `:756` · `update_task` PATCH `…/tasks/{id}` `:770` · `delete_task` DELETE `…/tasks/{id}` `:798` |

Every `m365_*` group has an equivalent among this repo's raw Graph tools (below),
hitting the same Graph endpoints — the difference is naming, opinionated schemas
(snake_case, ICT/Vietnam timezone, confirmation gates) vs. this repo's spec-faithful
kebab tools.

### 5b. Tools this repo actually registers (kebab-case)

Launched with `--org-mode --preset mail,calendar,teams` (`docker-compose.yml:26`).
`endpoints.json` has 311 endpoints; those three presets select **142 distinct Graph
tools** (e.g. `list-mail-messages`, `send-mail`, `create-calendar-event`,
`get-schedule`, `find-meeting-times`, `create-online-meeting`, `list-chats`,
`send-chat-message`). Registration + gating: `registerGraphTools`
(`graph-tools.ts:1087-1370`); preset membership is an exact tool-name allow-list from
`endpoints.json.presets` (`tool-categories.ts:71-93`).

Plus **3 utility tools**, always registered (`graph-tools.ts:253-611`):
`parse-teams-url`, `download-bytes` (base64 any Graph binary), `get-download-url`
(resolve a pre-authenticated `@microsoft.graph.downloadUrl`).

OneDrive/To-Do Graph tools exist in `endpoints.json` but are **outside** the
mail/calendar/teams presets, so this fork does not expose them in the current deploy
(widen with `--preset …,files,tasks`). Auth helper tools (`login`, `logout`,
`list-accounts`, …) are **disabled in HTTP mode** unless `--enable-auth-tools`
(`server.ts:108-111`); Galaxy does not set it.

## 6. Auth & acts-as-user model

Delegated, per-user, minted centrally by the identity broker; this repo is only ever
a BYOT recipient.

- **Mailbox connect (one-time).** `identity_service/api/auth.py`: `GET /m365/connect/init`
  (`:247-283`) builds the Azure authorize URL (`login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize`,
  `prompt=select_account`); `GET /m365/connect/callback` (`:286-368`) exchanges the code
  (confidential client), reads `/me`, and stores the **refresh token** via
  `link_identity(...)` under provider `azure_ad_m365`. Teams uses `azure_ad_m365_chat`
  (`:371-400`). Stored in table `linked_identities`, columns `access_token` /
  `refresh_token` as `EncryptedText` — **encrypted at rest** (`identity_service/models/user.py:79-97`).
- **Delegated scopes requested** (`identity_service/sso/m365.py:23-39`): `offline_access,
  openid, profile, email, Mail.Read, Mail.ReadWrite, Mail.Send, Calendars.ReadWrite,
  OnlineMeetings.ReadWrite, Tasks.ReadWrite`; optional `Files.ReadWrite.All +
  Sites.ReadWrite.All` when `M365_FILES_ENABLED` (`:62-68`); Teams adds `Chat.Read,
  Chat.ReadWrite, Chat.Create, User.ReadBasic.All` (`:79-86`).
- **Token mint (per turn).** `POST /internal/m365/graph-token`
  (`identity_service/api/internal.py:806-882`), guarded by `verify_service_secret_strict`
  (`X-Service-Secret == INTERNAL_SERVICE_SECRET`, `:809,131-153`; `/internal/*` is
  loopback-only). Looks up that user's `azure_ad_m365` `LinkedIdentity`, reuses a cached
  access token if valid, else does a **`refresh_token` grant** (confidential client:
  `AZURE_AD_CLIENT_ID`/`SECRET`/`TENANT_ID`, `config.py:108-126`) against
  `login.microsoftonline.com/{tenant}/oauth2/v2.0/token`, and persists the rotated
  tokens. It is a **direct `httpx` POST**, not MSAL.
- **Identity determination.** The user comes from the caller's **JWT `sub`/`email`**
  (AgentOps: `chat.py:383-384` → `enrich_m365_headers` → `resolve_graph_token`;
  connector: verified RS256 token `sub`), not a spoofable header. The broker mints a
  token scoped to **that one user only** — no app-wide/impersonation grant.
- **This repo adds no identity of its own.** It trusts that the bearer it receives is a
  genuine broker-minted per-user Graph token; it neither reads `act_as` nor checks
  audience. The acts-as-user guarantee is a property of the broker + network isolation,
  not of this tier — see [§8](#8-security-notes).

## 7. Graph scopes (this repo)

Scopes are derived from enabled tools, not hard-coded. `buildScopesFromEndpoints`
(`auth.ts:282-331`) unions per-endpoint `scopes`/`workScopes` from `endpoints.json`.
For the mail+calendar+teams+org-mode surface: `Mail.ReadWrite`, `Mail.Send`,
`MailboxSettings.ReadWrite`, `Calendars.ReadWrite`, `Calendars.Read.Shared`,
`Chat.ReadWrite`, `ChannelMessage.Send`, `OnlineMeetings.ReadWrite`, `Presence.Read.All`,
`Team.ReadBasic.All`, … plus always-injected `User.Read` + `offline_access`
(`server.ts:531-556`). Work/school tools are skipped without `--org-mode`
(`graph-tools.ts:1116-1120`). These are the scopes this fork *would* request when
driving its own OAuth; under BYOT the **actual** token scopes are whatever the broker
consented at connect time (§6). Print the minimal list with
`node dist/index.js --org-mode --preset mail,calendar,teams --list-permissions`.

## 8. Security notes

1. **No cryptographic token validation in this tier** (`microsoft-auth.ts:91-150`) —
   only `exp`, only for JWTs; opaque tokens pass through. Any caller reaching
   `vortex-m365-mcp:3000/mcp` with *any* valid user Graph token acts as that user. This
   is acceptable *by design* (Graph validates), **but the acts-as-user guarantee rests
   entirely on the broker minting per-user tokens and on network isolation — this tier
   adds none.**
2. **Network isolation is load-bearing.** `expose: "3000"` (no `ports:`) on the external
   `galaxy_network` (`docker-compose.yml:41-52`) — in-cluster only. External reach is
   *supposed* to go through the connector's OAuth facade (RS256 verify, scope-gated).
3. **Finding S1 — connector target vs. this repo (naming/config mismatch).** The
   connector's docstring says it fronts "the TS fork (nexus-m365-mcp)"
   (`services/m365-connector/app/main.py:3,38`), but its configured
   `M365_SIDECAR_URL` default is `http://galaxy-m365-mcp:3000`
   (`main.py:39`, `services/m365-connector/docker-compose.yml:20`) — the hostname of the
   **Python** server, not this repo's container (`vortex-m365-mcp`/`nexus-m365-mcp`,
   `docker-compose.yml:52`). Either this fork is no longer the connector's proxy target
   (post-cutover) or there is a hostname mismatch. Confirm which container the connector
   actually reaches in prod before relying on this repo being in the live path.
4. **Full read-write, org-mode, no `--read-only`.** Every write tool in the presets is
   live (send/delete mail, delete events, post to Teams). This repo enforces no
   confirmation; the human-in-the-loop gate lives only in the *Python* server's tool
   descriptions (§5a) — external clients hitting this fork's kebab tools get no such gate.
5. **Unused-but-open OAuth surface.** `/authorize`, `/token`, `/register`, `.well-known/*`
   are all live in HTTP mode (`server.ts:338-412,563-692`) and dynamic client
   registration defaults **on** (`cli.ts:274-280`). BYOT never uses them → dead,
   rate-limited surface on the internal network. Consider `--no-dynamic-registration`.
6. **`get-download-url` / `m365_get_file_download_url` return a pre-authenticated URL**
   granting time-limited *unauthenticated* read of the file (`graph-tools.ts:574-601`).
   Must not be logged or forwarded to untrusted sinks.
7. **`/health` discloses `orgMode`** unauthenticated (`server.ts:258-260`) — negligible.

## 9. Deploy topology (this repo)

- **Container:** `vortex-m365-mcp` (alias `nexus-m365-mcp`), `mem_limit: 768m`,
  `restart: unless-stopped`, external `galaxy_network`, `expose: 3000` only
  (`docker-compose.yml:15-52`).
- **Command:** `--http 0.0.0.0:3000 --org-mode --preset mail,calendar,teams`
  (`docker-compose.yml:26`); entrypoint `["node","dist/index.js"]` (`Dockerfile:22`).
- **Image:** two-stage Node 24 Alpine (`npm ci` → `npm run generate` → `npm run build`;
  release `npm ci --omit=dev`), `NODE_ENV=production`.
- **Env:** `MS365_MCP_CORS_ORIGIN` (default `https://ai.skyplatform.net`),
  `MS365_MCP_TRUST_PROXY_HOPS=1`, OpenTelemetry (`OTEL_SERVICE_NAME=galaxy-m365-mcp`,
  OTLP → `otel-collector:4318`).
- **Healthcheck:** `node -e "fetch('http://localhost:3000/health')…"` every 30s
  (`docker-compose.yml:43-48`); `/health` is unauthenticated, declared before
  CORS/rate-limit/auth (`server.ts:258-260`).
- **Prod host:** SSH `galaxy-ubuntu-remote`, repo at `~/Nexus/Galaxy-M365-MCP`,
  `git pull && docker compose up -d --build` (memory `reference_prod_deploy_topology`).
- **Galaxy delta vs upstream fork** is thin and deploy-only: `/health` probe
  (`8af3bfa`), `docker-compose.yml` sidecar (`3779e5b`), CORS default (`d8f03af`),
  OTel (`33a4c3e`), vortex rename + dual alias (`0a64379`), persisted `mem_limit`
  (`087bfc9`). All application logic is upstream softeria.

### Endpoints exposed by this server (HTTP mode)

| Path | Method | Auth | Notes |
| ---- | ------ | ---- | ----- |
| `/health` | GET | none | Galaxy liveness probe (`server.ts:258`) |
| `/` | GET | none | "…is running" (`server.ts:793`) |
| `/mcp` | GET/POST | Bearer | MCP JSON-RPC; BYOT token used verbatim (`server.ts:702-790`) |
| `/authorize` `/token` `/register` | GET/POST | none | OAuth proxy to Entra — **unused under BYOT** |
| `/.well-known/oauth-authorization-server` | GET | none | OAuth metadata |
| `/.well-known/oauth-protected-resource[/*]` | GET | none | RFC 9728 metadata |
