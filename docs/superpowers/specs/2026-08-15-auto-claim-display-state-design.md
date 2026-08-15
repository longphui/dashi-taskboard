# Auto-claim display state design

## Goal

Make Taskboard distinguish the user's auto-claim preference from the Codex automation runtime status. An enabled project with no currently claimable task must look enabled and waiting, not disabled or paused.

## Confirmed operation path

1. `ProjectAutomationMenu` changes `enabledByUser`.
2. `App.tsx` sends the preference through the embedded host automation request and stores both `enabledByUser` and the returned Codex `ACTIVE` or `PAUSED` status.
3. For local Taskboard projects, `taskboardAutomationPolicyOperation` deliberately returns `pause` when there is no unbound dependency-ready todo.
4. `ProjectAutomationMenu` currently renders the trigger and heading primarily from `ACTIVE` or `PAUSED`, which makes an enabled waiting project appear disabled.

## Design

Derive one presentation-only state in `ProjectAutomationMenu` from the existing fields:

| Condition | Display state | Chinese label |
| --- | --- | --- |
| `enabledByUser` is false | disabled | 未启用 |
| quota-aware and quota is not available | quota-paused | 额度暂停 |
| Codex status is `ACTIVE` | running | 自动认领中 |
| Otherwise | waiting | 等待可认领任务 |

The outer trigger and menu heading use the same derived state, label, icon treatment, and visual class so they cannot disagree. The existing quota detail text remains available inside the menu.

## Scope

- Change only the frontend presentation component and the minimal CSS needed for the waiting state.
- Do not change the Codex automation policy, polling, task claim rules, original-thread resume worker, persistence format, or host protocol.
- Do not force the native Codex automation to stay active while there is no claimable task.

## Verification

- Run the existing frontend build or typecheck.
- Inspect the direct rendering path for all four input combinations.
- Ask the user to confirm the enabled-but-waiting state in the installed Taskboard UI before adding any regression protection.
