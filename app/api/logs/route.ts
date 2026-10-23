import { clearRuntimeLogs, getRuntimeLogs } from "@/lib/runtime-logs";

function unavailable() {
  return Response.json(
    { error: "Runtime logs are only available in development." },
    { status: 404, headers: { "Cache-Control": "no-store" } },
  );
}

export async function GET() {
  if (process.env.NODE_ENV !== "development") return unavailable();

  return Response.json(
    { logs: getRuntimeLogs() },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function DELETE() {
  if (process.env.NODE_ENV !== "development") return unavailable();

  return Response.json(
    { cleared: clearRuntimeLogs() },
    { headers: { "Cache-Control": "no-store" } },
  );
}