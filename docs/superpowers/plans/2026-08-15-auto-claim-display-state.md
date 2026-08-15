# Auto-claim Display State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the automation trigger and settings heading consistently show whether auto-claim is disabled, waiting for an eligible task, running, or paused by quota.

**Architecture:** Derive a presentation-only state inside `ProjectAutomationMenu` from the existing `enabledByUser`, quota, and Codex `ACTIVE`/`PAUSED` fields. Reuse that state for both render locations and leave the host protocol and scheduling policy unchanged.

**Tech Stack:** React, TypeScript, CSS, Vite

## Global Constraints

- Do not change the Codex automation policy, polling, task claim rules, original-thread resume worker, persistence format, or host protocol.
- Do not force the native Codex automation to stay active while there is no claimable task.
- Do not add regression tests before the user confirms the direct UI path works, per the repository development rules.

---

### Task 1: Derive and render the four display states

**Files:**
- Modify: `web/src/components/ProjectAutomationMenu.tsx:13-293`
- Modify: `web/src/styles.css:1215-1223,9131-9139`

**Interfaces:**
- Consumes: `AutomationState.enabledByUser`, `AutomationState.quotaAware`, `AutomationState.quota?.state`, and `AutomationState.status`.
- Produces: one local `AutomationDisplayState` value reused by the trigger and menu heading.

- [ ] **Step 1: Add the presentation state derivation**

Add the local type and derive the state in this priority order:

```tsx
type AutomationDisplayState = "disabled" | "waiting" | "running" | "quota-paused";

const displayState: AutomationDisplayState = !automation?.enabledByUser
  ? "disabled"
  : automation.quotaAware && (!quota || quota.state !== "available")
    ? "quota-paused"
    : status === "ACTIVE"
      ? "running"
      : "waiting";
const stateLabel = displayState === "disabled"
  ? text("未启用", "Disabled")
  : displayState === "quota-paused"
    ? text("额度暂停", "Paused by quota")
    : displayState === "running"
      ? text("自动认领中", "Auto-claiming")
      : text("等待可认领任务", "Waiting for eligible tasks");
const stateClass = displayState === "running"
  ? "is-active"
  : displayState === "waiting"
    ? "is-waiting"
    : "is-paused";
const autoClaimEnabled = displayState === "waiting" || displayState === "running";
```

- [ ] **Step 2: Use the derived state in both render locations**

Use `stateClass` and `stateLabel` for the menu heading. Use the same values for the outer trigger's class, accessible label, title, visible text, and icon. The icon must use `automationPause` while `autoClaimEnabled` is true and `automationPlay` otherwise.

```tsx
<span className={stateClass}>{stateLabel}</span>

className={`project-automation-trigger no-drag ${stateClass}`}
aria-label={stateLabel}
title={stateLabel}
<TaskboardIcon name={autoClaimEnabled ? "automationPause" : "automationPlay"} />
<span>{stateLabel}</span>
```

- [ ] **Step 3: Give the waiting state an enabled visual treatment**

Add `is-waiting` beside the existing active and paused rules. Use the existing accent tokens so waiting is visibly enabled but distinguishable from green running state.

```css
.project-automation-trigger.is-waiting,
.project-automation-menu .is-waiting {
  color: var(--accent);
}
```

In the later pill-style override, add:

```css
.project-automation-trigger.is-waiting {
  border-color: color-mix(in srgb, var(--accent) 14%, var(--border));
  background: var(--accent-soft);
  color: var(--accent);
}
```

- [ ] **Step 4: Verify the direct implementation path**

Run:

```bash
npm run typecheck
npm run build:web
git diff --check
```

Expected: all commands exit successfully. Then inspect the component to confirm all four branches produce the labels defined in the design and both render locations consume the same derived state.

- [ ] **Step 5: Commit the implementation**

```bash
git add web/src/components/ProjectAutomationMenu.tsx web/src/styles.css
git commit -m "fix: distinguish auto-claim display states"
```

After installation or refresh, ask the user to confirm that an enabled project with no unbound dependency-ready todo displays “等待可认领任务” while the switch remains on.
