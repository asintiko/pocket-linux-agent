# Mission: independent Linux desktops for concurrent Pocket chats

Implement this feature end to end in the existing Pocket repository. Do not stop at a design proposal. Inspect the repository, choose a small maintainable design, implement it, and prove it works with two simultaneous chats.

## Product goal

When a user creates a Pocket chat and selects a paired Linux computer, that chat must get its own graphical workspace on that computer. An agent can open a real graphical browser and terminal, take screenshots, click, type, manage windows, and run commands inside that workspace. Two chats must be able to do this at the same time without sharing focus, mouse/keyboard state, browser profiles, or clipboard contents. The human's physical desktop must remain usable and untouched.

These are independent graphical sessions, not ordinary KDE/GNOME virtual desktops, browser tabs, or a global lock that makes all agents take turns. Shared CPU, kernel, filesystem, and operating-system user are acceptable for this feature. Do not claim this provides an adversarial security sandbox. Project-file isolation is a separate concern; preserve existing project path restrictions.

## Starting points in this repository

There are parallel top-level and `lx/` workspaces. Inspect their entry points before editing. The currently deployed Mac Brain uses `lx/apps/brain/bin/pocket-claude.mjs`; the installed iOS app is built from top-level `apps/mobile/ios`. Make changes in the actual runtime path and update shared or mirrored consumers where necessary. Do not blindly copy one tree over the other.

Useful code:

- `lx/apps/brain/src/daemon.ts`: `pcHandle(sessionId)`, `pcForSession`, `executorForSession`, PC request routing.
- `lx/apps/brain/src/session.ts`: per-chat tools, `ComputerState`, remote executor handlers, cancellation and provider lifecycle.
- `lx/apps/brain/src/pc-tools.ts` and `computer-tools.ts`: clipboard, screenshots, computer actions.
- `lx/packages/protocol/src/messages.ts`: session metadata, capabilities, `computer.act`, `screen.capture`, clipboard messages, `tool.call`.
- `lx/apps/clipboard-agent/src/agent.ts` and `main.ts`: request dispatch, backend construction, service lifecycle.
- `lx/apps/clipboard-agent/src/linux/computer.py`, `computer.ts`, `clipboard.ts`: X11 operations and helpers.
- `lx/apps/clipboard-agent/scripts/install-linux.sh`: Linux dependencies and installation.
- `lx/apps/executor-extension/src/dispatch.ts`, `tools/run-command.ts`, `tools/background.ts`: command execution and background jobs.

Currently the Linux agent inherits the human session's display environment and uses a shared helper. Chat context is not carried through the existing PC-action and command messages. A per-chat `ComputerState` object alone does not isolate the actual desktop. Fix the full routing path, not only the screenshot helper. `ClipboardAgent` currently rejects `tool.call`: command execution belongs to a separate paired VS Code device. Ensure these channels share a validated logical workspace binding, or introduce a dedicated Linux workspace execution endpoint with the existing permission checks. Do not assume their device IDs are identical.

## Architecture requirements

Prefer a Linux workspace manager that owns an independent virtual X server and lightweight window manager per chat. Xvfb plus Openbox or another proven lightweight window manager is a reasonable baseline. Use an independent D-Bus session where desktop applications need it. Another implementation is acceptable if it demonstrably provides independent input/focus and works without changing the human's active desktop.

Use a stable workspace identity bound to authenticated account/person, paired Linux device, and Pocket session. The trusted application must resolve this mapping. Do not let model-supplied tool arguments choose arbitrary displays, auth files, ports, or someone else's workspace.

Each workspace needs its own display connection and Xauthority cookie, graphical helper instance, window state, clipboard, browser user-data directory, and relevant application state. Set `DISPLAY`, `XAUTHORITY`, session-bus variables, and appropriate XDG paths explicitly for children. Do not mutate process-wide environment per request, import workspace settings into the global systemd user environment, use `xhost +`, or disable the browser sandbox. Keep existing Pocket credentials available only to components that need them.

Start the X server without TCP listening. Allocate display numbers and other resources race-safely; do not assume `:1` is free. Wait for actual readiness before exposing the workspace. Track a workspace generation; reset screenshot geometry and reject stale actions when the desktop is recreated, rather than clicking using coordinates from its predecessor. A lightweight window manager and real browser must launch successfully on the virtual display, including when the human has a different desktop session.

All chat-owned graphical operations must target the same workspace: `computer`, `pc_screenshot`, `pc_clipboard_read/write`, window listing/focus, GUI processes launched by shell commands, and background jobs. Trace the separate clipboard-agent and VS Code executor paths; assigning only one of them an environment is insufficient. Choose and document how commands inherit the workspace environment on the Linux host. Preserve host-level phone clipboard/screenshot actions as explicitly host-scoped operations rather than silently redirecting them to an arbitrary chat.

Do not allow a missing, crashed, unavailable, or stale workspace to fall back to the physical desktop. Return an actionable error. Advertise capability support and handle older peers explicitly. Preserve macOS/Windows behavior, existing consent checks, ownership rules, and the current Claude/Kimi/Codex/MarketLLM integrations. Providers exposing computer tools must use the same routing.

## Lifecycle and user experience

Create the desktop lazily on first workspace use and reuse it for subsequent turns in the same chat. Tell the agent which workspace its tools address. Expose a minimal user-visible workspace status with a way to inspect that desktop through existing screenshot/preview UI, and a local Linux inspection mechanism if needed. Viewing should not switch the human's active display; prefer read-only inspection while an agent is driving it. Do not expose an unauthenticated VNC, X11, or browser-debugging endpoint. Streaming video is not required if a reliable preview is sufficient.

Stopping a turn must cancel that chat's pending work and release its held keys/buttons, while preserving the desktop for follow-up messages. Explicit workspace reset/deletion must clean up only owned resources. Define bounded idle cleanup, resource limits, browser-profile retention, daemon reconnect/restart behavior, crash recovery, and what happens when a chat changes computers. Track ownership by workspace/process group or another reliable mechanism; never kill all browser/X-server processes on the host or trust a stale PID blindly. Avoid one global execution queue across workspaces; serialization within a workspace is fine.

Extend the Linux installer to install/check the chosen dependencies and deploy any new helpers. Keep the existing physical desktop privacy blocker separate from agent desktops. Do not change the human's screen-lock, power, or login settings as part of this task.

## Subagents inside a session and visibility on the phone

The main agent must be able to create and coordinate real subagents within its Pocket session to delegate independent tasks. Reuse existing runtime delegation and task lifecycle support where available; implement the missing orchestration for the runtimes covered by this feature. Do not substitute decorative status messages for actual child-agent execution. Keep each child associated with its parent chat, parent agent/task ID, authenticated owner, and Linux workspace context. Subagents inherit the parent's permission boundary and project scope; delegation must not bypass tool consent or ownership checks.

Show subagent activity directly in the parent chat on the iPhone, not only in a separate global activity screen or server logs. Reuse the existing chat design and add an expandable task/card representation if needed. Show the subagent name or role, assigned task, current status (starting, running, completed, failed, or cancelled), concise progress/tool activity, and final result or error. Allow the user to expand a child task for available activity details. Display user-facing progress and results, not private model reasoning. Update these entries live and retain their final state in chat history. Reopening the chat or reconnecting must restore the current child tasks without duplicates or stale running indicators. A finished parent reply must not incorrectly mark still-running background subagents as completed.

Reuse the existing `Subagent`/activity protocol, `Session.subagents()`, SDK task events, and mobile activity rendering where possible. Extend durable chat events and client state as needed so child lifecycle is visible in the actual chat. Parent/child tool events must remain correctly attributed across concurrent tasks. Clearly distinguish background shell jobs from subagents.

Subagents that only read files or run independent commands may share the parent's project as appropriate. Two agents must not race for the same graphical focus or browser profile: if child agents need concurrent GUI work, allocate independently routed child desktops/profiles beneath the parent session using the same workspace manager. Sharing one desktop is acceptable only with explicit per-workspace serialization. Child desktops remain discoverable from the parent chat and follow the same preview, cancellation, ownership, and cleanup rules. Cancelling one child must leave siblings and unrelated chats running; stopping/deleting the parent must handle all descendants according to a clear policy.

## Required verification

Add focused automated tests for authenticated workspace routing, concurrent creation, command environment propagation, clipboard isolation, cancellation, cleanup ownership, and fail-closed behavior. Keep protocol producers and consumers in sync. Run relevant typechecks and existing tests; report pre-existing failures separately instead of disabling them. A known baseline is nine Linux blocker-layout tests expecting the absent `greeter_layout`; verify the current baseline before attributing failures.

Also run a real Linux demonstration with two Pocket sessions concurrently:

1. Start two independent desktops and two real browser instances with separate user-data directories. Use deterministic local test pages, with distinct visible identifiers and editable fields.
2. Interleave screenshots, mouse clicks, keyboard input, and clipboard operations through the actual Pocket tool route. Show each screenshot contains only its own workspace and each page receives only its intended text.
3. Launch GUI applications from each session's command path and prove they appear on the correct display. Verify workspace-specific background-job tracking and cancellation.
4. Confirm the human desktop's active window, pointer, clipboard, and existing browser remain unaffected. Use a controlled local test if touching the owner's live desktop would be disruptive.
5. Cancel/reset one workspace, simulate a helper failure, and confirm the other workspace still works. Test reconnect/restart and verify orphaned resources are handled according to the documented policy.
6. From a real parent session, spawn at least two subagents. Verify their actual execution, parent/child attribution, live progress, final results, and failure/cancellation states appear in the parent chat on the mobile client. Reconnect/reopen the chat during execution and after completion; verify no task disappears, duplicates, or stays falsely running. Demonstrate that cancelling one child leaves the other working. If both children drive browsers concurrently, demonstrate independent child desktops rather than conflicting focus.

If the cloud environment lacks X11/browser dependencies, provide an executable real-Linux acceptance script and clearly state which checks were not executed. Do not report mocked tests as a successful real desktop demonstration. Do not assume `ssh kali` exists in your environment or request private credentials in source files.

Deliver the implementation as reviewable changes with a concise architecture explanation, dependency/setup commands, exact verification commands and results, screenshots or other concrete evidence from both workspaces, and known limitations. Do not merge or deploy to the owner's live machines without explicit authorization.

## Primary technical references

- Xvfb: https://www.x.org/docs/man/man.pdf (Xvfb manual section).
- D-Bus session lifecycle: https://dbus.freedesktop.org/doc/dbus-run-session.1.html
- Chromium separate user-data directories: https://chromium.googlesource.com/chromium/src/+/master/docs/user_data_dir.md
