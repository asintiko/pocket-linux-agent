# HANDOFF: independent Linux desktops for Pocket chats, and subagents visible on the phone

Status: **work in progress**. Nothing is merged or deployed. Read this file and
`LINUX-AGENT-WORKSPACE-PROMPT.md` (the full specification) before continuing.

## 0. Current state (2026-11-12, third session; read this first)

Section 0 is the newest part of this file and is right where an older section disagrees with it. Sections 1, 3
and 4 describe the design, section 6 is the record of the first two sessions.

### 0.0 Stopped here (2026-11-12, about 19:20 UTC), at the owner's request

The session was stopped in the middle of the open list. Everything is committed and pushed; the head is the commit
that carries this text. Where 0.1 to 0.6 below disagree with this subsection, this one is newer.

- **Hosted run of `11c9d45`** (the last one read): every job this work owns passes: both browser jobs, the
  subagent job, the helper smoke, and "The installer and its service" (27 of 27 at `1a8954d`, report read, which
  confirms finding 11 on real systemd; passed again at `11c9d45` with the stricter `workspaces shot` check, report
  not read). `check` and "Render the native Linux lock screen" are red for the two existing failures only.
- **`9aed0cd` was pushed last and has not been seen on the hosted runner.** Read its run first (`gh pr checks 1`).
- **Finding 14** (`9aed0cd`): programs opened through a helper that was since replaced were in no helper's list,
  so one that is no client of the X server outlived its desktop, also after a killed agent. The helper now writes
  down what it starts (`<run dir>/started`, pid and start time; `note_started` in `linux/computer.py`) and the
  manager ends those when the desktop closes and at its next start (`programsStarted`, `endOpened` in
  `linux/workspaces.ts`). `test/workspaces.test.ts` has 25 tests, all pass in the sandbox as `pocket`; the two
  real-desktop ones about this fail without the manager's part. Not run on that commit: the acceptance runs and
  the full suites. This closes 0.5 item 8 and item F of section 8.
- **The look at the mobile UI is unfinished.** The delegated agent was stopped before it wrote its report. It left
  thirteen pictures, `lx/artifacts/mobile-ui/07…` to `21…`, taken in the Expo web build against the `--serve`
  stack (real brain, relay, desktops and Claude Code process; scripted model). The main agent looked at four:
  - `07-background-question.png`, `08-after-answer-idle.png`: after `[[do:background]]` the reply ends ("done"),
    the background subagent's `run_command` question comes up, and after it is allowed the header reads "Active
    now", the composer has no stop button, and the subagent's card is still running. **The chat is idle after the
    answer**, which is what change 5 of the second session (`Session.setWaiting`) was for. Seen in this build with
    this model only.
  - `14-card-stopped.png`: an expanded card reading "Stopped · 2m 54s · 2 tool calls" with its task and its
    activity (one step done, one cut off); the sibling's result is in the chat.
  - `21-reload-while-running.png`: after a reload two running cards, once each, "Desktop running +2", the header
    "Waiting for approval" and two `run_command` questions.
  The other nine (`07b`, `07c`, `08b`, `09`, `10`, `11`, `12a`, `13a`, `16a`) were **not looked at by anyone who
  reported on them**. Not reached at all: a failed card, the confirmations of Stop, "Close desktop" and "Delete
  desktop data", closing and deleting for real, a subagent's desktop sheet, a reload after everything ended, the
  Activity screen, small screens.
- **Automatic fix runs are switched on for pull request #1** on the platform. `check` and the lock-screen job stay
  red until the owner decides about the two existing failures, so such runs keep being started for them.

Continue with, in this order: read the hosted run of the head commit; finish the mobile look (item B of section
8, starting from the pictures above) and fix what it finds in both copies of `apps/mobile`; item G (the two-chat
and subagent acceptance runs and the full suites in the sandbox on the head commit, evidence replaced); then what
needs credentials or the owner's machine (C, D, E) and the owner's decisions (H).

### 0.1 Where things are

- Repository https://github.com/karettelinaliinbel-cpu/pocket-linux-workspaces, branch `hoplite/rhegion-4c6b5acd`,
  made from `main` at `f642b0f`. Draft pull request **#1**. Nothing is merged or deployed.
- This is the Linux workstream only (a desktop per chat, subagents visible on the phone). The Windows installer is
  a separate task and was not touched.
- `main` here holds the unfinished implementation of the first two sessions (imported from
  `pareleneolnider-gif/pocket-linux-workspaces` at `9b8ef8d`, before that `zadenswigerkopuzu97-beep/…` at
  `348e0bb`); it is not the original baseline. Their pull requests and Actions runs were not transferred.
- The sandbox of this session: Ubuntu 24.04 (gVisor), 2 CPUs, Node 24.22.2, tests run as the ordinary user
  `pocket`; Chrome for Testing 157 and Firefox 160.0. It has no systemd and no Anthropic credentials. The hosted
  runner (`ubuntu-latest`: Ubuntu 24.04, systemd 255, Chrome 157, Firefox 159) is the only real Linux machine
  this work has run on.

### 0.2 Requirements: done, partial, missing

| Requirement (section 1) | State | Evidence |
| --- | --- | --- |
| A desktop per chat, two at once, nothing shared, the person's screen untouched | **Done**, on real X servers with real browsers, in the sandbox and on the hosted runner | `workspaces-acceptance.ts`, 86 checks, Chrome and Firefox |
| The application decides the desktop; no tool argument can | **Done** | brain tests, acceptance section 1 |
| Steps, screenshots, clipboard, windows, programs and jobs of a chat land in its desktop, on both device paths | **Done** with the real PocketClipboard process and the executor's own code; **not inside VS Code** | acceptance sections 2, 3 |
| Fail closed; older peers; existing consent kept | **Done** | acceptance section 6, brain tests |
| X without TCP, generations, lazy start, status, read-only preview, reset, delete, idle close, limits, recovery | **Done** | acceptance sections 1, 5, 6; `clipboard-agent/test/workspaces.test.ts` (25 tests) |
| Stop releases keys and buttons and keeps the desktop | **Done**, and since this session also when Stop comes in the middle of a computer step (0.3 finding 2) | new unit test, new acceptance check with both browsers |
| Browser profile kept across a reset | **Done**: Chrome and Firefox count all three visits, in the sandbox and on the hosted runner; Chrome also across `systemctl --user stop` | acceptance section 6; `service-acceptance.ts` section 5 |
| Linux installer and the installed command line | **Run on the hosted runner** for the first time: syntax, the installer itself, the systemd user service, `status`, `workspaces`, `shot`, `reset`, `delete`, `on`, `off`, `install`, `uninstall`. **Not run** on the owner's machine, inside a person's X11 session, or with the lock screen | CI job "The installer and its service"; `service-acceptance.ts` |
| Real subagents with live, durable cards | **Done with a real Claude Code process and a scripted model**; **never with a live model** | `subagents-acceptance.ts`, 27 checks |
| Mobile UI | Main states seen in the Expo web build by the second session; more states are in pictures from the third session and the look is unfinished (0.0). **iOS never built** | `lx/artifacts/mobile-ui/` |
| Real two-session demonstration, steps 1 to 6 | Steps 1 to 5 done by the acceptance script; step 6 done except for the model, which is scripted | 0.4 |
| User documentation | **Done** | `lx/README.md`, "A desktop of its own for every chat (Linux)" |
| Top-level `apps/brain` | Deliberately not ported (3.9), owner's decision | |

### 0.3 What this session found and changed

Each finding names how it was established. "Real desktop" means Xvfb, openbox, D-Bus, the Python helper and real
programs; nothing in this list rests on a mock.

1. **A program the chat opened with its computer tool was ended before it was asked to close.** Closing the input
   helper sends it SIGTERM, and on a chat's desktop the helper answers SIGTERM by ending every program it started
   (`end_started` in `linux/computer.py`). `WorkspaceManager.stop` closed the helper first and asked the windows
   to close afterwards. This is why Chrome lost its last visit across a reset (the old 0.4 item 1). Shown by a
   unit test on a real desktop that failed before the change; with the order turned round Chrome counts 3 visits.
2. **Stop in the middle of a computer step ended the chat's browser.** A step under way is stopped by replacing
   the helper, with SIGTERM again, so everything opened through `open` went with it although the desktop is kept
   for the next message. Shown by a unit test on a real desktop (the window list was empty after Stop) and by a
   new acceptance check with both real browsers. The helper of a desktop is now replaced with SIGUSR1.
3. **A program whose helper was replaced died at its next line of error output**: the helper held the reading
   end of its stderr pipe. Programs opened on a chat's desktop now write to `<desktop>/log/programs.log`. Shown by
   the same unit test with the helper holding the pipe again (it fails).
4. **Firefox never lost its profile on the hosted runner** (the old 0.4 item 2). After a restart Firefox loads a
   page it knows once more by itself, for the thumbnail it keeps of it, in a private copy that finds nothing
   stored and reports one visit; the acceptance check took whichever report came last. Shown outside the harness
   with the real `WorkspaceManager` and Firefox 160 (after the reset `visits=3`, one second later `visits=1`; with
   `browser.pagethumbnails.capturing_disabled` the second report is gone) and confirmed on the hosted runner,
   whose report notes the private copy. The check now reads the page the chat opened and demands all 3 visits.
5. **Once Firefox ends properly it asks on its next start whether it should be the default browser**, in a dialog
   over the page. A desktop's Firefox profile now gets a `user.js` that switches the question off, as Chromium
   already got `--no-default-browser-check`. Seen in a screenshot of the acceptance run, gone after the change.
6. **The acceptance check "page B received exactly what chat B typed" could fail although the text arrived**:
   the page's reports are separate requests and two changed places (the screenshot of that run shows the whole
   text). Page reports now carry the page's own count and are kept in that order.
7. **A display number was lost for good once its X server had been killed**: the socket file it left in
   `/tmp/.X11-unix` was taken for a display (the old 0.4 item 6). A number is now passed over only when its lock
   names a live process or something answers on its socket. Unit test on a real desktop.
8. **The hosted helper smoke** ("the screenshot after it reports a small change"): the helper gives a step half a
   second to show its first effect; GTK sometimes drew the tick later on a hosted runner. The smoke now looks
   again for up to ten seconds and says how long the tick took. **Decision: the helper's timing was left as it
   is**; a longer grace period would slow every step that changes nothing.
9. **Stopping the systemd service signalled every process of every desktop at once**, the X servers included, so
   the agent could not close the desktops in order. The unit now has `KillMode=mixed`. Established on the hosted
   runner by `service-acceptance.ts`: with it, "its programs closed when asked (1 window, 348 ms)" and page A
   counts 5 of 5 visits after the service was started again; without it the agent logged "its windows could not
   be listed (xprop … unable to open display ':100')" and page A counted 5 where 7 was all.
10. **`PocketClipboard install` on a paired, running installation left it stopped** until the next login: it asked
    the agent to quit and then ran `systemctl --user enable --now`, which does nothing while systemd still counts
    the service as running. That is the update path (running the installer again). It now enables and restarts.
    Found and confirmed fixed on the hosted runner.
11. **A switch changed from the command line was lost when the service restarted**: `PocketClipboard workspaces
    off` printed that desktops were off and the restarted service still had them. The restart's SIGTERM ran the
    quitting agent's shutdown a second time, which saved its older copy of the state over the file. `computer
    on|off` is written the same way. The shutdown now runs once. Found on the hosted runner; **confirmed there at `1a8954d`: 27 of 27.**
12. **On a reset the brain stopped the chat's jobs before the desktop had closed in order**, so a browser started
    by one of the chat's shell commands was ended without being asked. For a reset the jobs are now stopped after
    the desktop answered; deleting still stops them at once. Brain test with scripted devices on a real relay.
13. The `wmctrl -l` that ended by a signal on a hosted runner (the old 0.4 item 4) **did not happen again** in
    this repository and its cause is unknown. `quitPrograms` and the harness read windows with `xprop` now, a list
    that cannot be read is logged with the reason and is no longer taken for an empty desktop (unit test with an
    `xprop` that ends by SIGSEGV).

Commits of this session, oldest first: `0b6c6fe` (1, 2, 3, 5, 13), `a8a28cb` (4, 6, new Stop check), `be8a394`,
`ddee5f3` (evidence), `d948a8e` (7, 8), `32f6d56` (9, service acceptance, CI job), `989cbec` (10), `34c869a` (12),
`2026ecf` (README), `c2bcab9` (sandbox setup), `1a8954d` (11), `11c9d45` (the service run's `shot` check must show the page), `9aed0cd` (14, in 0.0),
and handoff commits in between.

Files added: `lx/apps/clipboard-agent/scripts/service-acceptance.ts`; job `installed` in
`.github/workflows/desktops-linux.yml`; `lx/artifacts/workspaces-acceptance/firefox/`. Everything else changed in
place, all under `lx/apps/clipboard-agent` and `lx/apps/brain`. The mirrored packages (protocol, client-core,
executor-extension, mobile) were not touched and are equal in both trees except the five old lines of
`packages/protocol/src/messages.ts` (`diff -rq` at `1a8954d`).

### 0.4 What was run, and the results

Real in every run: X servers, window managers, session buses, input helpers, clipboards, browsers, the relay, the
brain, PocketClipboard as its own process, the executor's dispatcher and shell commands. Standing in everywhere:
the phone (a paired client that sends the phone's messages), the VS Code window around the executor code, the
person's screen (an X server started for the run). In the subagent run the Claude Code process, its Agent tool
and the subagents are real and **the model is scripted** (a local HTTP server that replays fixed tool calls).

Sandbox, as `pocket`:

| What | At | Result |
| --- | --- | --- |
| `clipboard-agent/test/workspaces.test.ts` | `d948a8e` | 23 passed (18 before this session; 5 new, 4 of them on real desktops) |
| The same file | `9aed0cd` | 25 passed (7 new in this session, 5 of them on real desktops) |
| The two new tests of findings 1 and 2 against the unchanged implementation | `f642b0f` + tests | Both failed, as described |
| `workspaces-acceptance.ts --browser firefox` | `be8a394` | 86 of 86 |
| `workspaces-acceptance.ts --browser google-chrome` | `be8a394` | 86 of 86 |
| `subagents-acceptance.ts` | `be8a394` | 27 of 27 |
| `pnpm --dir lx typecheck`, `pnpm typecheck` | `be8a394` | Pass |
| `pnpm --dir lx test` | `be8a394` | 651 passed, 9 failed (`blocker-layout`), 8 skipped |
| `pnpm test` (top-level) | `be8a394` | 551 passed, 6 skipped |
| `scripts/computer-smoke.py` under Xvfb and openbox | `d948a8e` | All passed, twice |
| `brain/test/{workspaces,subagents,permissions}.test.ts`, brain typecheck | `34c869a` | 42 passed; pass |
| `service-acceptance.ts` | | **Cannot run here**: the sandbox has no systemd |

Not rerun in the sandbox after `be8a394`: the two-chat and subagent acceptance runs and the full suites (the
later commits change the display-number check, the brain's reset order, the service unit and its commands). The
hosted runner ran them at every push.

Hosted runner, pull request #1:

| Job | At `989cbec`; for the runs after it see 0.0 |
| --- | --- |
| `CI` / `check` | Fails only at the nine `blocker-layout` tests (read in detail at `be8a394`: 656 passed, 9 failed, 3 skipped; later runs were read by their job result only) |
| `CI` / `windows-blocker` | Pass |
| Two chats, two desktops (firefox, 159.0) | **Pass, 86 of 86** (84 of 85 on `main`) |
| Two chats, two desktops (google-chrome, 157) | **Pass, 86 of 86** |
| Subagents of a chat (real Claude Code, scripted model) | Pass, 27 of 27 |
| Use real windows through the helper | Pass |
| The installer and its service (systemd, google-chrome) | **25 of 27**: everything up to and including the service stop, restart, delete and uninstall passed; the two that failed were the `workspaces off` checks, which is finding 11 |
| Render the native Linux lock screen | Fails (existing, owner's decision) |

The runs after `989cbec` are in 0.0: the installer job reached 27 of 27 at `1a8954d`.

On unchanged `main` (`f642b0f`, runs 43269987309, 43272289246, 43272295084) the hosted runner gave: `check` only
the nine `blocker-layout` failures, Chrome 85 of 85, Firefox 84 of 85, subagents 27 of 27, helper smoke pass. So
three of the four hosted differences of the second session's handoff (the reset test in `check`, the subagent
job, the helper smoke) did not happen again on one run each; they came and went with the runner. The fourth, the
Firefox check, was finding 4.

Evidence in the repository: `lx/artifacts/workspaces-acceptance/` holds the sandbox runs at `be8a394` (Chrome
report and pictures, `firefox/` with the Firefox report, the subagent report with its SDK messages).
`6a-chat-a-page-again.jpg` shows page A counting 3 visits after the reset. The hosted reports are artifacts of
the runs (`chat-desktops-<browser>-<run id>`, `chat-subagents-<run id>`, `installed-service-<run id>`, 14 days).

### 0.5 Known failures, open points, unverified behaviour

1. **Existing failures, untouched, owner's decision**: the nine `blocker-layout` tests (`module 'blocker' has no
   attribute 'greeter_layout'`) keep `check` red; the lock-screen smoke (`TypeError … 'method' and 'float'` in
   `blocker-smoke.py`) keeps `Computer use (Linux)` red.
2. **Mobile UI**: the look is unfinished. What was seen, what was photographed and not looked at, and what was
   not reached is in 0.0.
3. **Never run with a live model.** No Anthropic credentials. `subagents-acceptance.ts --live` exists for it.
4. **Never run inside VS Code.** The extension's dispatcher, placement, shell and background-job code runs inside
   the acceptance scripts' process with real commands.
5. **The owner's own machine**: the installer has only run on a hosted runner without a graphical session. Not
   exercised: installing from inside a person's X11 session, the lock screen, `workspaces view` from the
   installed bundle on a real screen (the two-chat run executes `view` and `shot` from `src/main.ts`).
6. **iOS**: never built.
7. **Firefox from Mozilla's packages shows "Welcome to Firefox / Terms of Use"** over the first page of every new
   profile. The product does not answer it; the tests and the sandbox setup use the documented policy
   `SkipTermsOfUse`. Owner's decision what the agent is told about it. The README says how to skip it.
8. Closed at `9aed0cd` (finding 14 in 0.0): programs opened through a helper that was since replaced now end with
   their desktop.
9. **Firefox's private thumbnail copies** load a page a second time without the profile. The acceptance run
   accounts for it after a reset; if such a copy ever loads the person's page H, "the person's browser page
   received no … reload" would fail. Not seen.
10. **`PocketClipboard pair` restarts `pocket-clipboard.service`** on Linux when it succeeds. The acceptance runs
    pair a scratch agent that way; on a developer's machine with a real installation that restarts the real
    service once.
11. `KillMode=mixed` and the `install` fix reach an existing installation when the installer is run again (the
    unit is rewritten by `PocketClipboard install`).
12. The cause of `wmctrl -l` ending by a signal on a hosted runner is unknown (finding 13). `wmctrl -i -c`,
    `-i -a`, `-i -r` are still used to close, focus and maximize windows; a failure is logged or reported.
13. The two copies of `packages/protocol/src/messages.ts` differ in five lines that predate this work.
14. A program that does not close when asked holds a reset, an idle close and the service's stop up for 5 s
    (`quitMs`), then ends with the desktop; the unit allows 10 s.
15. Kimi, Codex and MarketLLM use the same tool handlers, so routing applies; nothing was run with those engines
    beyond the existing tests. History grows by whole cards per subagent (`historyFor` does not collapse them).

### 0.6 Status by area

| Area | Status |
| --- | --- |
| Real browsers | **Real.** Chrome (sandbox on) and Firefox, a profile per desktop, driven through the helper; both on the hosted runner |
| Two simultaneous desktops | **Real.** Two chats, two Xvfb servers with their own cookie, window manager, session bus, clipboard and browser, used interleaved, next to a stand-in for the person's screen that is compared before and after |
| Real Claude subagents | **Real Claude Code process**, real Agent tool, real subagents and task events. **The model is scripted.** |
| systemd service | **Real**, on the hosted runner only: installed by the installer, paired, started, stopped with a browser open, restarted, uninstalled |
| Mobile UI | Expo web build, real brain and relay, scripted model; see 0.5 item 2. Nothing on iOS |
| VS Code integration | The extension's code inside the acceptance scripts' process. **Never inside VS Code** |

## 1. Goal and acceptance criteria

The specification is `LINUX-AGENT-WORKSPACE-PROMPT.md`. In short:

1. Every Pocket chat that works on a paired Linux computer gets a graphical desktop of its own there (own X server,
   window manager, D-Bus session, Xauthority cookie, input/focus, clipboard, browser profile, XDG/application state).
   Two chats work at the same time without sharing anything; the person's physical desktop is never touched. No claim
   of an adversarial sandbox.
2. The binding chat → desktop is decided by the trusted application from account/person + paired Linux device +
   Pocket session. No tool argument may choose a display, a cookie, a port or another chat's desktop.
3. Computer steps, screenshots, clipboard, window listing/focus, GUI programs started from shell commands and
   background jobs of a chat all land in that chat's desktop, across both device paths (PocketClipboard agent and the
   VS Code executor, whose device ids differ). The phone's own clipboard/screenshot actions stay host-scoped.
4. Fail closed: a missing, stale, crashed or unavailable desktop is an actionable error, never a fallback to the
   physical display. Older peers are handled explicitly. Existing consent, ownership, platform behaviour and provider
   integrations (Claude/Kimi/Codex/MarketLLM) are preserved.
5. X without TCP, race-safe allocation, readiness checks, generations with stale-action rejection, lazy creation,
   status and read-only preview, cancellation with key/button release, reset/deletion, bounded idle cleanup, limits,
   profile retention, reconnect/crash recovery, ownership-tracked cleanup, no global execution queue.
6. Linux installer installs/checks dependencies and deploys new helpers. The physical-desktop privacy blocker stays
   separate; no change to login, lock or power settings.
7. Real subagents (runtime delegation) tied to parent chat/task, owner and workspace, inheriting permissions and
   project scope. Live, durable cards in the parent chat on the iPhone (role/name, task, status, concise activity,
   result/error), restored on reconnect/reopen without duplicates or stale indicators; a finished parent reply must
   not complete still-running children; subagents distinct from background jobs; concurrent GUI children get their
   own routed desktops; cancelling one child leaves siblings alone; defined parent cleanup policy.
8. Verification: focused automated tests; typechecks and existing tests (known baseline: nine Linux blocker-layout
   failures expecting the absent `greeter_layout`); a **real two-session Linux demonstration** (six numbered steps in
   the specification, including two real browsers and at least two real subagents from a real parent session); if the
   environment cannot do it, an executable acceptance script and a clear statement of what was not executed.
9. Delivery: reviewable changes, concise architecture explanation, setup commands, exact verification commands and
   results, screenshots/evidence from both workspaces, known limitations.

## 2. State at a glance

| Area | State |
| --- | --- |
| Protocol: bindings, error codes, `workspace.control/state`, `workspace.get/preview/reset`, `subagent.cancel`, tool `context`, `jobs.kill`, peer features, `subagent` events (both trees) | Implemented, unit-tested |
| Brain routing in `lx/apps/brain` (desktop identity, routing, command placement, legacy peers, status/preview/reset, cleanup) | Implemented; tested against a real relay with scripted devices, and in the acceptance runs with the real PocketClipboard process |
| Linux desktop manager in `lx/apps/clipboard-agent` (Xvfb, cookie, D-Bus, window manager, helper, clipboard, generations, limits, idle, retention, recovery, programs asked to close) | Implemented, tested on real X servers (25 tests) and in the acceptance runs |
| PocketClipboard request routing (`agent.ts`), local CLI, read-only viewer | Implemented; `status`, `workspaces`, `shot`, `view` executed by the two-chat run from `src/main.ts`; `status`, `workspaces`, `shot`, `reset`, `delete`, `on`, `off`, `install`, `uninstall` executed from the installed bundle on the hosted runner |
| VS Code executor: per-desktop command environment, per-chat background jobs, scoped kill (both trees) | Implemented, executed with real shell commands in the acceptance run; **never run inside VS Code** |
| Subagent tracking, attribution, child desktops, cancel, reconcile after restart | Implemented; executed with a real Claude Code process and a scripted model; **never with a live model** |
| client-core cards, workspace requests, reconnect reload (both trees) | Implemented, unit-tested |
| Mobile UI: subagent cards, desktop chip and sheet (both trees) | Implemented; states seen in the Expo web build, see 0.5 item 2; **iOS never built** |
| Linux installer `install-linux.sh` and the systemd service | Syntax-checked and executed on the hosted runner (job "The installer and its service"); **not on the owner's machine** |
| Acceptance scripts and CI workflow `Chat desktops (Linux)` | In the repository; see 0.4 for results |
| User-facing documentation | `lx/README.md`, "A desktop of its own for every chat (Linux)" |
| Top-level `apps/brain` | **Deliberately not ported** (see 3.9) |

## 3. Architecture and decisions

Two parallel pnpm workspaces exist: the top-level one and `lx/`. The deployed Mac Brain runs
`lx/apps/brain/bin/pocket-claude.mjs`; the iOS app is built from the top-level `apps/mobile` (the native `ios/` folder
is not in this checkout). Linux support for PocketClipboard exists only in `lx/apps/clipboard-agent/src/linux`.
`packages/protocol`, `packages/client-core`, `apps/executor-extension`, `apps/mobile`, `apps/telegram-bot` are kept
identical in both trees for everything this work touched (`diff -rq <dir> lx/<dir>`; the two `messages.ts` differ
only in three lines that already differed before).

### 3.1 Who decides which desktop

`lx/apps/brain/src/workspaces.ts`: `workspaceId({accountId, userId, deviceId, sessionId, child?})` =
`ws_` + base32 of the first 16 bytes of SHA-256 over the length-prefixed parts. `deviceId` is the PocketClipboard
device the chat's pc tools use (`pcForSession`), `child` is a subagent's task id. `jobScope({accountId, userId,
sessionId})` names a chat towards the executor (`job_` + 24 hex). `DesktopDirectory` keeps, in memory only, what the
brain last heard about each desktop. Tools and models never see or pass a name, a display or a path; the tool input
schemas have no such field and the wire schemas (`workspaceBindingSchema`) only accept `ws_[a-z2-7]{26}`.

### 3.2 Routing in the brain (`lx/apps/brain/src/daemon.ts`)

- `desktopMode(deviceId)`: `'desktop'` when the computer advertises `workspaces`; `'refuse'` for a Linux computer
  that advertises neither `workspaces` nor `host-desktop` (old or broken install: chats get an error, nothing is
  sent); `'own'` otherwise (Windows/macOS, or Linux whose owner switched desktops off).
- `pcHandle(sessionId, agent?)` builds every `computer.act`, `clipboard.read/write`, `screen.capture` of a chat with
  that chat's binding (`{id, label, parent?, generation?}`). `PcHandle.desktop` / `.blocked` tell the tools.
- Phone requests `clipboard.get/set` and `screen.get` are sent with `scope: 'host'` and no binding.
- `executorHandle(sessionId)` wraps `ExecutorBridge.handle`: `callForChat` adds `context: {scope, workspace?}` for
  executors with the `workspace-env` capability. Only `run_command` gets a desktop (`placeCommand`, which starts it
  with `workspace.control ensure` unless seen running within 20 s). A call refused with `[workspace_stale]` or
  `[workspace_unavailable]` is retried once after a fresh `ensure`. If no desktop can be had the command runs with
  no display and a note is appended. Linux executors without `workspace-env` get `unset DISPLAY XAUTHORITY …`
  prefixed to the command (`withoutDisplay`); other systems are untouched.
- The two devices of one Linux login are matched by `workspaceHost` (see 3.4) plus same person (`sameLogin`). Without
  a match commands get no desktop and the system prompt tells the agent to start programs with `open`.
- `workspace.get` / `workspace.preview` / `workspace.reset` / `subagent.cancel` are answered only for the asking
  person's own sessions (`mySession`). Preview uses `workspace.control capture` (does not start or touch a desktop).
- Cleanup: `closeDesktop` (subagent ended → its desktop is deleted, its jobs killed), `resetWorkspace` (phone),
  `releaseSession` (chat deleted / person removed → all desktops deleted, jobs killed), `dropStaleDesktops` (chat now
  uses another computer → desktop on the old one is closed, profile kept), `keepDesktopsAlive` (every 5 min for chats
  that are working, so an idle timer on the computer does not close a desktop in use).
- Feature negotiation: clients send `status.get {features}`; the brain stores them on the device
  (`PairedDevice.features` in `store.ts`) and reports its own in `host.status.features`. `subagent` events and
  history entries go only to clients/overlays that list `subagents` (`toClients`, `historyFor`).

### 3.3 The desktops (`lx/apps/clipboard-agent/src/linux/workspaces.ts`)

`WorkspaceManager` owns everything; files live in `~/.pocket-clipboard/workspaces/<id>/` (0700/0600):
`meta.json`, `live.json` (only while running), `Xauthority`, `bin/` (wrappers), `profiles/`, `home/{config,cache,data,state}`,
`log/`. Sockets live in `$XDG_RUNTIME_DIR/pocket-ws/<host>/<id>/` (or `/tmp/pocket-ws-<uid>/…`).

- Start (`launch`): `Xvfb :N -screen 0 1280x800x24 -dpi 96 -nolisten tcp -auth <cookie file> -noreset -displayfd 3`,
  N tried from 100 upward (the X server claims its number atomically; locks/sockets are only skipped as a shortcut).
  Ready when the server reports N on fd 3 **and** `xprop` works with the cookie **and fails without it** (a server
  that lets clients in without the cookie is stopped). Then `dbus-daemon --session --nofork` on a socket in the run
  dir, the wrappers, a window manager (openbox, else xfwm4/fluxbox/icewm/metacity; ready when
  `_NET_SUPPORTING_WM_CHECK` is set), and a `ComputerHost` (the existing `computer.py` helper) with the desktop's
  environment, plus an `xclip` clipboard bound to it. Every process is its own process group and, where `setpriv`
  exists, started with `--pdeathsig TERM`.
- `live.json` (`workspaceLiveSchema` in `packages/protocol/src/workspace-host.ts`) records id, generation, display,
  the X server's pid **and start time**, the other processes, and the environment for commands.
- Generations: +1 per start, saved to `meta.json` before anything starts; `retired.json` keeps the last generation
  of removed desktops so a re-created one continues counting. A request that carries `generation` is refused with
  `workspace_stale` unless that generation is running. The brain's `ComputerState.generation` is the generation of
  the latest screenshot and is sent with every later step (`computer-tools.ts`).
- Limits (env of the service): `POCKET_WORKSPACE_MAX` (6), `POCKET_WORKSPACE_IDLE_MINUTES` (30, close but keep
  files), `POCKET_WORKSPACE_EVICT_MINUTES` (2, an idle desktop gives way when all slots are taken, otherwise
  `workspace_limit`), `POCKET_WORKSPACE_RETAIN_DAYS` (14, then files are removed), `POCKET_WORKSPACE_SIZE`
  (1280x800), `POCKET_WORKSPACE_DISPLAY_BASE` (100), `POCKET_WORKSPACE_BROWSER`.
- Crash: X server or bus exits → desktop `failed`, `live.json` removed, old generations stale; the window manager
  is restarted in place up to 3 times a minute.
- `recover()` at start: desktops of an earlier run are **not adopted**. A leftover process is ended only if its pid
  has the recorded start time and carries `POCKET_WORKSPACE_ID=<id>` in `/proc/<pid>/environ`; everything else is
  left alone. Chats get fresh desktops (next generation).
- Browsers: wrappers in `<dir>/bin` (first on PATH, also `BROWSER`, `x-www-browser`) start chromium-family browsers
  with `--user-data-dir=<dir>/profiles/<name>` and firefox-family with `--profile …`; no `--no-sandbox`, no remote
  debugging. `pocket-app <program>` gives any program the desktop's XDG folders.
- No VNC, no X over TCP. Looking in: `workspace.control capture` → `ComputerHost.peek()` (a screenshot that does
  not disturb the helper's change tracking); locally `PocketClipboard workspaces view|shot` (`workspace-view.py`,
  copies pictures one way into an ordinary window).

### 3.4 PocketClipboard agent and the executor

- `lx/apps/clipboard-agent/src/agent.ts`: requests with `workspace` go to `WorkspaceHost.use(binding)`; without it
  they are the person's own (clipboard/screen) or, for `computer.act`, need the owner's existing `computer on`
  switch, otherwise `workspace_required`. `release` never starts a desktop. `control.kill` releases everything.
  Capabilities: `workspaces` + `workspaceHost` when desktops work; `host-desktop` only when the owner ran
  `PocketClipboard workspaces off`; neither when desktops are wanted but unavailable (→ brain refuses).
- `workspaceHost`: random id in `~/.pocket-clipboard/workspaces/host-id`, reported by PocketClipboard and by the VS
  Code extension (`readWorkspaceHost`) in `executor.status`.
- `apps/executor-extension/src/workspace-env.ts`: `resolveWorkspace` reads `live.json` of the named desktop from
  the local private folder (ownership/permission checks, id and generation must match, X server pid must still have
  the recorded start time), `commandEnvironment`/`callPlacement` build the environment via
  `chatCommandEnvironment` (drops `HUMAN_SESSION_VARIABLES`, forces X11-only toolkits, then applies the desktop's
  variables and PATH). Without a desktop a command has **no** `DISPLAY`. Shell commands keep the person's own XDG
  config on purpose (git, npm); programs opened through the helper get the desktop's own state.
- Background jobs carry `scope` and `workspace` (`tools/background.ts`); `command_output`/`command_kill` only see
  jobs of their own scope; `jobs.kill {scope, workspace?}` stops a chat's calls and jobs, or only those of one desktop.

### 3.5 Lifecycle policy (as implemented)

| Event | What happens |
| --- | --- |
| First computer/clipboard/screenshot step or shell command of a chat | Desktop is started (lazily) and reused afterwards |
| User stops the reply (`session.interrupt`) | Main agent's executor calls are aborted, `release` is sent to the desktops in use (keys/buttons let go), desktop stays; children the reply waited for end as "stopped", background children continue |
| Reset from the phone or `PocketClipboard workspaces reset` | Its programs are asked to close (up to 5 s), then the desktop and its subagent desktops are closed, jobs in them killed, browser profile kept; next use starts a new generation |
| Delete from the phone ("Delete desktop data") / `workspaces delete` | As reset, plus files removed |
| Subagent ends (any way) or its desktop is closed from the phone | Its desktop is deleted with its files, its jobs killed |
| Chat deleted / person removed | All desktops of the chat deleted, all its jobs killed |
| Chat uses another computer | Desktop on the old computer is closed on the next use (profile kept until retention) |
| Desktop unused 30 min / files unused 14 days | Closed, its programs asked to close first / removed |
| PocketClipboard stops | Desktops are closed (`close()`), their programs asked to close first; if it is killed outright `setpriv --pdeathsig` ends them, else `recover()` on next start |
| Brain restarts | Desktops stay (names are derived, the same chat gets the same desktop); running subagent cards are closed as "stopped" by `Session.reconcile()` |

### 3.6 Subagents (`lx/apps/brain/src/subagents.ts`, `session.ts`)

Children are real Claude Code tasks started by the chat's agent with its Agent tool (existing runtime delegation;
`agentDefinitions` already replaced the built-in agents). `SubagentTracker` turns the SDK's `task_started`,
`task_progress`, `task_updated`, `task_notification`, `background_tasks_changed` messages and the children's
tool traffic (`parent_tool_use_id`) into `subagent` session events. Every event is the whole card. Durable (kept in
history): start, first sign of life, background/desktop flag changes, end. Not durable: running commentary,
throttled to one per 400 ms. Shell background tasks are ignored (no `subagent_type` and a non-agent `task_type`).

- Attribution: `Session.toolOwners` maps each tool use id to the Agent tool use that owns it (null = main agent);
  a tool handler learns its own tool use id from `extra._meta['claudecode/toolUseId']` (`toolUseIdOf`). `callerOf`
  returns `'main'` or the task id. **A call that cannot be attributed while subagents are running is refused.**
- A subagent's first `computer`/`pc_*` call gets a desktop of its own (`computerTarget`, key = task id, parent =
  the chat's desktop); its shell commands run there once it exists and have no display before that.
- Permissions and project scope: unchanged paths (`canUseTool`, executor root); nothing new is auto-allowed.
- `subagent.cancel` → `q.stopTask(id)`; siblings and the parent turn continue.
- Reply ends: `tracker.replyEnded()` closes only cards of children the reply waited for; background ones stay.
- Process/daemon ends: `stopAll` / `reconcile()` (live cards are saved in `<sessions>/<id>.agents.json`).

### 3.7 Clients

`packages/client-core`: `ChatItem` type `subagent` (card replaced in place by id; an ended card never goes back to
running), `ChatClient.loadWorkspace/previewWorkspace/resetWorkspace/cancelSubagent`, `supportsWorkspaces`,
`state.workspaces`, and after a reconnect chats that show a live card are re-read (`reloadLiveSubagents`).
`apps/mobile`: `SubagentCard.tsx` (expandable card, Stop with confirmation, "Desktop" button), `DesktopChip.tsx`,
`DesktopSheet.tsx` (state, picture every 3 s, close, delete), helpers in `src/subagents.ts`, `src/desktop.ts`.
The VS Code panel, the Telegram bot and the on-screen overlay handle the new chat item minimally.

Mobile details worth knowing (the mobile UI was written by a delegated agent; these are its choices):

- The preview picture uses `expo-image` (`contentFit="contain"`, no caching, short crossfade), the repository's
  image component, instead of React Native's `Image`.
- While the sheet is open it asks for a picture every 3 s (one request at a time, the next only after the last came
  back) and for the list of desktops every 5 s, so that "Starting" turns into "Running".
- The chip shows "Computer offline" instead of the desktop's state when the computer is offline, and "+N" for the
  desktops of subagents. A chat whose computer has no desktops shows no chip.
- "Close desktop" is disabled for a desktop that is not there; "Delete desktop data" exists only for the chat's own.
- A card's Stop is hidden when no handler is passed, asks for confirmation, then shows "Stopping…" for up to 10 s.
  A finished card's headline is the first line of its report without a leading markdown `#`; the duration is blank
  for an ended child without `endedAt`.
- Elapsed times compare the phone's clock with the Mac's `startedAt`, as the Activity screen already did.
- `src/desktop.ts`, `DesktopChip.tsx` and the `useNow` hook (a timer that ticks inside one card only) were added
  beyond the original brief to hold shared wording and keep the chat list from re-rendering every second.

### 3.8 Older peers

| Peer | Behaviour |
| --- | --- |
| Old phone/overlay (no `features`) | Gets no `subagent` events, history is filtered; no workspace requests |
| Old brain + new phone | Phone sees no `features` → never sends workspace requests, shows no desktop UI |
| Old brain + new Linux PocketClipboard | `computer.act` without binding is refused (`workspace_required`) unless the owner enabled `computer on`; unmarked clipboard/screenshot requests are treated as host-scoped, as before |
| New brain + old Linux PocketClipboard | Chat requests are refused with instructions to update; phone host requests work |
| New brain + old Linux VS Code extension | Commands run, with the display removed by a command prefix |
| Windows / macOS | Unchanged |

### 3.9 Top-level `apps/brain`

It is an older variant (no Linux, Kimi, Codex, MarketLLM) and not the deployed one, so it was not changed. It still
typechecks against the new protocol and behaves as an old brain (no `features`). Decide with the owner whether to
port; the specification says to change the actual runtime path and not to copy one tree over the other.

### 3.10 Decisions of the second session

- **Programs are asked to close before a desktop that keeps its files is closed** (`quitPrograms`): every window
  gets the window manager's close request (`wmctrl -i -c`), then the manager waits until the processes the windows
  named have ended and no window is left, at most `quitMs` (5 s, inside the service's 10 s stop time and the 30 s
  the brain waits for a reset). A window's process is believed only when it is younger than the desktop's X
  server; a browser hides its environment, so the desktop's mark cannot be read from it. Deletion and a failed
  desktop skip this.
- **Browsers are reached through wrappers in the desktop's `bin`**, first on `PATH`: `firefox`, `chromium`,
  `google-chrome` with the desktop's profile, `pocket-browser` for "the browser of this desktop", and `xdg-open`
  and its relatives pointing at it. The product does not answer a browser's first-run dialogs.
- **One question for one decision**: permission requests for the same tool and chat that arrive together are
  answered by one prompt; a chat returns to the state it had before a question (`Session.setWaiting`).
- **Acceptance scripts are the integration tests of record.** They start the real relay, brain, PocketClipboard
  process, desktops and browsers; the phone, the VS Code window, the person's screen and (for subagents) the model
  are stand-ins, and each report says so. Unit tests with scripted devices remain for the brain.

### 3.11 Decisions of the third session

- **The order in which a desktop that keeps its files closes** (`WorkspaceManager.stop`): its record goes first
  (so the extension stops handing it to commands), then the chat's hands come off (`helper.release()`: a step
  under way stops, keys and buttons are let go), then the programs are asked to close (`quitPrograms`), then the
  helper is closed (SIGTERM: it ends what it started), then the window manager, the X server and the bus. On the
  brain's side the chat's jobs in that desktop are stopped after PocketClipboard answered. Deleting and a failed
  desktop ask nothing and stop everything at once, as before.
- **Two signals for the helper of a desktop**: SIGTERM means the desktop is closing and the programs the helper
  started go with it; SIGUSR1 means only this helper is being replaced (Stop during a step, a step that took too
  long) and what is open stays (`ComputerHost` option `restartSignal`; a person's own desktop is unchanged).
- **Windows are read with `xprop`** from the window manager's `_NET_CLIENT_LIST`, in `quitPrograms` and in the
  acceptance harness, as the helper already did. "The list could not be read" and "no window manager keeps a
  list" are logged and are not an empty desktop. Close requests still go through `wmctrl -i -c`.
- **Programs opened on a chat's desktop write stderr to `<desktop>/log/programs.log`** (emptied above 1 MB), not
  to a pipe of the helper. A start that fails still reports the program's last line, read from that file.
- **What the helpers start for a chat is written down** (`<run dir>/started`, pid and start time) and ended by
  the manager when the desktop closes and at its next start, under the same proof as the desktop's own
  processes: the same pid with the same start time, carrying the desktop's mark in its environment.
- **A display number is taken unless an X server really holds it** (`displayInUse`: the lock names a live
  process, or something answers on the socket in the file system or the abstract one).
- **A desktop's Firefox profile gets a `user.js`** with `browser.shell.checkDefaultBrowser` off, written once and
  never overwritten. Nothing else in a browser's profile is touched; the terms-of-use dialog is left alone.
- **The service's unit has `KillMode=mixed`**: `systemctl --user stop` signals the agent alone, which closes the
  desktops in order within `TimeoutStopSec=10`. `PocketClipboard install` enables and **restarts** the service.
  The agent's shutdown runs once, so a switch written by the command line while it quits is not overwritten.
- **The helper's half-second grace period for a step's first effect was kept**; the smoke that depended on a
  machine drawing faster than that now looks again.
- **`service-acceptance.ts` is the integration test of the installer**: it needs systemd and a machine that is
  nobody's, so it runs on the hosted runner and nowhere else so far.

## 4. Important files

| File | Role |
| --- | --- |
| `packages/protocol/src/messages.ts`, `workspace-host.ts` (+ `lx/`) | Wire schemas; local desktop record; `chatCommandEnvironment` |
| `lx/apps/brain/src/workspaces.ts` | Desktop names, job scopes, `DesktopDirectory` |
| `lx/apps/brain/src/daemon.ts` | Routing, legacy handling, workspace requests, cleanup, feature gating |
| `lx/apps/brain/src/session.ts` | Attribution, child desktops, interrupt, tracker wiring, prompts per platform |
| `lx/apps/brain/src/subagents.ts` | `SubagentTracker` |
| `lx/apps/brain/src/computer-tools.ts`, `pc-tools.ts`, `executor.ts`, `claude-tools.ts`, `store.ts` | Generations, desktop wording, call options, agent definitions, `PairedDevice.features` |
| `lx/apps/clipboard-agent/src/linux/workspaces.ts` | `WorkspaceManager` |
| `lx/apps/clipboard-agent/src/agent.ts`, `main.ts`, `computer.ts`, `linux/clipboard.ts`, `linux/computer.py`, `linux/workspace-view.py` | Request routing, CLI, helper changes (`peek`, per-desktop env), viewer |
| `lx/apps/clipboard-agent/scripts/install-linux.sh` | Installer |
| `apps/executor-extension/src/workspace-env.ts`, `dispatch.ts`, `extension.ts`, `tools/background.ts`, `tools/run-command.ts`, `tools/types.ts` (+ `lx/`) | Executor side |
| `packages/client-core/src/chat-client.ts`, `thread.ts` (+ `lx/`) | Client state |
| `apps/mobile/src/components/{SubagentCard,DesktopSheet,DesktopChip}.tsx`, `src/{subagents,desktop}.ts`, `app/direct/[id].tsx`, `app/direct/activity.tsx` (+ `lx/`) | Mobile UI |
| `.github/workflows/ci.yml`, `.hoplite/setup.sh` | `openbox dbus xclip` added so the real-desktop tests run |

Tests added: `lx/apps/brain/test/{workspaces,subagents}.test.ts`,
`lx/apps/clipboard-agent/test/{workspaces,workspace-agent}.test.ts` (+ `fixtures/workspace-holder.ts`),
`apps/executor-extension/test/workspace-env.test.ts`, `packages/protocol/test/workspaces.test.ts`,
`packages/client-core/test/subagents.test.ts`, `apps/mobile/test/{subagents,desktop}.test.ts` (the last four groups
in both trees).


Added in the second session:

| File | Role |
| --- | --- |
| `lx/apps/clipboard-agent/scripts/workspaces-acceptance.ts` | Two chats, two desktops, real browsers: 86 checks, report and screenshots |
| `lx/apps/clipboard-agent/scripts/service-acceptance.ts` | The installed agent under systemd: 27 checks, needs `--this-machine`; run by CI only |
| `lx/apps/clipboard-agent/scripts/subagents-acceptance.ts` | Subagents with a real Claude Code process: 27 checks; `--serve` for the phone app; `--live` |
| `lx/apps/clipboard-agent/scripts/acceptance/stack.ts` | The harness: relay, brain, phone, PocketClipboard process, executor, stand-in person's screen, test pages |
| `lx/apps/clipboard-agent/scripts/acceptance/scripted-model.ts` | Local stand-in for the Anthropic API that replays tool calls per agent |
| `lx/apps/brain/src/permissions.ts` | One question when the same request arrives twice at once |
| `.github/workflows/desktops-linux.yml`, `computer-linux.yml` | Acceptance jobs; helper smoke with its pictures on failure |
| `lx/artifacts/workspaces-acceptance/`, `lx/artifacts/mobile-ui/` | Evidence: reports, screenshots of both desktops, SDK messages, mobile web UI |

## 5. Setup, build and test commands

```bash
# dependencies (Node 22+, pnpm 11)
pnpm install --frozen-lockfile
pnpm --dir lx install --frozen-lockfile
# programs the real-desktop tests and the acceptance runs need (Debian/Ubuntu); .hoplite/setup.sh installs them
sudo apt-get install -y --no-install-recommends xvfb xauth python3-tk python3-pil python3-pil.imagetk python3-xlib \
  xdotool wmctrl x11-utils x11-xserver-utils openbox dbus xclip xdg-utils xterm python3-gi gir1.2-gtk-3.0
# an ordinary user: Chrome refuses to start as root (.hoplite/setup.sh creates it)
id pocket || sudo useradd -m -s /bin/bash pocket
# Firefox (for --browser firefox): .hoplite/setup.sh installs it from Mozilla's repository; by hand see section 9

# typecheck (run one tree at a time: each starts ten tsc processes)
pnpm typecheck
pnpm --dir lx typecheck
# one package: (cd lx/apps/brain && npx tsc --noEmit -p .)

# tests
pnpm test
pnpm --dir lx test
# only what this work added
cd lx && npx vitest run apps/brain/test/workspaces.test.ts apps/brain/test/subagents.test.ts apps/brain/test/permissions.test.ts \
  apps/brain/test/computer-tools.test.ts apps/clipboard-agent/test/workspaces.test.ts apps/clipboard-agent/test/workspace-agent.test.ts \
  apps/executor-extension/test/workspace-env.test.ts packages/protocol/test/workspaces.test.ts \
  packages/client-core/test/subagents.test.ts apps/mobile/test/subagents.test.ts apps/mobile/test/desktop.test.ts
# the same as an ordinary user (once: sudo mkdir -p lx/node_modules/.vite-temp && sudo chmod 1777 lx/node_modules/.vite-temp)
cd lx && runuser -u pocket -- env HOME=/home/pocket npx vitest run apps/clipboard-agent/test/workspaces.test.ts

# acceptance: two chats, two desktops, real browsers (about 2 minutes; exit code 0 when every check passed)
mkdir -p /tmp/acc && chown pocket /tmp/acc
cd lx && runuser -u pocket -- env HOME=/home/pocket node --import tsx apps/clipboard-agent/scripts/workspaces-acceptance.ts \
  --browser google-chrome --out /tmp/acc        # or --browser firefox; without --browser the first one found
# acceptance: subagents with a real Claude Code process and a scripted model (about 1 minute)
cd lx && runuser -u pocket -- env HOME=/home/pocket node --import tsx apps/clipboard-agent/scripts/subagents-acceptance.ts --out /tmp/acc-sub
# flags: --keep leaves the scratch folder (/tmp/pocket-acc-*/home/.pocket-clipboard/agent.log is PocketClipboard's log);
#        --agent <bundle> (two-chat script) runs an installed PocketClipboard instead of src/main.ts;
#        --live (subagent script) uses the real model and needs Anthropic credentials: never run;
#        --serve (subagent script) see below.
# Each writes REPORT.md / REPORT-subagents.md and screenshots into --out.
# In this sandbox a command still running at its tool timeout is killed with everything it started: give these
# runs a timeout of ten minutes, or start them detached (setsid nohup … &) and read their log.

# the helper smoke, as .github/workflows/computer-linux.yml runs it (needs xterm, python3-gi, gir1.2-gtk-3.0)
Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp & export DISPLAY=:99; openbox & sleep 2
python3 lx/apps/clipboard-agent/scripts/computer-smoke.py

# acceptance: the installed agent under systemd. Needs a machine with systemd that is nobody's (it pairs the
# installed agent with a brain of its own and uninstalls it at the end); the sandbox has no systemd, CI runs it.
bash lx/apps/clipboard-agent/scripts/install-linux.sh < /dev/null     # the pairing question stays unanswered
cd lx && node --import tsx apps/clipboard-agent/scripts/service-acceptance.ts --this-machine --browser google-chrome --out /tmp/acc-svc

# mobile app in a browser (Expo web) against a real brain with a scripted model
pnpm --filter @pocket/mobile start --web --port 8081
cd lx && runuser -u pocket -- env HOME=/home/pocket node --import tsx apps/clipboard-agent/scripts/subagents-acceptance.ts \
  --serve --out /tmp/serve-out --keep           # stays up; prints SERVING {...}; Ctrl+C (SIGINT) stops it
cat /tmp/serve-out/serve.json                   # relay URL, pairing link (holds the code), chat id, messages to send
# open http://localhost:8081/pair?code=<code>&relay=<relay url>, then /direct/<chat id>, and send
# [[do:delegate]] (two subagents, each with a desktop) or [[do:background]] (one that goes on after the reply).
# A pairing link works once: `touch /tmp/serve-out/again` writes a fresh one into serve.json.

# on the Linux computer (executed on a hosted runner only, see 0.4; `view` there needs a screen of yours)
bash lx/apps/clipboard-agent/scripts/install-linux.sh
PocketClipboard status
PocketClipboard workspaces                 # list
PocketClipboard workspaces view <desktop>  # read-only window; shot <desktop> [file.png] saves a picture
PocketClipboard workspaces reset|delete <desktop>
PocketClipboard workspaces on|off
```

CI: `.github/workflows/ci.yml` (`check`: typechecks, both suites, web export), `desktops-linux.yml` (the two-chat
run with Chrome and with Firefox, the subagent run, and the installer with its systemd service),
`computer-linux.yml` (helper smoke, lock-screen smoke). Read results with `gh pr checks 1`,
`gh run view <run id> --log-failed`, `gh run download <run id> -D <folder>` (the reports).

## 6. What was executed, and the results

### Runs of the third session

See 0.4.

### Runs of the second session (source repository `pareleneolnider-gif/pocket-linux-workspaces`, 2026-11-12)

In that session's sandbox, as `pocket`, with real Xvfb, openbox, dbus-daemon, the Python helper, xclip, Chrome for
Testing and Firefox 160.0: the two-chat acceptance run passed 85 of 85 with Firefox (twice) and with Chrome under
a profile check that accepted two of three visits (84 of 85 with the strict one); the subagent run passed 27 of
27 with a real Claude Code process and a scripted model; `clipboard-agent/test/workspaces.test.ts` and
`workspace-agent.test.ts` 27 passed; the brain's workspace and permission tests 30 passed. On that repository's
hosted runner: `check` failed at the nine `blocker-layout` tests and at the then-new reset test, Chrome 85 of 85,
Firefox 84 of 85, the subagent job stopped before its first check (`wmctrl -l` ended by a signal), the helper
smoke failed one check. Its changes, one commit each: `d5ec88d` one question for two subagents that reach for
computer use together; `d6907cf` `xdg-open` inside a desktop starts the desktop's own browser; `9663f9a` function
keys by key code; `3c8b17d` the subagent acceptance run and its CI job; `8788287` a chat is idle again after a
background subagent's question (`Session.setWaiting`); `6adf695` programs are asked to close before a desktop
that keeps its files is closed; `28fcd57`, `e510978` harness and CI diagnostics; `d3cd38a` mobile screenshots.
What that left open is what 0.3 of this file reports as found.

Everything from here to the end of this section is the record of the **first session**, in another sandbox and on
the first source repository; where it says "not executed" or "never run", section 0 is newer.

Everything below was run in the cloud sandbox (Ubuntu noble, 2 CPUs, as root, Node 24.22.2, with Xvfb, openbox,
dbus-daemon, xclip, xdotool, wmctrl and python3-tk/PIL/Xlib installed) on commit `a785cb0`, which holds all code of
this branch.

### Full runs

| Command | Result |
| --- | --- |
| `pnpm typecheck` (top-level) | Pass, all 10 projects |
| `pnpm test` (top-level) | **62 files passed; 551 tests passed, 6 skipped, 0 failed.** On `main` before this work: 57 files, 491 passed, 6 skipped |
| `pnpm --dir lx typecheck` | Pass, all 10 projects |
| `pnpm --dir lx test` | **71 files passed, 1 failed, 1 skipped; 641 tests passed, 9 failed, 8 skipped.** The 9 failures are exactly the 9 tests of `apps/clipboard-agent/test/blocker-layout.test.ts` (`module 'blocker' has no attribute 'greeter_layout'`). They fail the same way on `main` (checked before any change): **existing, unrelated, left alone.** No new failure |

### Tests added by this work (all pass)

| File | Tests | What it runs against |
| --- | --- | --- |
| `lx/apps/brain/test/workspaces.test.ts` | 18 | A real local relay and `Brain`, with scripted stand-ins for the phone, PocketClipboard and the executor |
| `lx/apps/brain/test/subagents.test.ts` | 12 | `SubagentTracker` with messages shaped like the SDK's |
| `lx/apps/clipboard-agent/test/workspaces.test.ts` | 17 | 4 pure, 4 with stub programs (fail-closed cases), **9 on real Xvfb/openbox/D-Bus desktops** (skipped where those programs are missing) |
| `lx/apps/clipboard-agent/test/workspace-agent.test.ts` | 9 | `ClipboardAgent` with fake desktops |
| `apps/executor-extension/test/workspace-env.test.ts` (+ `lx/`) | 9 | Real shell commands and background jobs; Linux only |
| `packages/protocol/test/workspaces.test.ts` (+ `lx/`) | 8 | Schemas, `chatCommandEnvironment` |
| `packages/client-core/test/subagents.test.ts` (+ `lx/`) | 8 | Thread reducer, `ChatClient` |
| `apps/mobile/test/subagents.test.ts`, `desktop.test.ts` (+ `lx/`) | 23, 12 | View helpers only (no rendering) |

What the nine real-desktop tests showed on real X servers here: three desktops started concurrently get three
displays, cookies and session buses; the X server has no TCP listener and refuses clients without the cookie or with
another desktop's cookie; no process of a desktop inherits the person's `DISPLAY`/Wayland variables; clipboards are
separate; a window started with a desktop's command environment appears on that desktop only; pointers are separate;
a stand-in "person's" X display keeps its clipboard, pointer and (empty) window list while an agent clicks, types
and copies in its own desktop; stale generations are refused after reset, crash, removal and agent restart; a killed
helper is replaced on the same desktop and a killed X server closes only that desktop; the limit, eviction, idle
close and retention work; closing ends exactly the desktop's own processes; after `kill -9` of the agent the next
start ends only processes that provably belonged to it (a forged record pointing at a bystander process is ignored),
and with `setpriv` the desktop ends together with the agent.

### Run by hand, not part of the suite

- `lx/apps/clipboard-agent/scripts/computer-smoke.py` (existing helper smoke, as in
  `.github/workflows/computer-linux.yml`): flaky here for both the changed and the unchanged helper, see 7.10.
- An early throwaway smoke of two concurrent desktops (xterm through `open`, clipboards, screenshots, stale
  generation, reset, restart) passed, but it predates later changes and is not in the repository. It is not evidence
  for the current state.
- Firefox ESR 153.7.0 was started headlessly once, outside any chat desktop, only to confirm it runs in the sandbox.

### Mobile checks (done by the delegated mobile agent; what the main agent ran again is marked)

- `pnpm --filter @pocket/mobile typecheck` and `pnpm --dir lx --filter @pocket/mobile typecheck`: exit 0. Run again:
  yes (top-level directly, `lx` as part of the full `lx` typecheck above).
- `vitest run apps/mobile` in each tree: 10 files, 105 tests passed. Run again: yes (top-level directly, `lx` as part
  of the full run above).
- `diff -rq --exclude=node_modules apps/mobile lx/apps/mobile`: no difference. Run again: yes.
- `expo export --platform web` bundled the app (output written to `/tmp` and deleted). **Run again: no.** It is
  reported by the delegated agent only; CI's `pnpm --filter @pocket/mobile export:web` step checks it once more.
- After the delegated agent finished, one sentence in `DesktopSheet.tsx` (the confirmation for closing a subagent's
  desktop) was corrected in both trees; the full runs above include that change, the web export does not.

### Not executed

- The real two-session demonstration of the specification (all six steps), including real browsers in desktops.
- Anything with a real Claude Code session, so no real subagent was ever spawned, shown or cancelled.
- The mobile app (Expo web or iOS), the Linux installer, the `PocketClipboard workspaces` commands, the viewer, the
  VS Code extension inside VS Code.

### CI on the draft pull request (first look, 2026-11-12 14:57 UTC, head `4ff0f30`)

CI was already red on `main` before this branch: the three latest `CI` runs for pushes to `main` on 2026-11-12 all
ended in failure. That fits the nine existing blocker-layout failures, which stop the `check` job at
`pnpm --dir lx test`, so the greeter-layout step and `pnpm --filter @pocket/mobile export:web` after it never run.

| Job | Result | Reading |
| --- | --- | --- |
| `CI` / `check` | Still running when last looked | Expected to stop at `pnpm --dir lx test` on the nine existing failures; check that nothing else fails before that |
| `CI` / `windows-blocker` | Passed | |
| `Computer use (Linux)` / "Use real windows through the helper" | **Failed**, 2 of the smoke's checks | (a) `screenshot failed: No module named 'Xlib'`: the workflow's package list has no `python3-xlib`, which the helper's screenshot path needs; with `POCKET_WORKSPACE_ID` unset that path is the same as on `main`. (b) `key "f5" presses F5` recorded `Alt_L` instead: unexplained, key handling is untouched by this branch. This workflow only starts for pull requests that touch the Linux helper and had never run in this repository, so there is no earlier passing run to compare with |
| `Computer use (Linux)` / "Render the native Linux lock screen" | **Failed**: `TypeError: unsupported operand type(s) for -: 'method' and 'float'` | Lock-screen code (`blocker.py`, `scripts/blocker-smoke.py`), which this branch does not change: existing, same family as the blocker-layout failures |
| Windows overlay / computer jobs, iOS simulator build | Pending when last looked | |

## 7. Known bugs, blockers and unverified assumptions

Start with 0.5: it lists what is open now. Older points that still hold:

1. **Attribution key: verified with the real Claude Code process.** `toolUseIdOf` in `lx/apps/brain/src/session.ts`
   reads `extra._meta['claudecode/toolUseId']`; the CLI bundled with `@anthropic-ai/claude-agent-sdk@0.3.303` sets
   it, and the subagent acceptance run attributes every call of two concurrent subagents correctly. Not verified
   with a live model, which should make no difference to this key.
2. **SDK task events: observed in a real run** (`lx/artifacts/workspaces-acceptance/sdk-messages.json`), with the
   scripted model. What a live model's timing does to their order is unverified.
3. **The VS Code extension changes were never run inside VS Code.** Both devices must run as the same Linux user
   with the same home directory; under Remote-SSH, containers, snap/flatpak confinement or another `HOME` the
   extension finds no record and commands get no display (fail closed, by design; the README says so).
4. **Chrome/Chromium as root** refuses to start without `--no-sandbox`, which the wrappers never add. Run as a
   normal user (the acceptance commands do).
5. The systemd unit still carries the installing session's `DISPLAY`/`XAUTHORITY` for the lock screen (existing
   behaviour); per-chat desktop settings are never imported into it. The unit has `TimeoutStopSec=10`; closing
   the desktops takes up to 5 s of it when a program does not close.
6. The person's default PocketClipboard computer changes when the phone asks another computer for its clipboard
   or screen (existing `setActiveExecutor` behaviour); chats without a computer of their own then move there and
   their desktops on the previous computer are closed on next use.
7. Kimi, Codex and MarketLLM use the same tool handlers, so routing applies, but nothing was run with those
   engines beyond the existing tests. They have no subagents; their calls are attributed to the main agent.
8. History grows by a few whole cards per subagent (up to 20 000 characters of result each); `historyFor` does not
   collapse them. Harmless for correctness (the client replaces by id), possibly large payloads.
9. Display numbers from 100 upward are assumed free of other software; a clash is handled (next number), and a
   number whose X server was killed is taken again. A host that blocks Xvfb entirely yields
   `workspace_unavailable`.
10. Mobile assumptions only a phone can confirm: `expo-image` keeps the previous picture while the next one loads;
    elapsed times are off by the clock difference between phone and Mac; every open desktop sheet costs the Linux
    computer one screenshot round trip every 3 s and one status round trip every 5 s.

## 8. Remaining work, in order

Done in the third session, kept here so the numbering of older notes still means something:

- [x] **1. The hosted runner agrees with the sandbox.** Every hosted job this work owns passes (0.4).
- [x] **2. Chrome keeps its last seconds** across a reset; so does Firefox (0.3 findings 1 and 4).
- [x] **3. Both acceptance scripts, both browsers, evidence replaced**, in the sandbox at `be8a394` and on the
      hosted runner at every push since.
- [x] **4. Helper smoke**: the smoke looks again; the helper's timing is unchanged (0.3 finding 8).
- [x] **9. User documentation**: `lx/README.md`.
- [x] **10. Smaller**: display numbers are reclaimed; the helper no longer holds the stderr pipe of programs on a
      chat's desktop; `.hoplite/setup.sh` installs Firefox (**that script change has not been through a sandbox
      setup yet**: a fresh session is its first run; if Firefox is missing afterwards, section 9 has the commands).

Open, in this order:

- [ ] **A. Read the hosted run of the head commit** (`gh pr checks 1`): `9aed0cd` and what came after it had not
      been seen on the hosted runner when the session stopped (0.0). The reports are the artifacts of the
      `Chat desktops (Linux)` run (`gh run download <run id> -D <folder>`).
- [ ] **B. Mobile UI** (old item 5): no report was written; start from the pictures and the list in 0.0 and do the rest of the
      look: Expo web on port 8081, `subagents-acceptance.ts --serve` detached as `pocket`, pair in the browser,
      and go through: the chat after a background subagent's question was answered (it must be idle, not
      "typing"; `Session.setWaiting`), completed/stopped/failed cards, Stop and its confirmation, the desktop
      sheet's "Close desktop" and "Delete desktop data" with their confirmations, reload while subagents run and
      after they ended, the Activity screen, 320 and 375 pixel wide screens. Fix what it finds in **both** copies
      of `apps/mobile` (and `packages/client-core` if it is there), keep `diff -rq` clean. An iOS build is the
      owner's.
- [ ] **C. A run with a live model** (old item 6) on a machine with Anthropic credentials:
      `subagents-acceptance.ts --live`.
- [ ] **D. The installer on the owner's Linux machine** (rest of old item 7): from inside an X11 session, with
      the lock screen, `workspaces view` from the installed bundle, and the service stopping at logout.
- [ ] **E. The executor inside VS Code** on the same machine (old item 8).
- [x] **F. Programs opened through a helper that was since replaced** end with their desktop (`9aed0cd`, 0.0).
- [ ] **G. Run the two-chat and subagent acceptance runs and the full suites once more in the sandbox on the head
      commit** and replace `lx/artifacts/workspaces-acceptance/` (they were last run there at `be8a394`; the
      hosted runner has run them since).
- [ ] **H. Owner's decisions** (old item 11): the nine `blocker-layout` tests and the lock-screen smoke (existing
      failures that keep `check` and `Computer use (Linux)` red); the top-level `apps/brain` (3.9); what the
      agent is told about Firefox's terms-of-use dialog (0.5 item 7); collapsing subagent events in history.

## 9. Local-only state that a fresh workspace will not have

Nothing needed to resume is outside the repository. To get the same test machine back:

- **`.hoplite/setup.sh`** (run by the sandbox, or by hand) installs the X programs, what the helper smoke needs
  (`xterm`, `python3-gi`, `gir1.2-gtk-3.0`), Firefox from Mozilla's repository with the `SkipTermsOfUse` policy,
  creates the user `pocket` and opens `lx/node_modules/.vite-temp` to it. The Firefox part and the last line were
  added in the third session and have not been through a setup yet. By hand, as root:
  ```bash
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://packages.mozilla.org/apt/repo-signing-key.gpg -o /etc/apt/keyrings/packages.mozilla.org.asc
  echo "deb [signed-by=/etc/apt/keyrings/packages.mozilla.org.asc] https://packages.mozilla.org/apt mozilla main" > /etc/apt/sources.list.d/mozilla.list
  printf 'Package: *\nPin: origin packages.mozilla.org\nPin-Priority: 1000\n' > /etc/apt/preferences.d/mozilla
  apt-get update && apt-get install -y --no-install-recommends firefox
  # without this every new profile starts under a terms-of-use dialog and the acceptance run cannot see its pages
  mkdir -p /etc/firefox/policies && echo '{"policies":{"SkipTermsOfUse":true}}' > /etc/firefox/policies/policies.json
  ```
- **Chrome** was already in the sandbox image (`/usr/local/bin/google-chrome`, "Google Chrome for Testing").
- No credentials of any kind were configured (no Anthropic key, no project variables).
- Throwaway files not in the repository and not needed: the experiment scripts of the third session (a Tk-only
  display for `wmctrl`, a browser across a reset outside the harness, Xvfb with a stale lock), CI logs, and the
  scratch folders `/tmp/pocket-acc-*` of acceptance runs.
- Sandbox quirks: two CPUs and 8 GiB (run one typecheck at a time); **no systemd**; a command still running at
  its tool timeout is killed together with everything it started, so long runs need a ten-minute timeout or a
  detached start. Blocked by policy: feeding a script to an interpreter through a heredoc, `bash <script>`,
  `bash -n`, `sh -c '…'`, and `gh` with command substitution. Write a file and run it with `node` or `python3`, or
  make it executable and call it by path; run `gh` from inside the checkout. `bash -n` on the installer runs in CI.

## 10. Continuation prompt

> Continue the unfinished Linux work in `karettelinaliinbel-cpu/pocket-linux-workspaces` on the branch
> `hoplite/rhegion-4c6b5acd` (draft pull request #1; do not merge, do not deploy, do not start the Windows
> installer task). Read `HANDOFF.md` section 0 first, then `LINUX-AGENT-WORKSPACE-PROMPT.md` and sections 8 and 9
> of `HANDOFF.md`. Work through the open list of section 8 in order: read the hosted run of the head commit,
> finish the look at the mobile UI and fix what it found, then what needs credentials or the owner's machine (a
> live model, the installer inside an X11 session, VS Code). Keep the top-level and `lx/` copies of protocol,
> client-core, executor-extension and mobile in step. Say exactly what was executed, with what standing in for
> what, and what was not. Keep `HANDOFF.md` current and push it before the session ends.
