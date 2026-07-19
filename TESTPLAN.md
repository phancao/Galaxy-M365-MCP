# Galaxy-M365-MCP — Test Plan

Smoke tests for the Galaxy Microsoft 365 integration. Numbered features, each with a
concrete smoke test and expected result. Priority order: **health → M365 connect /
token mint → mail → calendar → Teams → files/tasks → hardening.**

## How to exercise this

Three surfaces, pick per test:

- **A. This repo directly** (`vortex-m365-mcp`, TS BYOT sidecar) — `curl`/MCP against
  `http://<host>:3000` from a container on `galaxy_network`. Tools are **kebab-case**
  (`list-mail-messages`, `send-mail`). Requires a real per-user Graph bearer.
- **B. The agent-facing `m365_*` tools** (defined in the sibling Python server
  `mcp_servers/galaxy-m365-mcp`, container `galaxy-m365-mcp`) — call them from an MCP
  client already connected to `galaxy-m365` (e.g. this agent). These act on the
  **signed-in user's real M365 mailbox**.
- **C. The identity broker** (`identity_service`) — the connect UI flow + internal
  token-mint endpoint.

> **Destructive-test caution.** `send_mail`, `send_reply`, `forward_mail`,
> `delete_mail`, `create_event`, `schedule_teams_meeting`, `cancel_event`,
> `send_chat_message`, `create_chat`, `delete_task` mutate a real tenant. Use a test
> user, send only to yourself, prefer `create_draft` over `send_mail`, and clean up.
> Tests below marked **[MUTATES]** must run only against a disposable/test mailbox.

---

## 1. Health / liveness (Surface A)
**Test.** `curl -s http://vortex-m365-mcp:3000/health` (or exec the compose healthcheck).
**Expect.** `200` + `{"status":"ok","service":"galaxy-m365-mcp","orgMode":true}`
(`server.ts:258-260`). Prod: `ssh galaxy-ubuntu-remote 'docker exec vortex-m365-mcp node -e "fetch(\"http://localhost:3000/health\").then(r=>r.json()).then(j=>console.log(j)).catch(()=>process.exit(1))"'`.
Also `docker ps` should show `vortex-m365-mcp` as `healthy`.

## 2. Bearer-token enforcement (Surface A)
**Test.** `curl -s -o /dev/null -w '%{http_code}' -X POST http://vortex-m365-mcp:3000/mcp -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list-mail-messages","arguments":{}}}'` (no `Authorization`).
**Expect.** `401` + `WWW-Authenticate: Bearer …` header (`microsoft-auth.ts:111-132`).
A request with an **expired** JWT bearer also returns `401 invalid_token`
(`microsoft-auth.ts:136-145`).

## 3. MCP discovery / tool catalog (Surface A)
**Test.** `POST /mcp` with `method:"tools/list"` and any well-formed (unexpired) bearer.
**Expect.** JSON-RPC result listing ~145 tools: 142 kebab Graph tools for
mail/calendar/teams + `parse-teams-url`, `download-bytes`, `get-download-url`. No
`login`/`logout` tools (disabled in HTTP mode, `server.ts:108-111`). No `list-users`
or OneDrive/To-Do tools (outside the preset).

## 4. M365 mailbox connect flow (Surface C)
**Test.** As a signed-in user without a linked mailbox, `GET /api/identity/auth/m365/connect/init`;
follow `redirect_url` to Microsoft, consent, land on the callback.
**Expect.** Azure authorize URL carries the delegated scopes from `sso/m365.py:23-39`
(`Mail.ReadWrite`, `Calendars.ReadWrite`, `OnlineMeetings.ReadWrite`, `Tasks.ReadWrite`,
`offline_access`, …). After callback (`api/auth.py:286-368`), a row exists in
`linked_identities` with `provider='azure_ad_m365'`, non-null **encrypted**
`refresh_token`, and `token_expires_at` (`models/user.py:79-97`). Teams connect
(`/m365/connect/teams/init`) yields a second row `provider='azure_ad_m365_chat'`.

## 5. Per-user Graph token mint (Surface C)
**Test (internal, loopback only).**
`curl -s -X POST http://nexus-identity:8086/internal/m365/graph-token -H "X-Service-Secret: $INTERNAL_SERVICE_SECRET" -H 'content-type: application/json' -d '{"user_id":"<uuid>","email":"<user@tenant>"}'`.
**Expect.** `200` + a Graph access token whose payload `upn`/`preferred_username` is that
user (`api/internal.py:806-882`). Wrong/absent secret → `401/403`
(`verify_service_secret_strict`, `:131-153`). A user who never connected → `404`/reconnect
error. Negative: the same call from off-loopback must be refused (router is
loopback-only per root `docker-compose.yml`).

## 6. End-to-end acts-as-user isolation (Surfaces B+C)
**Test.** As user A, call `m365_list_mail` (`top:3`); as user B (separate session), same.
**Expect.** Each returns only that user's own inbox — no cross-tenant/cross-user leakage.
The token bound per turn (`m365_graph.py:enrich_m365_headers`) is A's vs B's; the sidecar
uses it verbatim. This is the core acts-as-user guarantee.

## 7. Mail — list inbox (Surface B; A = `list-mail-messages`)
**Test.** `m365_list_mail` `{folder:"inbox", top:5}`.
**Expect.** Newest-first array of messages with `subject`, `from`, `receivedDateTime`
(Graph `GET /me/mailFolders/inbox/messages`, `server.py:146`). Read-only, safe.

## 8. Mail — get one message (Surface B)
**Test.** `m365_get_mail {message_id:<id from #7>}`.
**Expect.** Full message incl. body; `200`. (`GET /me/messages/{id}`, `server.py:162`.)

## 9. Mail — search (Surface B)
**Test.** `m365_search_mail {query:"invoice", top:5}`.
**Expect.** KQL `$search` results; no `$filter` combined (`server.py:177`). Empty result
set is a valid pass if the mailbox has no match.

## 10. Mail — create draft (Surface B, non-destructive)
**Test.** `m365_create_draft {to:["self@tenant"], subject:"[test] draft", body:"<p>hi</p>"}`.
**Expect.** A draft appears in Drafts; nothing sent (`POST /me/messages`, `server.py:210`).
Preferred over #11 for routine smoke.

## 11. Mail — send **[MUTATES]** (Surface B; A = `send-mail`)
**Test.** `m365_send_mail {to:["self@tenant"], subject:"[test] smoke", body:"<p>ok</p>"}`.
**Expect.** Mail arrives in your own inbox within ~1 min; tool returns success
(`POST /me/sendMail`, `server.py:235`). Confirms outbound path + `Mail.Send` scope.
Note the tool's own description requires explicit user confirmation before sending.

## 12. Mail — mark read / move (Surface B)
**Test.** `m365_mark_read {message_id:<id>, is_read:true}`, then `m365_list_folders`.
**Expect.** Message `isRead` flips (`PATCH`, `server.py:264`); `list_folders` returns the
folder tree incl. destination ids for `m365_move_mail` (`server.py:272,289`).

## 13. Calendar — list events for a day (Surface B; A = `list-calendar-events`)
**Test.** `m365_list_events {day_offset:1}` (tomorrow, whole day in ICT).
**Expect.** Events with `subject`, `start`/`end`, Teams join link, organizer, attendees,
plus the window used (`GET /me/calendarView`, `server.py:332`). Verifies the ICT
day-window logic, not a rolling now→now+N window.

## 14. Calendar — free/busy (Surface B)
**Test.** `m365_check_free_busy {day_offset:1}` (A: `get-schedule`).
**Expect.** Busy/free blocks for the user's own calendar (`POST /me/calendar/getSchedule`,
`server.py:366`). Read-only.

## 15. Calendar — find meeting times (Surface B)
**Test.** `m365_find_meeting_times` with 1–2 attendee emails and a duration.
**Expect.** Suggested slots ranked by availability (`POST /me/findMeetingTimes`,
`server.py:545`).

## 16. Calendar — create / schedule Teams meeting **[MUTATES]** (Surface B)
**Test.** `m365_schedule_teams_meeting {subject:"[test]", start_iso, end_iso, attendees:["self@tenant"]}`.
**Expect.** Event created **with a Teams join URL**, invite sent (`POST /me/events` with
online meeting, `server.py:404`). Then `m365_reschedule_event` (PATCH, `:429`) shifts it,
and `m365_cancel_event` (`:440`) cancels — clean up the test event.

## 17. Teams — list chats (Surface B; A = `list-chats`)
**Test.** `m365_list_chats {top:10}`.
**Expect.** Recent 1:1/group chats with `id`, type, topic/members, last-message preview
(`GET /me/chats`, `server.py:595`). Requires the `azure_ad_m365_chat` connection (#4).

## 18. Teams — read chat messages (Surface B)
**Test.** `m365_get_chat_messages {chat_id:<id from #17>, top:10}`.
**Expect.** Recent messages for that chat (`GET /me/chats/{id}/messages`, `server.py:608`).

## 19. Teams — send chat message **[MUTATES]** (Surface B)
**Test.** `m365_send_chat_message {chat_id:<a test chat/self-chat>, content:"[test] ping"}`.
**Expect.** Message posts (HTML body preferred), returns id (`POST …/messages`,
`server.py:626`). Use a self-chat or test group only.

## 20. Files — search & download URL (Surface B; requires `M365_FILES_ENABLED` + admin-consented file scopes)
**Test.** `m365_search_files {query:"budget", top:5}` → `m365_get_file_download_url {drive_id, item_id}`.
**Expect.** Files with `name`, `drive_id`, `id`, web link (`POST /search/query`,
`server.py:832`); download URL is a pre-authenticated Graph URL (`server.py:874`) —
**do not log it** (see ARCHITECTURE §8.6). If file scopes are not consented, expect a
Graph `403` — a valid "not-enabled" pass.

## 21. To-Do — list & complete task (Surface B)
**Test.** `m365_list_task_lists` → `m365_list_tasks {list_id}` → `m365_create_task` **[MUTATES]** →
`m365_complete_task` → `m365_delete_task`.
**Expect.** Default "Tasks" list resolves when `list_id` omitted (`server.py:685,702`);
create/complete/delete round-trip cleanly (`:735,756,798`). Requires `Tasks.ReadWrite`.

## 22. Read-only / scope error surfacing (Surface A)
**Test.** Present a token missing a needed scope (e.g. mail-only token) and call a
Teams tool.
**Expect.** Graph `403` is rewritten to a clear scope error mentioning `--org-mode`
(`graph-client.ts:106-115`). Confirms errors aren't silently swallowed.

## 23. Graph resilience (Surface A, optional)
**Test.** Induce a 429/503 from Graph (or unit test `test/graph-resilience.test.ts`).
**Expect.** 429 honours `Retry-After` and retries on any method; 503/504/network retry
only for idempotent methods; circuit breaker opens after 5 consecutive failures
(`lib/graph-resilience.ts`). POST/PATCH are **not** retried on 5xx (no duplicate sends).

## 24. External-client OAuth facade (Surface = connector, `vortex-m365-connector`)
**Test.** `curl -i https://ai.skyplatform.net/m365-mcp/mcp` with no token.
**Expect.** `401` + `WWW-Authenticate` pointing to
`/.well-known/oauth-protected-resource`; PRM names Nexus identity as the auth server and
advertises `mcp:m365:read`/`mcp:m365:write` (`services/m365-connector/app/main.py:63-70`,
`database/seed_m365_connector.sql`). With a valid RS256 token (aud
`https://ai.skyplatform.net/m365-mcp`), the request is broker-swapped and proxied.
**Also verify Finding S1:** confirm which sidecar the connector actually proxies to —
its `M365_SIDECAR_URL` defaults to `http://galaxy-m365-mcp:3000` (the Python server),
not this repo's `vortex-m365-mcp` (ARCHITECTURE §8.3).

## 25. Audit trail (Surface A)
**Test.** Run any tool call, then inspect container logs / `~/.ms-365-mcp-server/logs/audit.log`.
**Expect.** One JSON line per call with `{event, request_id, user_principal_name, tool,
http_method, status, duration_ms}` and **no** tool params or response bodies
(`audit-log.ts:82-133`). UPN is decoded from the bearer.

## 26. Regression suite (Surface A, CI)
**Test.** `npm run verify` (generate + lint + format:check + build + `vitest run`).
**Expect.** All 48 test files pass. Fast pre-deploy gate; does not exercise a live tenant.
