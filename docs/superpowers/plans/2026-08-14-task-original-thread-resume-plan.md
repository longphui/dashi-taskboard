# Task Original-Thread Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every local Taskboard issue returned to `todo` resume durably in its original Codex thread without scheduled-run handoff calls or replacement windows.

**Architecture:** Local SQLite stores one durable resume request per returned-task cycle. The resident Taskboard injector leases requests through local HTTP endpoints, waits for the exact Codex thread to become idle, and calls Codex App Server `turn/start` with a per-delivery idempotency key. Task state changes acknowledge or cancel the request transactionally; scheduled automation handles only unbound new work.

**Tech Stack:** Node.js 22.5+, `node:sqlite`, Node HTTP server, React 19, TypeScript, Vite, Tauri 2, Chrome DevTools Protocol, Codex App Server v2 RPC.

## Global Constraints

- Implement only local mode. Do not modify `cloud/src/index.mjs` or `cloud/migrations`.
- Preserve Cloud mode's existing scheduled handoff and policy behavior; select the new prompt, worker, reconciliation, and cleanup only when `/api/meta` reports local mode.
- Continue only the exact `task.threadId`; never fork or create a fallback thread.
- Never interrupt or steer an active turn; wait until the original thread is idle.
- Persist the resume request in the same SQLite transaction that returns the task to `todo`.
- Keep the task `todo` until the original thread claims it with the matching thread ID.
- Do not call `send_message_to_thread` or `automation_update` from a local-mode scheduled automation run.
- Do not auto-archive a thread referenced by a task or open resume request.
- Preserve existing optimistic `version` checks, dependency rules, branch/worktree binding, comments, and conversation history.
- Use existing dependencies only; add no queue, scheduler, or state-machine package.
- Follow `/Volumes/work/taskboard/AGENTS.md`: prove the real operation path first, implement the smallest main path, and demonstrate it before adding regression protection.
- Do not add regression tests before the user confirms the built feature works. Task 10 is gated on that confirmation.

**Approved design:** `docs/superpowers/specs/2026-08-14-task-original-thread-resume-design.md`

---

## File Map

| File | Responsibility in this change |
| --- | --- |
| `server/database.mjs` | Queue schema, backfill, task projection, leasing, state transitions, transactional create/ack/cancel |
| `server/app.mjs` | Local-only queue endpoints, request validation, SSE task refresh |
| `scripts/codex-injector.mjs` | Queue worker, Codex thread resume/turn start, turn observation, policy reconciliation, scan cleanup |
| `shared/taskboard-automation.mjs` | Generated prompt and host policy decision based on claimable unbound work |
| `skills/manage-taskboard/SKILL.md` | Agent ownership semantics for bound returned tasks |
| `web/src/types.ts` | `TaskResumeRequest` and `Task.resumeRequest` contract |
| `web/src/api.ts` | Failed-resume retry request |
| `web/src/App.tsx` | Retry mutation and refreshed task state |
| `web/src/components/TaskCard.tsx` | Compact queue/delivery state on `todo` and `in_progress` cards |
| `web/src/components/TaskDetail.tsx` | Detailed state, exact error, retry action |
| `web/src/styles.css` | Existing-style status row and failure action styling |
| `test/server.test.mjs` | Post-acceptance persistence/API regression coverage |
| `test/taskboard-automation.test.mjs` | Post-acceptance prompt/policy regression coverage |
| `test/injector.test.mjs` | Post-acceptance host RPC and cleanup contract coverage |

---

### Task 1: Re-establish the failing operation path before coding

**Files:**
- Read: `web/src/components/TaskDetail.tsx:696-726`
- Read: `web/src/App.tsx:2090-2167`
- Read: `server/database.mjs:1707-1883`
- Read: `shared/taskboard-automation.mjs:61-77`
- Read: `/Users/suqingsha/.codex/automations/taskboard-fenlu-abp/memory.md`

**Interfaces:**
- Consumes: Current installed Taskboard behavior and the existing fork at commit `182f6c4`.
- Produces: A user-visible pre-implementation proof of entry point → state mutation → scheduled handoff → observable stall.

- [ ] **Step 1: Confirm the implementation workspace is exact and clean**

Run:

```bash
git status -sb
git log -2 --oneline
git rev-parse origin/main
```

Expected: `main` is ahead of `origin/main` only by the approved design and implementation-plan documentation commits; no uncommitted files exist.

- [ ] **Step 2: Re-read the current main path and cite it to the user**

Run:

```bash
rg -n "changeStatusToTodo|onUpdate\(currentTask, \{ status: \"todo\" \}\)|thread_id = COALESCE|send_message_to_thread" \
  web/src/components/TaskDetail.tsx server/database.mjs shared/taskboard-automation.mjs
```

Expected proof:

1. Comment submission changes the issue to `todo`.
2. SQLite preserves the original thread binding.
3. The scheduled prompt refuses the current run and calls `send_message_to_thread`.
4. The automation memory records that the call remained pending.

- [ ] **Step 3: State the direct success criterion before editing**

Record in commentary:

```text
Success means a bound issue returned to todo creates a durable local request, waits without interrupting an active original thread, adds exactly one turn to that same thread when idle, and becomes acknowledged only when that thread claims the issue as in_progress. No replacement thread or scheduled-run send call is allowed.
```

No files or commits are created in this task.

---

### Task 2: Add durable resume-request persistence and task projection

**Files:**
- Modify: `server/database.mjs:20-110`
- Modify: `server/database.mjs:350-560`
- Modify: `server/database.mjs:1552-1605`
- Modify: `server/database.mjs:1707-1942`
- Modify: `server/database.mjs:2288-2320`

**Interfaces:**
- Consumes: Existing `TaskboardDatabase`, `now()`, `randomUUID()`, task `version`, task `threadId`.
- Produces:
  - `task.resumeRequest`
  - `claimTaskResumeRequest(projectIds, leaseSeconds)`
  - `deferTaskResumeRequest(id, leaseToken, delaySeconds, reason)`
  - `markTaskResumeRequestDispatched(id, leaseToken, turnId)`
  - `failTaskResumeRequest(id, leaseToken, error, retryAfterSeconds, permanent)`
  - `cancelTaskResumeRequest(id, leaseToken, reason)`
  - `retryTaskResumeRequest(taskId, requestId)`
  - `listOpenTaskResumeThreadIds()`

- [ ] **Step 1: Add one row mapper and extend task activity attachment**

Add this exact shape near the existing row mappers:

```js
function taskResumeRequestFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    taskId: row.task_id,
    projectId: row.project_id,
    threadId: row.thread_id,
    taskVersion: row.task_version,
    status: row.status,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    turnId: row.turn_id,
    retryOfRequestId: row.retry_of_request_id,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
```

Change `attachTaskActivity(task, comments, activities, previewImage)` to accept a fifth `resumeRequest = null` parameter and assign `task.resumeRequest = resumeRequest` before generating `activityKey`. Include `[resumeRequest?.id, resumeRequest?.status, resumeRequest?.updatedAt]` in `activityKey` so existing SSE refresh logic detects queue changes.

- [ ] **Step 2: Detect first creation, then create the local table and indexes in `#migrate()`**

Before the migration SQL block, query `sqlite_master` for `task_resume_requests` and retain a `resumeRequestsTableExisted` boolean. Insert the approved `task_resume_requests` SQL from the design after `task_activities` and before attachments. Keep the exact statuses:

```sql
'pending', 'dispatching', 'dispatched', 'acknowledged', 'failed', 'canceled'
```

Create the partial unique index over `task_id` for `pending`, `dispatching`, and `dispatched`, plus the due index over `status`, `next_attempt_at`, and `created_at`.

- [ ] **Step 3: Backfill existing bound local todos once per open request**

Add `#backfillTaskResumeRequests()` and call it after table creation and task-column migrations only when `resumeRequestsTableExisted === false`:

```js
#backfillTaskResumeRequests() {
  const candidates = this.database.prepare(`
    SELECT id, project_id, thread_id, version
    FROM tasks
    WHERE status = 'todo' AND archived_at IS NULL AND thread_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM task_resume_requests
        WHERE task_id = tasks.id
          AND status IN ('pending', 'dispatching', 'dispatched')
      )
  `).all();
  const timestamp = now();
  const insert = this.database.prepare(`
    INSERT INTO task_resume_requests (
      id, task_id, project_id, thread_id, task_version, status,
      attempt_count, next_attempt_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
  `);
  for (const task of candidates) {
    insert.run(randomUUID(), task.id, task.project_id, task.thread_id, task.version, timestamp, timestamp, timestamp);
  }
}
```

Do not run this backfill on later startups. In particular, a `failed` request must remain failed across restart until the user invokes retry.

- [ ] **Step 4: Add transactional creation, acknowledgement, and cancellation helpers**

Implement private helpers with these signatures:

```js
#createResumeRequestForTodo(current, nextVersion, threadId, timestamp)
#settleResumeRequestsForTask(current, nextProjectId, nextStatus, nextThreadId, actor, timestamp)
```

Rules encoded in those helpers:

```text
non-todo -> todo + threadId + no open request => insert pending
todo -> in_progress + Codex Agent actor + matching open-request threadId => acknowledged
todo -> any other non-todo => canceled
open request + changed projectId, changed threadId, or archive => canceled
```

Treat `pending`, `dispatching`, and `dispatched` as open for acknowledgement. This deliberately closes the race where `turn/start` returns and the original thread claims the task before the host’s `/dispatched` callback commits. A user drag to `in_progress` cancels rather than acknowledges.

Compute the actual resulting project, status, thread ID, and `version + 1`; do not copy a caller field that the current update path ignores. Call the helpers inside the existing `BEGIN IMMEDIATE` blocks in both `updateTask()` and `moveTask()`, after the task row update succeeds and before `COMMIT`. In `archiveTask()`, cancel every open request for the task inside its existing transaction before `COMMIT`.

- [ ] **Step 5: Add lease-safe public queue mutations**

Implement the public methods listed in this task’s interface. Every leased mutation must include:

```sql
WHERE id = ? AND lease_token = ? AND lease_expires_at > ?
```

`claimTaskResumeRequest()` must use `BEGIN IMMEDIATE`, choose only supplied project IDs, and return:

```js
{
  operation: request.status === "dispatched" ? "observe" : "deliver",
  request: taskResumeRequestFromRow(claimed),
  task: this.getTask(claimed.task_id),
  leaseToken,
}
```

For `observe`, keep status `dispatched`; for `deliver`, set `dispatching`. Expired `dispatching` requests are deliverable again. The fourth transient failure becomes `failed`; delays for the first three failures are supplied by the caller.

- [ ] **Step 6: Attach the latest request without an N+1 query**

Add `#resumeRequestsForTasks(taskIds)` using one SQL query and a per-task first-row map ordered by `created_at DESC, rowid DESC`. Pass the mapped request to every `attachTaskActivity()` call in `listTasks()` and `getTask()`.

- [ ] **Step 7: Perform syntax and diff checks**

Run:

```bash
node --check server/database.mjs
git diff --check
```

Expected: both exit 0.

- [ ] **Step 8: Commit the persistence slice**

Run:

```bash
git add server/database.mjs
git commit -m "feat: persist task resume requests"
```

---

### Task 3: Expose the local resume queue API

**Files:**
- Modify: `server/app.mjs:504-690`
- Modify: `server/app.mjs:1810-2100`
- Modify: `server/app.mjs:2580-2720`

**Interfaces:**
- Consumes: Task 2 database methods and existing `EventHub`.
- Produces:
  - `POST /api/local/task-resume-requests/claim`
  - `POST /api/local/task-resume-requests/:id/defer`
  - `POST /api/local/task-resume-requests/:id/dispatched`
  - `POST /api/local/task-resume-requests/:id/failed`
  - `POST /api/local/task-resume-requests/:id/canceled`
  - `GET /api/local/task-resume-requests/open-thread-ids`
  - `POST /api/tasks/:taskId/resume/retry` (matched before cloud forwarding so Cloud receives the explicit local-only error)

- [ ] **Step 1: Add strict request parsers**

Add parsers that use `assertPlainObject`, `assertAllowedKeys`, `stringField`, and integer bounds already used in this file:

```js
parseResumeClaim(body)       // projectIds: 1..100 unique ids; leaseSeconds: 5..60
parseResumeDefer(body)       // leaseToken; delaySeconds: 1..300; reason <= 1000
parseResumeDispatched(body)  // leaseToken; turnId <= 256
parseResumeFailed(body)      // leaseToken; error <= 2000; retryAfterSeconds: 1..300; permanent boolean
parseResumeCanceled(body)    // leaseToken; reason <= 1000
parseResumeRetry(body)       // requestId <= 256
```

Reject unknown keys and repeated query parameters. Do not accept a caller-supplied thread ID on any queue mutation.

- [ ] **Step 2: Add one explicit local-mode guard**

Create:

```js
async function assertTaskResumeLocalMode() {
  const config = await cloudConfig.read();
  if (config.remoteUrl) {
    throw new ApiError(409, "TASK_RESUME_LOCAL_MODE_REQUIRED", "原会话自动续跑仅支持本地任务数据模式");
  }
}
```

Call it before every resume route, including the public task retry route. Keep the internal endpoints under `/api/local/` so the cloud proxy never forwards them.

- [ ] **Step 3: Wire internal worker routes before generic cloud forwarding**

For every successful queue mutation, re-read `database.getTask(request.taskId)`, emit:

```js
events.emit("task.updated", { task });
```

and return the updated request/task JSON. A stale lease returns HTTP 409 with code `RESUME_LEASE_CONFLICT`; a missing request returns 404 `RESUME_REQUEST_NOT_FOUND`.

- [ ] **Step 4: Match retry before generic cloud forwarding**

Match:

```js
const taskResumeRetryRoute = pathname.match(/^\/api\/tasks\/([^/]+)\/resume\/retry$/);
```

Decode the task ID with the same bounded validation as other task routes. Call `database.retryTaskResumeRequest(taskId, requestId)`, emit `task.updated`, and return `{ task, resumeRequest }`.

Place this match before the block that forwards non-companion `/api/*` routes to Cloud. Read the current cloud config there and return `TASK_RESUME_LOCAL_MODE_REQUIRED` when `remoteUrl` is present. This prevents the local-only route from being silently proxied to a Cloud server that does not implement it.

- [ ] **Step 5: Add the cleanup reference endpoint**

`GET /api/local/task-resume-requests/open-thread-ids` accepts no body or query and returns:

```json
{ "threadIds": ["thread-a", "thread-b"] }
```

The values come only from `pending`, `dispatching`, and `dispatched` requests.

- [ ] **Step 6: Verify the local HTTP contract with a disposable data directory**

Run the server in a dedicated terminal:

```bash
TASKBOARD_VERIFY_DIR=$(mktemp -d /tmp/taskboard-resume-api.XXXXXX)
CODEX_TASKBOARD_DATA_DIR="$TASKBOARD_VERIFY_DIR" \
CODEX_TASKBOARD_HOST=127.0.0.1 \
CODEX_TASKBOARD_PORT=3948 \
npm run start
```

From another terminal, run these exact commands:

```bash
curl -fsS -X POST http://127.0.0.1:3948/api/projects \
  -H 'content-type: application/json' \
  -d '{"id":"resume-verify","name":"Resume Verify","workspacePath":"/tmp"}'

VERIFY_TASK=$(curl -fsS -X POST http://127.0.0.1:3948/api/tasks \
  -H 'content-type: application/json' \
  -d '{"projectId":"resume-verify","title":"Resume API verification","status":"in_progress","threadId":"thread-original"}')
VERIFY_TASK_ID=$(printf '%s' "$VERIFY_TASK" | jq -r '.task.id')
VERIFY_TASK_VERSION=$(printf '%s' "$VERIFY_TASK" | jq -r '.task.version')

VERIFY_TASK=$(curl -fsS -X PATCH "http://127.0.0.1:3948/api/tasks/$VERIFY_TASK_ID" \
  -H 'content-type: application/json' \
  -d "{\"version\":$VERIFY_TASK_VERSION,\"status\":\"in_review\"}")
VERIFY_TASK_VERSION=$(printf '%s' "$VERIFY_TASK" | jq -r '.task.version')

curl -fsS -X PATCH "http://127.0.0.1:3948/api/tasks/$VERIFY_TASK_ID" \
  -H 'content-type: application/json' \
  -d "{\"version\":$VERIFY_TASK_VERSION,\"status\":\"todo\"}" | jq

curl -fsS -X POST http://127.0.0.1:3948/api/local/task-resume-requests/claim \
  -H 'content-type: application/json' \
  -d '{"projectIds":["resume-verify"],"leaseSeconds":30}' | jq
```

Expected: the final response contains `operation: "deliver"`, `request.threadId: "thread-original"`, and a non-empty lease token. Stop the disposable server after the check; do not modify the real Taskboard database.

- [ ] **Step 7: Perform syntax and diff checks**

Run:

```bash
node --check server/app.mjs
git diff --check
```

- [ ] **Step 8: Commit the API slice**

Run:

```bash
git add server/app.mjs
git commit -m "feat: expose local task resume queue"
```

---

### Task 4: Deliver and observe resume turns in the resident host

**Files:**
- Modify: `scripts/codex-injector.mjs:70-105`
- Modify: `scripts/codex-injector.mjs:1003-1088`
- Modify: `scripts/codex-injector.mjs:1198-1355`
- Modify: `scripts/codex-injector.mjs:1532-1637`

**Interfaces:**
- Consumes: Task 3 endpoints, `requestCodexAppServerViaCdp()`, `quotaPolicyRecords`, live CDP connections.
- Produces:
  - `buildTaskResumePrompt(task, request)`
  - `requestTaskboardJson(pathname, options)`
  - `deliverTaskResumeRequest(cdp, claim)`
  - `observeTaskResumeTurn(cdp, claim)`
  - `runTaskResumeWorkerPass(cdp)`
  - `scheduleTaskResumeWorker(cdp, delayMs)`

- [ ] **Step 1: Add bounded local API access**

Implement `requestTaskboardJson()` using `taskboardBaseUrl`, JSON content type, and `AbortSignal.timeout(5_000)`. On a non-2xx response, throw an error that includes the Taskboard error code and message but never logs the instance token.

- [ ] **Step 2: Build the stable original-thread instruction**

Return this exact semantic content, interpolating identifiers and request ID:

```text
e-taskboard 任务 {identifier} 已被用户退回待办。请读取最新议题和全部评论；仅当任务仍为 todo 且绑定当前会话时，使用最新 version 认领为 in_progress，然后按最新评论继续处理。续跑请求：{requestId}。
```

Do not include a copied comment body, model override, reasoning override, cwd override, or new thread title.

- [ ] **Step 3: Implement thread recovery without interruption**

Delivery must call App Server methods in this order:

```js
await requestCodexAppServerViaCdp(cdp, undefined, "thread/read", {
  threadId: request.threadId,
  includeTurns: false,
});
```

Read status and capability from `result.thread.status.type` and `result.thread.canAcceptDirectInput`, matching the existing `thread/read` result wrapper. If read fails, attempt `thread/unarchive` once and read again. For `notLoaded` or `canAcceptDirectInput !== true`, call:

```js
await requestCodexAppServerViaCdp(cdp, undefined, "thread/resume", {
  threadId: request.threadId,
  excludeTurns: true,
});
```

Re-read the thread once after `thread/resume` and make all later status/capability decisions from that fresh `result.thread`. If it still cannot accept direct input and is not merely `active`, record the approved permanent failure.

When status is `active`, call the Taskboard defer endpoint with two seconds and do not call `turn/interrupt` or `turn/steer`.

- [ ] **Step 4: Start exactly one idempotent turn**

For an idle direct-input thread, call:

```js
const result = await requestCodexAppServerViaCdp(cdp, undefined, "turn/start", {
  threadId: request.threadId,
  clientUserMessageId: request.id,
  input: [{ type: "text", text: buildTaskResumePrompt(task, request), text_elements: [] }],
});
```

Require `result.turn.id`. Record it through the dispatched endpoint. Automatic retries after a lost response reuse `request.id`.

If the dispatched callback receives `RESUME_LEASE_CONFLICT`, re-read the task once. Treat the conflict as benign only when the task is already `in_progress`, still has the exact request thread ID, and its latest request is `acknowledged`; this is the allowed fast-claim race. Otherwise propagate the conflict as a delivery failure.

- [ ] **Step 5: Observe dispatched turns durably**

For `operation: "observe"`, call:

```js
const result = await requestCodexAppServerViaCdp(cdp, undefined, "thread/turns/list", {
  threadId: request.threadId,
  limit: 20,
  sortDirection: "desc",
  itemsView: "summary",
});
```

Find `request.turnId` in `result.data`:

- `inProgress`: defer observation for two seconds;
- `completed`, `interrupted`, or `failed` while task remains `todo`: mark the request permanently failed with `Original thread did not claim the task` plus the turn status;
- task already `in_progress` under the matching thread: no worker mutation is needed because the database transaction has acknowledged it;
- task status, project, or thread binding changed: cancel the request.

- [ ] **Step 6: Map failures to the approved retry schedule**

Use delay values by existing `attemptCount`:

```js
const taskResumeRetryDelays = [1, 5, 30];
```

Transport/App Server `systemError` failures are transient. Index the delays by the current `attemptCount`: failures zero through two schedule 1, 5, and 30 seconds; the fourth transient failure is permanent. Missing thread after one unarchive/read attempt, invalid direct-input capability after resume, and an ended unclaimed turn are permanent. Active status is a defer, not a failure.

- [ ] **Step 7: Schedule one worker loop per current live CDP**

Use module-level state to prevent overlapping passes:

```js
let taskResumeWorkerTimer = null;
let taskResumeWorkerRunning = false;
```

Derive enabled local project IDs from `quotaPolicyRecords` where `request.enabledByUser === true`. If there are no enabled projects, do not claim. Schedule the next pass after two seconds when work or policies exist and after ten seconds when no request is due. Use `.unref()` so the timer cannot keep the injector process alive by itself.

At the start of each pass, read `/api/meta`; if it reports `mode: "cloud"`, do not claim, observe, reconcile local claimability, or run local cleanup. Start scheduling after `restoreQuotaPolicies(cdp)` completes in host binding installation. When a CDP closes, use the latest non-closed CDP from the existing policy set.

- [ ] **Step 8: Verify syntax and forbidden operations**

Run:

```bash
node --check scripts/codex-injector.mjs
rg -n "turn/interrupt|turn/steer|thread/start" scripts/codex-injector.mjs
git diff --check
```

Expected: the new worker contains no interrupt, steer, or thread creation call.

- [ ] **Step 9: Commit the worker slice**

Run:

```bash
git add scripts/codex-injector.mjs
git commit -m "feat: resume returned tasks in original threads"
```

---

### Task 5: Move local automation activation into the host and remove local model handoff

**Files:**
- Modify: `shared/taskboard-automation.mjs:61-77`
- Modify: `shared/taskboard-automation.mjs:107-126`
- Modify: `scripts/codex-injector.mjs:1090-1328`
- Modify: `skills/manage-taskboard/SKILL.md:15-35`

**Interfaces:**
- Consumes: Existing automation policy records and local `/api/tasks?projectId=...&status=todo&archived=false` data.
- Produces: `taskboardAutomationPolicyOperation(..., { taskboardMode, hasClaimableTodo })`, a local prompt with no cross-thread or self-management tool calls, and unchanged Cloud prompt behavior.

- [ ] **Step 1: Split prompt selection at the local/Cloud boundary**

Extract the current prompt unchanged as `buildLegacyTaskboardAutomationPrompt()`. In `buildTaskboardAutomationPrompt(request)`, return the legacy prompt when `request.taskboardMode === "cloud"`; otherwise build the new local prompt that:

- retain dependency, comment, version, branch/worktree, result-comment, and `in_review` rules;
- select only `todo` issues where `threadId` is absent;
- state that bound todos are owned by the local resume worker;
- end when no dependency-ready unbound todo exists;
- remove all text containing `send_message_to_thread` or `automation_update`.

Do not persist `taskboardMode` in the policy record. It is current machine state resolved from `/api/meta` before each reconciliation.

- [ ] **Step 2: Make actual status depend on claimable work without changing user intent**

Extend the policy operation input:

```js
export function taskboardAutomationPolicyOperation(request, {
  explicit,
  previousQuotaState,
  quotaState,
  currentStatus,
  taskboardMode,
  hasClaimableTodo,
})
```

Decision order:

```text
enabledByUser false => pause
quota-aware and quota unavailable => pause
Cloud mode => preserve the existing decision path
local mode + hasClaimableTodo false => pause
local mode + claimable work => ensure-active
```

Do not infer `enabledByUser = false` from an actual `PAUSED` automation. Remove the branch in `enqueueQuotaPolicyMutation()` that rewrites the stored user preference when a listed item is paused.

- [ ] **Step 3: Resolve current mode and calculate claimability only locally**

Add a helper in the injector:

```js
function isClaimableUnboundTodo(task) {
  return task.status === "todo"
    && !task.archivedAt
    && !task.threadId
    && task.relations.blockedBy.every((dependency) => dependency.status === "done");
}
```

Before applying a stored policy, fetch `/api/meta` and derive `taskboardMode` as `metadata.mode === "cloud" ? "cloud" : "local"`. In local mode, fetch the project’s unarchived todos and pass `hasClaimableTodo` into `applyTaskboardAutomationPolicy()`. In Cloud mode, do not query local claimability and pass the mode through only for the current reconciliation. Reuse the worker’s bounded local API helper.

- [ ] **Step 4: Align the installed Skill source semantics**

Update `skills/manage-taskboard/SKILL.md` so:

- an unbound `todo` may be claimed by the current scheduled run;
- a bound `todo` must remain for its original thread and local resume worker;
- an `in_progress` task remains claimable only by its bound current conversation;
- comments and current version must still be read before claiming.

- [ ] **Step 5: Verify generated text and source exclusions**

Run:

```bash
node -e 'import("./shared/taskboard-automation.mjs").then(({buildTaskboardAutomationPrompt}) => { const base = {taskboardProjectId:"local",codexProjectId:"p",projectName:"Local",workspacePath:"/tmp/local",skillPath:"/tmp/SKILL.md",intervalMinutes:5,model:"gpt-5.5",reasoningEffort:"high"}; const localPrompt = buildTaskboardAutomationPrompt({...base,taskboardMode:"local"}); const cloudPrompt = buildTaskboardAutomationPrompt({...base,taskboardMode:"cloud"}); console.log(localPrompt); if (/send_message_to_thread|automation_update/.test(localPrompt)) process.exit(1); if (!/send_message_to_thread|automation_update/.test(cloudPrompt)) process.exit(1); })'
git diff --check
```

Expected: exit 0; local prompt assigns bound todos to the local worker, while Cloud retains the existing handoff/self-pause text.

- [ ] **Step 6: Commit the policy slice**

Run:

```bash
git add shared/taskboard-automation.mjs scripts/codex-injector.mjs skills/manage-taskboard/SKILL.md
git commit -m "fix: keep task handoff control in the host"
```

---

### Task 6: Archive only unused local automation scan windows

**Files:**
- Modify: `scripts/codex-injector.mjs:1003-1088`
- Modify: `scripts/codex-injector.mjs:1198-1355`

**Interfaces:**
- Consumes: Codex `thread/list`, `thread/archive`, Taskboard task list with `archived=all`, and Task 3 open thread references.
- Produces: `cleanupUnusedTaskboardAutomationThreads(cdp)`.

- [ ] **Step 1: Build the protected thread set**

Read `/api/meta` first and return immediately in Cloud mode. In local mode, fetch `/api/tasks?archived=all` and `/api/local/task-resume-requests/open-thread-ids`. Add every non-empty `task.threadId` and every returned open-request thread ID to one `Set`.

- [ ] **Step 2: List only non-archived automation candidates**

For each configured automation name, call:

```js
await requestCodexAppServerViaCdp(cdp, undefined, "thread/list", {
  archived: false,
  searchTerm: buildTaskboardAutomationName(record.request),
  limit: 100,
  sortDirection: "desc",
  useStateDbOnly: true,
});
```

Filter again for exact `thread.name`, `thread.status.type === "idle"`, and age of at least 30 seconds.

- [ ] **Step 3: Archive only unprotected exact matches**

For each candidate absent from the protected set, call:

```js
await requestCodexAppServerViaCdp(cdp, undefined, "thread/archive", {
  threadId: thread.id,
});
```

Never archive an `active`, unnamed, differently named, task-referenced, or open-request thread.

- [ ] **Step 4: Schedule cleanup without a second scheduler abstraction**

Call cleanup from the existing resume/policy worker no more than once per minute. Store only a `lastTaskboardAutomationCleanupAt` timestamp; do not add another timer or package.

- [ ] **Step 5: Verify syntax and commit**

Run:

```bash
node --check scripts/codex-injector.mjs
git diff --check
git add scripts/codex-injector.mjs
git commit -m "feat: archive unused taskboard scans"
```

---

### Task 7: Show resume state and retry failures in the local UI

**Files:**
- Modify: `web/src/types.ts:214-257`
- Modify: `web/src/api.ts:473-505`
- Modify: `web/src/App.tsx:2195-2235`
- Modify: `web/src/App.tsx:3006-3032`
- Modify: `web/src/components/TaskCard.tsx:344-527`
- Modify: `web/src/components/TaskDetail.tsx:84-112`
- Modify: `web/src/components/TaskDetail.tsx:402-470`
- Modify: `web/src/styles.css`

**Interfaces:**
- Consumes: `task.resumeRequest` from Task 2 and `POST /api/tasks/:id/resume/retry` from Task 3.
- Produces: Typed status rendering and `retryTaskResume(task, requestId)`.

- [ ] **Step 1: Add the exact TypeScript contract**

Add:

```ts
export type TaskResumeRequestStatus =
  | "pending"
  | "dispatching"
  | "dispatched"
  | "acknowledged"
  | "failed"
  | "canceled";

export interface TaskResumeRequest {
  id: string;
  status: TaskResumeRequestStatus;
  attemptCount: number;
  nextAttemptAt: string;
  turnId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}
```

Add `resumeRequest?: TaskResumeRequest | null` to `Task` so Cloud responses and older local projections remain structurally valid. Keep `retryOfRequestId` internal to the server; it is not part of this UI projection.

- [ ] **Step 2: Add the retry API wrapper**

Implement:

```ts
export async function retryTaskResume(task: Task, requestId: string): Promise<Task> {
  const data = await request<{ task: Task }>(
    `/api/tasks/${encodeURIComponent(task.id)}/resume/retry`,
    { method: "POST", body: JSON.stringify({ requestId }) },
  );
  return data.task;
}
```

- [ ] **Step 3: Add one App-level retry mutation**

Implement `retryTaskResumeRequest(task)` next to `updateTaskProperties()`. Require `task.resumeRequest?.status === "failed"`, call the API wrapper, replace the returned task in state, and reuse existing `setActionError()` behavior on failure.

Pass this callback to `TaskDetail` as `onRetryResume`.

- [ ] **Step 4: Render a compact card status**

Add a small `TaskResumeStatus` component in `TaskCard.tsx`. Show it only when `task.resumeRequest` exists and task status is `todo` or `in_progress`.

Map states exactly:

```ts
pending: text("等待原会话空闲", "Waiting for original thread")
dispatching: text("正在唤醒原会话", "Resuming original thread")
dispatched: text("已发送，等待原会话认领", "Sent; waiting for original thread")
acknowledged: text("原会话已继续处理", "Original thread resumed")
failed: text("交接失败", "Resume failed")
canceled: text("交接已取消", "Resume canceled")
```

Do not add a card-level retry button; keep the action in task detail to avoid accidental retries.

- [ ] **Step 5: Render detail error and retry**

Extend `TaskDetailProps` with:

```ts
onRetryResume: (task: Task) => Promise<Task>;
```

Show the same state label near the existing conversation link. For `failed`, display `lastError` and a button labeled `重试原会话 / Retry original thread`. Disable the button while the request is in flight. On success, replace `currentTask` with the returned task.

Never display an action to create a new thread.

- [ ] **Step 6: Add minimal existing-style CSS**

Add only selectors used by the two new status elements:

```css
.task-resume-status
.task-resume-status.is-failed
.issue-resume-status
.issue-resume-error
.issue-resume-retry
```

Reuse existing colors, spacing variables, button styles, and icon components. Do not redesign the task card or comment composer.

- [ ] **Step 7: Verify the frontend contract**

Run:

```bash
npm run typecheck
npm run build:web
git diff --check
```

Expected: all exit 0.

- [ ] **Step 8: Commit the UI slice**

Run:

```bash
git add web/src/types.ts web/src/api.ts web/src/App.tsx \
  web/src/components/TaskCard.tsx web/src/components/TaskDetail.tsx web/src/styles.css
git commit -m "feat: show original-thread resume state"
```

---

### Task 8: Build and demonstrate the direct operation path

**Files:**
- Read: `docs/superpowers/specs/2026-08-14-task-original-thread-resume-design.md`
- Build output: `src-tauri/target/universal-apple-darwin/release/bundle/macos/Codex Taskboard.app`
- Do not replace: `/Applications/Codex Taskboard.app` before acceptance

**Interfaces:**
- Consumes: Tasks 2-7 and the user’s local Codex/Taskboard environment.
- Produces: A real same-thread resume demonstration and an acceptance report.

- [ ] **Step 1: Synchronize dependencies for the updated fork**

Run:

```bash
npm install
```

Expected: the lockfile remains unchanged. If it changes, stop and inspect why before continuing.

- [ ] **Step 2: Run proportional build verification**

Run:

```bash
node --check server/database.mjs
node --check server/app.mjs
node --check scripts/codex-injector.mjs
npm run typecheck
npm run build:web
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 3: Build the local macOS application**

Run:

```bash
npm run app:preflight
npm run app:build
```

Expected: the universal app exists at the build-output path. Do not overwrite the signed installed v1.0.3 app during this step.

- [ ] **Step 4: Launch the built app separately**

Run:

```bash
osascript -e 'tell application "Codex Taskboard" to quit'
open -n "src-tauri/target/universal-apple-darwin/release/bundle/macos/Codex Taskboard.app"
```

Wait for the installed process to exit before opening the built app so two Taskboard processes never share the local SQLite file or port. Use a dedicated local acceptance issue so production work is not altered.

- [ ] **Step 5: Demonstrate idle same-thread resume**

1. Let automatic claim process the dedicated issue to `in_review`.
2. Record its `threadId`.
3. Add a return comment and enable “Change status to Todo.”
4. Confirm a `pending` request appears.
5. Confirm the same recorded thread receives one new turn.
6. Confirm it reads the latest comments and moves the issue to `in_progress`.
7. Confirm the request becomes `acknowledged`.

Capture the task identifier, original thread ID, request ID, returned turn ID, and task versions in the handoff report.

- [ ] **Step 6: Demonstrate busy waiting without interruption**

Use the same dedicated issue on another return cycle. Start a bounded harmless turn in the original thread, return the issue while that turn is active, and confirm:

```text
request remains pending
attemptCount does not increase
active turn is not interrupted
no new thread appears
one resume turn starts after idle
```

- [ ] **Step 7: Demonstrate restart recovery and permanent failure**

1. Queue a request while the original thread is active.
2. Restart the built Taskboard app.
3. Confirm the expired lease is reclaimed and the same request continues.
4. In a separate disposable acceptance issue, use an invalid local thread binding and confirm `failed`, retained `todo`, exact error text, and no new thread.

- [ ] **Step 8: Demonstrate scan-window cleanup**

Allow one empty automation scan to finish. Confirm it is archived only after becoming idle and remaining unreferenced. Confirm the task-owned original thread remains visible and resumable.

- [ ] **Step 9: Report and wait for user acceptance**

Report:

```text
source commits
build commands and results
task identifier
original thread ID before and after
resume request and turn IDs
busy/restart/failure outcomes
window cleanup outcome
remaining risk, if any
```

Do not install over `/Applications/Codex Taskboard.app`, push, or add regression tests until the user confirms the demonstrated feature.

---

### Task 9: Acceptance and installation checkpoint

**Files:**
- No source changes unless the user reports a concrete failure.

**Interfaces:**
- Consumes: Task 8 report and explicit user acceptance.
- Produces: Authorization either to fix a reported main-path failure or to install the verified build.

- [ ] **Step 1: If the user reports a failure, return to the owning task**

Map failures directly:

```text
request not created => Task 2
API lease/state wrong => Task 3
wrong/new/interrupted thread => Task 4
scheduled window still sends/manages automation => Task 5
wrong window archived => Task 6
state or retry missing => Task 7
```

Make only the correction required by the observed failure, rebuild, and repeat Task 8.

- [ ] **Step 2: If the user accepts, install the verified local build**

First close the running Taskboard app. Preserve the official app as a recoverable copy, then copy the verified built app into `/Applications`:

```bash
osascript -e 'tell application "Codex Taskboard" to quit'
INSTALL_BACKUP_SUFFIX=$(date +%Y%m%d-%H%M%S)
mv "/Applications/Codex Taskboard.app" "/Applications/Codex Taskboard.app.backup-$INSTALL_BACKUP_SUFFIX"
ditto "src-tauri/target/universal-apple-darwin/release/bundle/macos/Codex Taskboard.app" \
  "/Applications/Codex Taskboard.app"
```

If `ditto` fails, move the preserved app back before reporting the failure. Record both paths in the final handoff. Do not publish a signed upstream release.

- [ ] **Step 3: Ask separately whether regression tests are desired**

The direct operation path has now been accepted. Task 10 may proceed only if the user explicitly requests the targeted protection described there.

---

### Task 10: Add targeted regression protection after explicit approval

**Gate:** Do not execute this task until the user has confirmed the feature works and explicitly asks for regression tests or protection.

**Files:**
- Modify: `test/server.test.mjs`
- Modify: `test/taskboard-automation.test.mjs`
- Modify: `test/injector.test.mjs`

**Interfaces:**
- Consumes: Accepted behavior from Tasks 2-8.
- Produces: Narrow regression coverage for the reported failure and approved recovery behavior.

- [ ] **Step 1: Add persistence/API cases to `test/server.test.mjs`**

Add named tests covering exactly:

```text
returning a bound issue to todo creates one pending resume request
comment-style PATCH and board-style move both create the request
an already-todo edit does not duplicate it
claim uses a lease and expired dispatching work is reclaimable
active defer does not increment attemptCount
matching Codex-Agent todo-to-in_progress acknowledges any open work, including the turn-start callback race
different thread cannot acknowledge it
user drag to in_progress cancels rather than acknowledges it
manual retry creates a successor ID after failed dispatched work
cloud-configured mode rejects local resume endpoints
```

Use the existing `startServer()` disposable directory helper and HTTP `request()` helper. Do not introduce a new fixture framework.

- [ ] **Step 2: Run the focused server tests**

Run:

```bash
node --test test/server.test.mjs
```

Expected: all server tests pass.

- [ ] **Step 3: Lock the generated prompt and policy contract**

Update `test/taskboard-automation.test.mjs` to assert:

```js
assert.doesNotMatch(localPrompt, /send_message_to_thread/);
assert.doesNotMatch(localPrompt, /automation_update/);
assert.match(localPrompt, /threadId/);
assert.match(localPrompt, /本地续跑/);
assert.match(cloudPrompt, /send_message_to_thread/);
assert.match(cloudPrompt, /automation_update/);
```

Add local policy cases for enabled + claimable → `ensure-active`, enabled + no claimable → `pause`, disabled → `pause`, and quota-blocked → `pause`. Add one Cloud case proving the pre-existing decision path is unchanged.

- [ ] **Step 4: Lock the host App Server methods and cleanup exclusions**

Update `test/injector.test.mjs` source-contract assertions for:

```text
thread/read
thread/unarchive
thread/resume
turn/start
clientUserMessageId
thread/turns/list
thread/archive
absence of turn/interrupt and turn/steer in the resume worker
protected task/open-request thread set before archive
```

- [ ] **Step 5: Run focused and full verification**

Run:

```bash
node --test test/server.test.mjs test/taskboard-automation.test.mjs test/injector.test.mjs
npm run check
```

Expected: all focused tests and the full repository check pass.

- [ ] **Step 6: Commit the accepted protection**

Run:

```bash
git add test/server.test.mjs test/taskboard-automation.test.mjs test/injector.test.mjs
git commit -m "test: protect original-thread task resume"
```

---

## Completion Criteria

The implementation is complete only when:

- the Task 8 direct path is demonstrated with one exact task and exact original thread ID;
- the original thread receives one turn after becoming idle;
- no local-mode scheduled run calls `send_message_to_thread` or `automation_update`, while Cloud still receives its legacy prompt;
- the task acknowledges only under the original thread;
- restart recovery and permanent failure are demonstrated;
- empty unbound scan windows archive while task-owned threads remain;
- the user explicitly accepts the behavior;
- the verified local build is installed only after that acceptance;
- Task 10 is either explicitly requested and passes, or is explicitly left out under the repository’s feature-ordering rule.
