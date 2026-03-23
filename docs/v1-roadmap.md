# AgentBridge v1 Roadmap

## 1. Current v1.0 State

AgentBridge v1.0 already provides a working local bridge between Claude Code and Codex in the same workspace.

Current capabilities:

- A persistent local daemon process that can survive Claude restarts.
- Automatic daemon startup and reuse from the Claude-side bridge.
- A Codex app-server proxy and TUI attach flow.
- Bidirectional message flow between Claude and Codex through the `reply` tool.
- Basic readiness, disconnect, reconnect, and status notifications.
- Buffered delivery of Codex messages while Claude is temporarily disconnected.

Current architectural limits:

- Only `agentMessage` items are forwarded today.
- The bridge assumes one active Codex thread.
- The bridge assumes one Claude foreground connection.
- A newer Claude connection replaces the older one.

## 2. v1 Optimization Goals

The goal of the v1 roadmap is to improve day-to-day usability without introducing the larger architectural refactor planned for v2.

Guiding principles:

- Improve the single-Claude, single-Codex path rather than redesigning the system.
- Prioritize visible user experience gains over architectural ambition.
- Reduce noise, improve turn discipline, and add clearer collaboration modes.
- Keep changes small enough to ship incrementally and validate quickly.
- Avoid pulling v2 or later multi-agent infrastructure into v1.

In short, v1 should make the bridge feel smoother every day, while v2 remains the milestone for deeper architectural change.

## 3. v1.1 Smart Message Filtering

### Problem

The current bridge forwards every `agentMessage` as-is. In practice, many of those messages are low-value status confirmations, repeated log-reading chatter, or intermediate exchanges that clutter the Claude-side experience.

### Proposed improvement

Use a prompt-led filtering strategy rather than a heavy bridge-side rule engine. The v1.1 design is:

**Prompt Contract + Marker Protocol + Lightweight Bridge Filter**

This approach keeps the implementation small while using the agent itself to decide what is worth forwarding across the bridge.

#### A. Codex-side Bridge Messaging Contract

Codex should be instructed to use `agentMessage` only for high-value communication that is genuinely useful to Claude. Intermediate reasoning, repeated status confirmations, and low-value progress chatter should be kept internal whenever possible.

Codex should also be instructed to mark outbound bridge messages with one of the following markers:

| Marker | Bridge behavior |
|--------|-----------------|
| `[IMPORTANT]` | Forward immediately |
| `[STATUS]` | Buffer and summarize |
| `[FYI]` | Drop by default |
| `untagged` | Forward by default |

Within this contract, `[STATUS]` should also carry concise intermediate progress summaries when ongoing work is worth surfacing. Instead of having the bridge reconstruct low-level event streams, Codex should summarize meaningful intermediate activity directly inside `[STATUS]` messages.

The same contract may also treat prefixes such as `@codex:` and `@claude:` as lightweight intent markers. In v1 they remain conventions rather than a full routing capability, but they still make the intended target more explicit.

#### B. Claude-side Channel Instructions

Claude-side channel instructions should explain how to interpret the marker protocol:

- `[IMPORTANT]` means the message needs attention, decision-making, review, or a meaningful response.
- `[STATUS]` means the message is progress context and does not always require an immediate reply.
- `[FYI]` means the message is background context that can usually be treated lightly.

This keeps both sides aligned on what counts as high-value bridge traffic.

#### C. Bridge-side Marker-Aware Filtering

The bridge still provides lightweight enforcement and summary behavior, but it does not try to outsmart the agent with a large rule engine.

- `[IMPORTANT]` messages are forwarded immediately.
- `[STATUS]` messages are buffered and later emitted as a summary.
- `[FYI]` messages are dropped by default.
- Untagged messages are forwarded by default for safety and backward compatibility.

Summary buffers should flush under these conditions:

1. The buffered `STATUS` count reaches a configured threshold.
2. A time window expires without a summary having been emitted.
3. A new `[IMPORTANT]` message arrives and should be preceded by the pending summary.
4. The current turn completes.
5. Claude reconnects or another bridge lifecycle event makes it useful to flush pending context.

The bridge should expose two modes:

- `filtered` (default)
- `full`

Advantages of this approach:

1. It requires much less code than a large bridge-side classifier.
2. It lets the agent use context awareness rather than shallow local rules.
3. It preserves a simple fallback path because untagged messages still forward by default.
4. It creates a lightweight convention that can evolve into stronger semantics in later versions.

Known limitations:

1. Prompt guidance is a soft constraint, not a hard guarantee.
2. Codex may occasionally mislabel a message or omit a marker.
3. The bridge still needs a lightweight fallback path for imperfect adherence.

### Implementation scope

- Add a Codex-side bridge messaging contract through injected instructions or reminders.
- Update Claude-side channel instructions to explain marker meaning and handling.
- Add marker-aware bridge filtering with buffered summary flush behavior.
- Ship `filtered` as the default mode while preserving a `full` mode for debugging or raw inspection.
- Keep the implementation local to the current single-bridge path rather than introducing a broader policy system.

### Expected user impact

- Claude sessions become noticeably less noisy by default.
- Important collaboration messages stand out more clearly.
- Progress remains visible through summaries instead of raw chatter.
- Users get a better bridge experience without needing a larger architectural migration first.

## 4. v1.2 Turn-Based Coordination

### Problem

The current bridge can detect when Codex is already in an active turn, but it does not enforce strong coordination. This can lead to replies arriving at awkward times or multiple actions being pushed into a workflow that is effectively serial.

### Proposed improvement

Use a lightweight bidirectional coordination strategy instead of introducing a queue-heavy bridge scheduler. The v1.2 design is:

**Bidirectional Coordination via Hard Turn Signals + Soft Attention Window**

This design treats coordination as a two-way collaboration problem rather than only blocking Claude-to-Codex interruptions. It introduces a shared coordination concept while keeping the implementation intentionally asymmetric and small.

#### A. Unified coordination concept

Conceptually, each agent has a visible collaboration state such as `busy`, `ready`, or `attention-window`. In v1 this idea is only partially implemented:

- Codex has a hard turn signal because the bridge can detect turn start and completion.
- Claude does not expose an equivalent hard turn signal, so Claude-side coordination must use a soft attention model instead.

This shared concept leaves room for richer multi-agent coordination later without building a generalized coordinator now.

#### B. Codex -> Claude via marker filtering and attention window

The Codex-to-Claude side should continue to rely on the v1.1 marker contract:

- `[IMPORTANT]` may interrupt and forward immediately.
- `[STATUS]` should usually be buffered and summarized.
- `[FYI]` should usually be dropped.

After Codex emits a high-value completion or milestone message, the bridge should give Claude a short attention window. During that window, low-priority Codex progress updates should not keep interrupting Claude:

- `[IMPORTANT]` still forwards.
- `[STATUS]` is buffered instead of pushed immediately.
- `[FYI]` remains low priority or dropped.

This gives Claude room to read, think, and respond without pretending that the bridge can truly detect Claude's internal reasoning state.

#### C. Claude -> Codex via turn status notifications, wait behavior, and busy reject

When Codex starts a turn, the bridge should notify Claude that Codex is busy. When the turn completes, the bridge should notify Claude that Codex is ready again.

Claude-side instructions should explain that during the busy period, Claude should avoid calling the `reply` tool and instead wait for the completion notification. If Claude still tries to reply during an active Codex turn, the bridge should return a minimal busy response instead of silently injecting overlapping work.

Advantages of this approach:

1. It treats coordination as a two-way problem instead of only blocking one direction.
2. It keeps coordination visible to the user instead of hiding it inside a queue.
3. It uses hard Codex turn signals where available and soft attention handling where hard signals do not exist.
4. It stays aligned with the v1 principle of improving experience without architectural redesign.

Known limitations:

1. Claude attention is inferred through a soft window rather than detected as a true turn state.
2. Claude instructions remain a soft constraint and may not always be followed perfectly.
3. This design leaves room for future multi-agent coordination, but it does not implement a generalized coordinator in v1.

Why this version does not introduce message queues:

- A queue adds more state, ordering rules, and edge cases than v1 needs.
- Queue semantics quickly push the design toward a generalized coordination framework.
- For v1, visible status, marker-aware buffering, and minimal reject behavior are a better fit than hidden deferred execution.

### Implementation scope

- Surface Codex turn start and completion as Claude-visible bridge notifications.
- Update Claude-side channel instructions so Claude waits during the busy period.
- Add a short Claude attention window after Codex emits a high-value completion or milestone message.
- Buffer low-priority Codex `STATUS` messages during that attention window.
- Add a minimal busy guard on the existing reply path.
- Reuse existing turn lifecycle and marker signals rather than introducing a queue, scheduler, or generalized coordination framework.

### Expected user impact

- Coordination becomes visibly bidirectional rather than feeling one-sided.
- Claude gets space to respond after important Codex updates without being drowned in follow-up chatter.
- Claude can respond to the user more naturally when Codex is still working.
- Collaboration rhythm becomes more predictable without introducing heavy scheduling machinery.

## 5. v1.3 Role-Aware Collaboration

### Problem

The current bridge provides transport, but not much collaboration structure. Claude and Codex can talk to each other, but they do not yet have a consistent default division of roles or a lightweight way to coordinate how they think through a problem together.

### Proposed improvement

Introduce role-aware collaboration as:

**Role Contract + Thinking Patterns**

This keeps the collaboration model lightweight while giving the agents a more intentional way to divide labor and reason together.

In v1, these patterns are applied to the current single-Claude, single-Codex bridge path. Conceptually, they can extend to future multi-agent collaboration, but v1 does not claim to implement that broader topology.

#### A. Role Contract

The bridge should establish a default role contract:

- Claude defaults toward reviewer, planner, and debugger or hypothesis challenger behavior.
- Codex defaults toward implementer, executor, and reproducer or verifier behavior.

This defines who tends to do what, without hard-locking either side into a rigid hierarchy.

#### B. Thinking Patterns

The bridge should also support lightweight collaboration thinking patterns. These are not heavy workflow modes. They are prompt-level patterns that shape how Claude and Codex work through a task together.

Recommended built-in patterns:

1. **Independent Analysis and Convergence**
   Participants first form independent views, then compare conclusions, identify agreement, challenge disagreement, and converge or explicitly record remaining disagreement.

2. **Architect -> Builder -> Critic**
   Participants distribute roles across framing, building, and critique. One participant may frame the plan, constraints, and acceptance criteria, another may build, and another may return as critic or verifier to close the loop.

3. **Hypothesis -> Experiment -> Interpretation**
   Participants divide the work across hypothesis generation, experimentation, and interpretation, then update their conclusions based on the result.

#### C. Explicit Collaboration Language

The bridge contract should encourage explicit sentence forms instead of adding more marker syntax. For analytical collaboration, the agents should be encouraged to say things such as:

- `My independent view is: ...`
- `I agree on: ...`
- `I disagree on: ...`
- `I am persuaded because: ...`
- `Current consensus: ...`

This keeps the collaboration readable without introducing a heavier protocol layer.

#### D. Task-Driven Pattern Selection

Different task types should bias different default thinking patterns:

- analytical and review tasks favor **Independent Analysis and Convergence**
- implementation tasks favor **Architect -> Builder -> Critic**
- debugging tasks favor **Hypothesis -> Experiment -> Interpretation**

This preserves flexibility without requiring the user to constantly switch explicit modes.

### Implementation scope

- Establish a default role contract between Claude and Codex.
- Add lightweight thinking-pattern guidance through bridge contract and channel instructions.
- Encourage explicit collaboration phrasing rather than introducing new marker syntax.
- Let task type bias which pattern is used by default.
- Keep the implementation inside the existing single-bridge path rather than introducing a workflow engine or generalized policy layer.

### Expected user impact

- Users get clearer default collaboration behavior with less manual setup.
- Analytical tasks benefit from more independent reasoning and more explicit convergence.
- Implementation and debugging flows feel more intentional and less ad hoc.
- The bridge feels more structured without becoming a workflow engine.

## 6. Distribution and Quick Start

Making AgentBridge easy to try should not wait for the larger v2 architecture. The right v1 direction is to package the current single-bridge experience as a local CLI product rather than leaving it as a repository-first developer setup.

### Recommended product shape

The preferred distribution model for v1 is:

- an `npm` package for distribution
- an `agentbridge` CLI as the primary product interface

This keeps installation, diagnostics, configuration, and lifecycle management in one place. It also fits the current system better than trying to start with an extension-first design.

Recommended core commands:

- `agentbridge init`
- `agentbridge doctor`
- `agentbridge start`
- `agentbridge stop`
- `agentbridge status`
- `agentbridge attach`

### Quick-start model

In this model, `npx` should be treated as an installer or bootstrap entrypoint, not the long-term runtime entrypoint.

The expected first-run flow is:

1. Run `npx agentbridge init`
2. Let the CLI check local prerequisites and environment health
3. Let the CLI write or update MCP configuration
4. Let the CLI generate project-level context files or prompt skeletons
5. Start Claude Code with the configured AgentBridge integration

The `init` command should do the most work because it is the highest-friction step in adoption. It should:

- verify required tools and versions
- detect Codex availability
- validate local ports and startup assumptions
- write or patch MCP configuration
- generate project file skeletons for shared context and agent overlays

### Why v1 should not start with an extension or plugin

An extension or plugin may still be useful later, but it should not be the first product shape.

- The hardest current problems are local bootstrap, process lifecycle, health checks, and configuration.
- Those are CLI problems first, not UI shell problems.
- A plugin can later wrap or invoke the CLI, but it should not replace the CLI as the base layer.

### Technical challenges

The main delivery challenges for this direction are:

- reducing or packaging the current Bun runtime dependency for easier installation
- safely writing or merging MCP configuration
- discovering and validating the local Codex installation
- handling platform differences across local environments

These are practical productization challenges, but they are still much smaller than introducing a full plugin platform or a v2-style architecture migration.

## 7. Collaboration Awareness Injection

### Problem

By default, each agent behaves as if it is working alone. Even if AgentBridge is connected, the participant may not clearly know that another agent is actively collaborating in the same workflow, or how that collaboration is supposed to work.

### Proposed improvement

Use the bridge to inject collaboration awareness automatically.

After the bridge connects, each agent should be told two things:

1. you are not working alone
2. this is how collaboration should work

This keeps the model simple. The user should not need to manually create project context files, prompt overlays, or coordination documents just to get the basic collaborative behavior.

In v1, the bridge should package the existing collaboration guidance from v1.1, v1.2, and v1.3 into a single collaboration-awareness injection:

- message quality and marker expectations from v1.1
- turn and attention expectations from v1.2
- role contract and thinking-pattern expectations from v1.3

### Delivery path

The injection path should stay lightweight and runtime-specific:

- Claude receives collaboration awareness through channel instructions
- Codex receives collaboration awareness through bridge contract reminders

This keeps the implementation aligned with the current architecture rather than introducing a larger prompt-management system.

### User experience goal

The target experience is zero configuration for basic collaboration awareness.

Users should not need to:

- create extra project prompt files
- manually synchronize instructions across agents
- manage a separate prompt system just to tell the agents they are collaborating

The bridge itself should establish that shared awareness automatically when the session starts.

## 8. Out of Scope for v1

The following items are intentionally left out of v1 because they either require architectural restructuring or would pull later-version complexity into the current codebase:

- Multi-session support for multiple Claude connections and multiple Codex threads.
- Fixing the singleton Claude attachment model in a general way.
- Full room-based or multi-agent routing.
- True third-agent integration such as Claude, Codex, and Gemini in the same session topology.
- Generalized policy infrastructure for agent assignment and semantic routing.
- Full durability and recovery infrastructure for multi-agent state.

These items belong to v2 or later because they cross the boundary from user experience optimization into architectural redesign.

## 9. Version Positioning: v1 -> v2 -> v3 -> v4

- **v1** focuses on improving the single-bridge user experience: better message quality, clearer turn discipline, and more intentional role-aware collaboration.
- **v2** introduces the architectural foundation for multi-agent, multi-room, and recoverable collaboration.
- **v3** can build smarter coordination and richer policy behavior on top of the v2 foundation.
- **v4** can explore broader orchestration and more advanced multi-runtime collaboration.
