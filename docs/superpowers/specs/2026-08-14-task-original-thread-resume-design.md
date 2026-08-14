# Task Original-Thread Resume Design

**Date:** 2026-08-14  
**Status:** Approved design  
**Scope:** Local Taskboard mode only

## Summary

When a previously processed Taskboard issue is returned to `todo`, it must continue in its original Codex thread. The current automation delegates this with `send_message_to_thread` from inside a standalone scheduled run. That call can remain pending, so the issue stays in `todo`, the original thread receives nothing, and an extra automation window remains open.

The fix is a local, durable resume queue owned by Taskboard. The local database records a resume request in the same transaction that returns a bound issue to `todo`. A worker in the Taskboard host waits for the original Codex thread to become idle, resumes it if necessary, and calls the Codex App Server `turn/start` method with an idempotency key. The issue stays bound to the same thread throughout. No fallback thread is created.

## Confirmed Product Decisions

- The issue must continue in its original Codex thread; creating a replacement thread is not allowed.
- The feature is local-only. Cloud collaboration and multi-device routing are out of scope.
- If the original thread is active, Taskboard waits without interrupting it.
- A queued request survives Taskboard or Codex restarts.
- A missing or irrecoverable thread produces a visible failed handoff; the issue remains `todo`.
- Failure never creates a new thread automatically.
- The user can retry a failed handoff against the same original thread.
- Only unbound automation scan windows may be archived automatically. A thread referenced by an issue must be preserved.

## Existing Operation Path and Root Cause

### Comment return path

1. `web/src/components/TaskDetail.tsx::submitComment()` creates the comment.
2. When “Change status to Todo” is enabled, it calls `onUpdate(currentTask, { status: "todo" })`.
3. `web/src/App.tsx::updateTaskProperties()` calls `web/src/api.ts::updateTask()`.
4. `server/app.mjs` handles `PATCH /api/tasks/:id` and calls `TaskboardDatabase.updateTask()`.
5. `server/database.mjs::updateTask()` changes the status but preserves the existing `thread_id` when the request does not supply another one.

### Drag return path

1. `web/src/App.tsx::moveTask()` calls `web/src/api.ts::moveTask()`.
2. `server/app.mjs` handles `POST /api/tasks/:id/move`.
3. `server/database.mjs::moveTask()` uses `thread_id = COALESCE(?, thread_id)`, so returning the issue to `todo` retains the original thread.

### Current failed handoff

`shared/taskboard-automation.mjs::buildTaskboardAutomationPrompt()` instructs a scheduled run that sees a bound `todo` issue to avoid claiming it and call `send_message_to_thread`. That call runs inside the standalone scheduled task. Taskboard has no durable record, acknowledgement, retry owner, or visible error state for the handoff. If the tool call remains pending, the scheduled run is the only component that knows a handoff was attempted.

The same prompt also calls `automation_update` from the scheduled run. This mixes business work with Codex task-management control and has exhibited the same pending behavior.

## Goals

1. Resume a returned issue in exactly the thread stored in `task.threadId`.
2. Never interrupt an active turn.
3. Persist intent before attempting delivery.
4. Make delivery idempotent across retries and process restarts.
5. Expose pending, dispatched, acknowledged, canceled, and failed states in Taskboard.
6. Keep standalone automation responsible only for unbound new work.
7. Remove scheduled-run calls to `send_message_to_thread` and `automation_update`.
8. Archive empty, unbound automation scan windows without archiving task-owned threads.

## Non-goals

- Cloudflare/D1 resume queues.
- Cross-device routing of Codex thread IDs.
- Forking or replacing a missing thread.
- Interrupting or steering an active turn.
- A generic job queue framework.
- Changes to Codex itself.
- Automatically marking a failed handoff as `blocked`.

## Architecture

The design adds one local SQLite table, a small set of local internal HTTP endpoints, and one worker in the existing Codex injector process.

### Components

1. **Taskboard database** atomically creates and acknowledges resume requests.
2. **Local Taskboard API** leases work to the host and records delivery outcomes.
3. **Resume worker** uses the existing CDP-to-Codex-App-Server bridge.
4. **Automation policy reconciler** activates scheduled automation only for claimable unbound work.
5. **Taskboard UI** displays the latest resume state and allows retry after failure.

No cloud files or cloud migrations are changed.

## Persistent Data Model

Add `task_resume_requests` to the local SQLite migration in `server/database.mjs`.

```sql
CREATE TABLE IF NOT EXISTS task_resume_requests (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL,
  task_version INTEGER NOT NULL CHECK (task_version > 0),
  status TEXT NOT NULL CHECK (status IN (
    'pending',
    'dispatching',
    'dispatched',
    'acknowledged',
    'failed',
    'canceled'
  )),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT NOT NULL,
  lease_token TEXT,
  lease_expires_at TEXT,
  turn_id TEXT,
  retry_of_request_id TEXT REFERENCES task_resume_requests(id),
  last_error TEXT,
  dispatched_at TEXT,
  acknowledged_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS task_resume_requests_one_open
  ON task_resume_requests(task_id)
  WHERE status IN ('pending', 'dispatching', 'dispatched');

CREATE INDEX IF NOT EXISTS task_resume_requests_due
  ON task_resume_requests(status, next_attempt_at, created_at);
```

The request copies `project_id`, `thread_id`, and the post-transition task version. Later task mutations cannot silently redirect a queued request to another thread.

### Creation rule

Both `TaskboardDatabase.updateTask()` and `TaskboardDatabase.moveTask()` call one private helper inside their existing transaction when all of these are true:

- the previous status is not `todo`;
- the resulting status is `todo`;
- the resulting task has a non-empty `thread_id`;
- no open resume request exists for the task.

The helper inserts a `pending` request with a new UUID and `next_attempt_at` equal to the current time.

Changing fields on an issue already in `todo` does not create another request. A new `todo` issue without a thread remains eligible for the existing scheduled automation.

### Upgrade backfill

After creating the table, the local migration queries existing unarchived tasks with `status = 'todo'` and a non-null `thread_id`. It inserts one pending request per task when no open request exists. Delivery still requires the project’s user-enabled automatic-claim policy, so upgrading does not send anything for projects where automation is disabled.

### Acknowledgement rule

After a task successfully transitions from `todo` to `in_progress`, the same database transaction marks its latest `dispatched` request as `acknowledged` only when the write’s thread ID equals the request’s copied `thread_id`.

This rule is shared by `updateTask()` and `moveTask()`. A different thread cannot acknowledge another thread’s resume request.

Any mutation that moves the task out of `todo`, archives it, or replaces its thread binding cancels an open request in the same transaction, except for the matching `todo` to `in_progress` acknowledgement above. This prevents an unconsumed request from surviving after its task is no longer eligible.

## Local Internal API

All endpoints remain behind the existing loopback origin and instance token. They are unavailable in Cloud mode.

### Claim due work

`POST /api/local/task-resume-requests/claim`

```json
{
  "projectIds": ["fenlu-abp"],
  "leaseSeconds": 30
}
```

The server atomically selects either the oldest due `pending` delivery, a `dispatching` delivery with an expired lease, or a due `dispatched` request that needs turn observation. It returns `operation: "deliver"` or `operation: "observe"` with the request and current task. A delivery claim changes the request to `dispatching`; an observation claim keeps it `dispatched`. Both receive a new lease token. If no work is due, it returns `{ "request": null }`.

### Defer without failure

`POST /api/local/task-resume-requests/:id/defer`

```json
{
  "leaseToken": "opaque-token",
  "delaySeconds": 2,
  "reason": "Original thread is active"
}
```

For a delivery operation, this returns a busy thread to `pending` without incrementing `attempt_count`. For an observation operation, it keeps the request `dispatched` and schedules the next turn-status check.

### Record dispatch

`POST /api/local/task-resume-requests/:id/dispatched`

```json
{
  "leaseToken": "opaque-token",
  "turnId": "turn-id"
}
```

This changes `dispatching` to `dispatched`, clears the lease, and stores the Codex turn ID.

### Record transient or permanent failure

`POST /api/local/task-resume-requests/:id/failed`

```json
{
  "leaseToken": "opaque-token",
  "error": "Exact bounded error message",
  "retryAfterSeconds": 5,
  "permanent": false
}
```

A transient failure increments `attempt_count` and returns the request to `pending` when attempts remain. A permanent failure, or the third transient failure, changes it to `failed`.

### Record cancellation

`POST /api/local/task-resume-requests/:id/canceled`

```json
{
  "leaseToken": "opaque-token",
  "reason": "Task is no longer eligible for resume"
}
```

This changes the leased request to `canceled` when the worker discovers a task-state or binding change that occurred after the claim.

### Retry from the UI

`POST /api/tasks/:taskId/resume/retry`

```json
{
  "requestId": "resume-request-id"
}
```

Retry is allowed only when the request is `failed`, the task is still unarchived `todo`, and the task’s current thread ID still equals the request thread ID. It creates a new `pending` request with a new request ID and sets `retry_of_request_id` to the failed request. A new ID is necessary when the earlier request already produced a completed turn that did not claim the task. Automatic retries for an unconfirmed `turn/start` response continue using the original request ID.

### Task projection

The local task DTO gains an optional `resumeRequest` projection containing:

```ts
type TaskResumeRequest = {
  id: string;
  status: "pending" | "dispatching" | "dispatched" | "acknowledged" | "failed" | "canceled";
  attemptCount: number;
  nextAttemptAt: string;
  turnId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};
```

The projection includes the latest request of any state. Task cards show it only while the task is `todo` or `in_progress`; task detail may retain it as delivery history. Queue-state API writes emit `task.updated`, allowing the existing SSE refresh path to update the board.

## Resume Worker

Add a focused worker in `scripts/codex-injector.mjs`. It reuses `requestCodexAppServerViaCdp()` and the authenticated `taskboardBaseUrl`; it does not add a browser bridge action.

### Lifecycle

- The worker starts after the host binding and stored automation policies are restored.
- It derives eligible project IDs from policies where `enabledByUser` is true.
- It does not claim requests when no local project has user-enabled automatic claim.
- It polls only while at least one eligible project exists.
- A process restart leaves leases in SQLite; expired leases become claimable.

### Delivery state machine

For each leased delivery request:

1. Re-read the task from the claim response or local API.
2. Cancel the request when the task is archived, no longer `todo`, or no longer bound to the copied thread ID.
3. Call `thread/read` with `includeTurns: false`.
4. If the thread cannot be read, make one bounded `thread/unarchive` attempt and read it again.
5. If the thread status is `notLoaded` or direct input is unavailable, call `thread/resume` with `{ threadId, excludeTurns: true }`.
6. If the status is `active`, defer for two seconds without counting a failure.
7. If the status is `systemError`, treat it as a transient delivery failure.
8. If the thread is `idle` and accepts direct input, call `turn/start`.

The `turn/start` request is:

```json
{
  "threadId": "original-thread-id",
  "clientUserMessageId": "resume-request-id",
  "input": [
    {
      "type": "text",
      "text": "e-taskboard 任务 FENLUABP-7 已被用户退回待办。请读取最新议题和全部评论；仅当任务仍为 todo 且绑定当前会话时，使用最新 version 认领为 in_progress，然后按最新评论继续处理。续跑请求：resume-request-id。",
      "text_elements": []
    }
  ]
}
```

The message never copies comment bodies. The original thread must read the current issue and all comments through `taskctl`, avoiding stale prompt content.

### Delivery confirmation

When `turn/start` returns, the worker records the returned turn ID and marks the request `dispatched`. Dispatched requests remain durable observation work and are leased again after restarts. For an observation lease, the worker reads the recorded turn using the bounded thread-turn API:

- while the turn is running, wait;
- when the matching task becomes `in_progress` under the same thread, the database acknowledges the request;
- when the turn completes and the task is still `todo`, mark the request `failed` with “Original thread did not claim the task.”

The worker never sends a second turn for a request already marked `dispatched`.

### Retry policy

- Active thread: unlimited waiting, two-second defer, no attempt increment.
- Transient App Server or transport error: at most three delivery attempts with delays of 1, 5, and 30 seconds.
- Missing thread, irrecoverable resume failure, or invalid direct-input capability: permanent failure.
- Lost `turn/start` response: retry with the same `clientUserMessageId`; Codex idempotency prevents duplicate turns.

## Automation Policy Changes

### Prompt

Update `shared/taskboard-automation.mjs`:

- remove every instruction to call `send_message_to_thread`;
- remove every instruction to call `automation_update`;
- select only dependency-ready, unbound `todo` issues;
- never claim a `todo` that already has `threadId`;
- state that bound `todo` issues are handled by the local resume worker;
- end immediately when no unbound eligible issue exists.

Update `skills/manage-taskboard/SKILL.md` so the same ownership rule is clear to manually invoked agents.

### Host-owned activation

Keep `enabledByUser` as the user’s desired policy. A Codex automation being `PAUSED` must not change that desired value to false.

The existing host policy reconciler queries local tasks and controls actual automation status:

- `ACTIVE` when at least one unbound, dependency-ready `todo` exists in an enabled project;
- `PAUSED` when no such issue exists;
- bound resume requests do not activate scheduled automation;
- failed resume requests do not activate scheduled automation.

Reconciliation occurs after policy changes and on the worker’s bounded poll. Therefore the scheduled model never manages its own automation.

## Window Cleanup

The host periodically lists idle Codex threads whose exact title matches a configured Taskboard automation name.

It archives a candidate only when:

- the thread is idle;
- it is older than a short grace period;
- no active or archived local task stores that thread ID;
- no comment conversation reference requires it as the task’s current thread;
- it is not the target of an open resume request.

Threads referenced by tasks are never automatically archived. If the user manually archives a referenced original task thread, the resume worker unarchives it before calling `thread/resume` and `turn/start`.

## UI Design

Add a compact resume status to `TaskCard` and `TaskDetail`:

| Request state | Chinese label | Behavior |
| --- | --- | --- |
| `pending` | 等待原会话空闲 | No user action |
| `dispatching` | 正在唤醒原会话 | No user action |
| `dispatched` | 已发送，等待原会话认领 | No user action |
| `acknowledged` | 原会话已继续处理 | Informational |
| `failed` | 交接失败：{lastError} | Show “重试原会话” |
| `canceled` | 交接已取消 | Informational in detail activity only |

The retry control calls the local retry endpoint. It never offers “create a new thread.”

## Failure and Concurrency Rules

- Version checks on task writes remain authoritative.
- Queue creation and the transition to `todo` are atomic.
- Queue acknowledgement and the transition to `in_progress` are atomic.
- Lease tokens prevent a stale worker response from changing a request leased by a newer worker pass.
- A task leaving `todo` supersedes its open request.
- A changed thread binding supersedes its open request.
- Multiple comments while one request is pending do not create more requests; the resumed thread reads all current comments.
- A failed request remains visible until retried or superseded by a later status cycle. A manual retry creates a successor request with a new ID; transport retries within one delivery keep the same ID.
- The feature does not change the task to `blocked` or `in_progress` on its own.

## Local-only Boundary

The table, API endpoints, worker, and DTO projection exist only in the local server path. `cloud/src/index.mjs` and `cloud/migrations` are unchanged. When the Taskboard companion is configured for Cloud mode, the local resume worker is disabled and the UI does not claim local resume support.

## Direct Acceptance Path

Implementation is accepted only after this real product path is demonstrated:

1. Choose an `in_review` local issue that is bound to an original Codex thread.
2. Add a return comment and enable “Change status to Todo.”
3. Confirm the issue becomes `todo` and displays “Waiting for original thread.”
4. Keep the original thread active and confirm it is not interrupted and no new task thread is created.
5. Let the original thread become idle.
6. Confirm the same thread ID receives exactly one new turn.
7. Confirm that turn reads the latest issue and comments and claims the issue as `in_progress`.
8. Confirm the request becomes `acknowledged`.
9. Finish the returned work and move the issue to `in_review`; confirm all work remains in the original thread.
10. Repeat with Taskboard restarted while the request is pending; confirm delivery resumes.
11. Repeat with an invalid thread ID; confirm visible failure, retained `todo`, and no new thread.
12. Confirm an idle, unbound automation scan window is archived and the task-owned thread is retained.

Per the repository development rules, implementation first demonstrates this direct operation path. Targeted regression tests are added only after the user confirms the feature works or explicitly requests them.

## Expected File Scope

Core implementation is expected to touch:

- `server/database.mjs`
- `server/app.mjs`
- `scripts/codex-injector.mjs`
- `shared/taskboard-automation.mjs`
- `skills/manage-taskboard/SKILL.md`
- `web/src/types.ts`
- `web/src/api.ts`
- `web/src/App.tsx`
- `web/src/components/TaskCard.tsx`
- `web/src/components/TaskDetail.tsx`
- `web/src/styles.css`

No Cloudflare worker, D1 migration, Jira integration, AI chat subsystem, or Codex product file is changed.

## Rollout and Rollback

1. Build and install a local Taskboard App from the fork.
2. The local migration creates and backfills resume requests.
3. Delivery starts only for projects whose automatic-claim policy is enabled by the user.
4. Observe the direct acceptance path before enabling the build for broader use.

Rollback disables the resume worker and restores the previous automation policy. The added SQLite table may remain unused; it does not alter existing task, comment, attachment, or activity rows.
