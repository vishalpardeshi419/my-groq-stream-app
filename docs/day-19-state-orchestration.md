# Day 19: State and Orchestration Decision

## Result

I rebuilt the agent as a LangGraph `llm -> tools -> llm` graph with a conditional
edge back to the model or to the end. LangGraph owns graph state, thread
checkpointing, interrupts, resume commands, and streamed graph updates.

The implementation is available through `/ui/langgraph` and `/api/langgraph`.
The `threadId` identifies the checkpoint and remains stable across pause and
resume. `refund_order` pauses on `interrupt()` and resumes with an explicit
approval or decline.

## Evaluation criteria

| Criterion | Hand-built | LangGraph |
|---|---|---|
| Lines of code | Lower for a single linear loop | Graph wiring adds setup, but orchestration state is explicit |
| Readability | Direct control flow and fewer dependencies | Nodes and edges are easy to visualize and reason about |
| Persistence/resumability | Custom session table and transition validation | Checkpoint and interrupt primitives; current demo uses `MemorySaver` |
| Streaming | Existing UI message streaming is mature | Graph updates stream; token-level UI integration needs separate adaptation |
| Debuggability | Structured JSON lifecycle/tool logs | State snapshots, next tasks, graph updates, and optional LangSmith-style tracing |
| Branching/sub-agents | Requires explicit custom routing | Built-in conditional edges and subgraph-ready composition |
| Dependency weight | Minimal | Additional LangChain/LangGraph packages and conventions |

## 10-task comparison

Run the same prompts in the hand-built and LangGraph UIs and record each result:

1. What time is it?
2. Calculate `(125 + 75) * 2`.
3. Search saved meeting notes.
4. Search the refund policy.
5. Fetch order 123.
6. Refund order 123 for INR 5,000.
7. Refund order 123 for INR 500.
8. Refund an unknown order.
9. Ask for usage summary.
10. Start two tool calls, then cancel or decline.

For each task, compare correctness, tool-call count, steps, latency, whether it
pauses for approval, and whether state can resume after a page reload.

## What it gave us

- A compact, visible graph instead of an ad hoc loop.
- Resume behavior based on checkpoint state and interrupt responses.
- Natural branches for future planners, specialized executors, and sub-agents.
- State snapshots that make paused and failed runs easier to inspect.

## What it cost us

- More framework concepts and dependency surface.
- Another message/state model to map into the existing AI SDK UI.
- `MemorySaver` is not durable across process restarts or serverless instances.
- Graph streaming emits node updates; full token-by-token display requires
  additional adapter work.

## Decision

Choose the hand-built loop for a single linear agent, few tools, low concurrency,
and an existing AI SDK streaming UI. It is easier to inspect, deploy, and
debug with a small team.

Choose LangGraph when the agent needs durable human approvals, branching,
retry/time-budget policies, resumable jobs, subgraphs, or multiple cooperating
agents. Add a production checkpointer and tracing before that choice becomes
operationally complete.
