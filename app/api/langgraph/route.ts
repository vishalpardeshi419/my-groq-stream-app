import {
  getLangGraphState,
  resumeLangGraph,
  runLangGraph,
} from "@/lib/langgraph-agent";

export async function GET(req: Request) {
  const threadId = new URL(req.url).searchParams.get("threadId");
  if (!threadId) {
    return Response.json({ error: "threadId is required" }, { status: 400 });
  }
  const state = await getLangGraphState(threadId);
  return Response.json({
    threadId,
    values: state.values,
    next: state.next,
    tasks: state.tasks,
  });
}

export async function POST(req: Request) {
  let body: {
    threadId?: string;
    message?: string;
    resume?: { approved: boolean; reason?: string };
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.threadId) {
    return Response.json({ error: "threadId is required" }, { status: 400 });
  }

  const stream = body.resume
    ? resumeLangGraph(body.threadId, body.resume)
    : typeof body.message === "string" && body.message.trim()
      ? runLangGraph(body.threadId, body.message.trim())
      : null;

  if (!stream) {
    return Response.json({ error: "message or resume is required" }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const responseStream = new ReadableStream({
    async start(controller) {
      try {
        for await (const update of await stream) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(update)}\n\n`),
          );
        }
        controller.enqueue(encoder.encode("event: done\ndata: {}\n\n"));
        controller.close();
      } catch (error) {
        controller.enqueue(
          encoder.encode(
            `event: error\ndata: ${JSON.stringify({ message: error instanceof Error ? error.message : "Graph failed" })}\n\n`,
          ),
        );
        controller.close();
      }
    },
  });

  return new Response(responseStream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
