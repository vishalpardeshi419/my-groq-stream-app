import { z } from "zod";
import { auth } from "@/lib/auth";
import { embedQuery } from "@/lib/rag/embeddings";
import { RAG_MAX_SEARCH_RESULTS } from "@/lib/rag/constants";
import { searchDocumentChunks } from "@/lib/rag/store";

const searchSchema = z.object({
  query: z.string().trim().min(1).max(1_000),
  topK: z.number().int().min(1).max(RAG_MAX_SEARCH_RESULTS).optional(),
});

export async function POST(request: Request) {
  let userId: string;
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) {
      return Response.json(
        { error: "Sign in to search documents." },
        { status: 401 },
      );
    }
    userId = session.user.id;
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "rag.search.authentication.failed",
        errorType: error instanceof Error ? error.name : typeof error,
      }),
    );
    return Response.json(
      { error: "Unable to verify your current session." },
      { status: 500 },
    );
  }

  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > 16 * 1024) {
    return Response.json(
      { error: "Search requests must be 16 KB or smaller." },
      { status: 413 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const parsed = searchSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Provide a query of up to 1,000 characters." },
      { status: 400 },
    );
  }

  try {
    const embedding = await embedQuery(parsed.data.query);
    const results = await searchDocumentChunks({
      userId,
      embedding,
      topK: parsed.data.topK ?? 5,
    });
    return Response.json({ results });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "rag.search.failed",
        userId,
        errorType: error instanceof Error ? error.name : typeof error,
      }),
    );
    return Response.json(
      {
        error:
          "Unable to create a local search embedding. Check server logs and retry.",
      },
      { status: 503 },
    );
  }
}
