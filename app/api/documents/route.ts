import { createHash } from "node:crypto";
import { auth } from "@/lib/auth";
import {
  countDocumentTokens,
  chunkDocumentSections,
} from "@/lib/rag/chunking";
import {
  RAG_MAX_CHUNKS,
  RAG_MAX_DOCUMENT_BYTES,
  RAG_MAX_DOCUMENT_TOKENS,
} from "@/lib/rag/constants";
import { embedDocuments } from "@/lib/rag/embeddings";
import {
  DocumentParseError,
  getDocumentFormat,
  parseDocument,
} from "@/lib/rag/parse-document";
import {
  findDocumentByHash,
  saveDocumentChunks,
} from "@/lib/rag/store";

const MAX_MULTIPART_BYTES = RAG_MAX_DOCUMENT_BYTES + 64 * 1024;

class UploadTooLargeError extends Error {
  constructor() {
    super("The upload is too large.");
    this.name = "UploadTooLargeError";
  }
}

async function readUploadForm(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Upload body is missing.");

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_MULTIPART_BYTES) {
        await reader.cancel();
        throw new UploadTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const blobParts = chunks.map((chunk) => {
    const buffer = new ArrayBuffer(chunk.byteLength);
    new Uint8Array(buffer).set(chunk);
    return buffer;
  });
  const boundedRequest = new Request(request.url, {
    method: "POST",
    headers: request.headers,
    body: new Blob(blobParts),
  });
  return boundedRequest.formData();
}

function logFailure(event: string, userId: string, error: unknown) {
  const cause = error instanceof Error ? error.cause : undefined;
  console.error(
    JSON.stringify({
      event,
      userId,
      errorType: error instanceof Error ? error.name : typeof error,
      causeType: cause instanceof Error ? cause.name : typeof cause,
      causeMessage:
        cause instanceof Error ? cause.message.slice(0, 240) : undefined,
    }),
  );
}

export async function POST(request: Request) {
  let userId: string;
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) {
      return Response.json({ error: "Sign in to upload documents." }, { status: 401 });
    }
    userId = session.user.id;
  } catch (error) {
    logFailure("rag.document.authentication.failed", "unknown", error);
    return Response.json(
      { error: "Unable to verify your current session." },
      { status: 500 },
    );
  }

  const contentLength = Number(request.headers.get("content-length"));
  if (
    Number.isFinite(contentLength) &&
    contentLength > RAG_MAX_DOCUMENT_BYTES + 64 * 1024
  ) {
    return Response.json(
      { error: "Documents must be 10 MB or smaller." },
      { status: 413 },
    );
  }

  let formData: FormData;
  try {
    formData = await readUploadForm(request);
  } catch (error) {
    if (error instanceof UploadTooLargeError) {
      return Response.json(
        { error: "Documents must be 10 MB or smaller." },
        { status: 413 },
      );
    }
    return Response.json(
      { error: "Upload must be a valid multipart form." },
      { status: 400 },
    );
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return Response.json({ error: "Choose a document to upload." }, { status: 400 });
  }
  if (file.size === 0) {
    return Response.json({ error: "The selected file is empty." }, { status: 400 });
  }
  if (file.size > RAG_MAX_DOCUMENT_BYTES) {
    return Response.json(
      { error: "Documents must be 10 MB or smaller." },
      { status: 413 },
    );
  }

  const format = getDocumentFormat(file.name);
  if (!format) {
    return Response.json(
      { error: "Supported formats are PDF, DOCX, Markdown, and TXT." },
      { status: 415 },
    );
  }

  const data = Buffer.from(await file.arrayBuffer());
  if (
    (format === "pdf" && data.subarray(0, 5).toString("ascii") !== "%PDF-") ||
    (format === "docx" &&
      !(data[0] === 0x50 && data[1] === 0x4b))
  ) {
    return Response.json(
      { error: "The file content does not match its file extension." },
      { status: 400 },
    );
  }

  let sections;
  try {
    sections = await parseDocument(format, data);
  } catch (error) {
    if (error instanceof DocumentParseError) {
      logFailure("rag.document.parse.failed", userId, error);
      return Response.json({ error: error.message }, { status: 422 });
    }
    logFailure("rag.document.parse.failed", userId, error);
    return Response.json(
      { error: "Unable to extract text from this document." },
      { status: 500 },
    );
  }

  if (sections.length === 0) {
    return Response.json(
      {
        error:
          "No readable text could be extracted. Check the PDF quality and local Tesseract language data.",
      },
      { status: 422 },
    );
  }

  const tokenCount = countDocumentTokens(sections);
  if (tokenCount > RAG_MAX_DOCUMENT_TOKENS) {
    return Response.json(
      { error: "Documents must contain 50,000 tokens or fewer." },
      { status: 413 },
    );
  }

  const chunks = chunkDocumentSections(sections);
  if (chunks.length > RAG_MAX_CHUNKS) {
    return Response.json(
      { error: "This document creates too many chunks to index at once." },
      { status: 413 },
    );
  }
  if (chunks.length === 0) {
    return Response.json(
      { error: "No usable text chunks could be created from this document." },
      { status: 422 },
    );
  }

  const sourceFile = file.name
    .replaceAll("\\", "/")
    .split("/")
    .at(-1)
    ?.replace(/[\u0000-\u001f\u007f]/g, "")
    .slice(0, 200);
  if (!sourceFile) {
    return Response.json({ error: "The file name is invalid." }, { status: 400 });
  }
  const mimeTypeByFormat = {
    pdf: "application/pdf",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    markdown: "text/markdown",
    text: "text/plain",
  } as const;
  const sha256 = createHash("sha256").update(data).digest("hex");
  const preview = sections
    .map((section) => section.text)
    .join("\n\n")
    .slice(0, 2_000);

  try {
    const existing = await findDocumentByHash(userId, sha256);
    if (existing) {
      return Response.json(
        {
          documentId: existing.id,
          sourceFile,
          chunkCount: existing.chunk_count,
          duplicate: true,
          extractedTextPreview: preview,
        },
        { status: 200 },
      );
    }

    const embeddings = await embedDocuments(
      chunks.map((chunk) => chunk.text),
    );
    const saved = await saveDocumentChunks({
      userId,
      sourceFile,
      mimeType: mimeTypeByFormat[format],
      sha256,
      chunks,
      embeddings,
    });

    return Response.json(
      {
        documentId: saved.documentId,
        sourceFile,
        chunkCount: saved.chunkCount,
        duplicate: saved.duplicate,
        extractedTextPreview: preview,
      },
      { status: saved.duplicate ? 200 : 201 },
    );
  } catch (error) {
    logFailure("rag.document.index.failed", userId, error);
    return Response.json(
      {
        error:
          "Unable to index this document with Gemini embeddings. Check server logs and retry.",
      },
      { status: 503 },
    );
  }
}
