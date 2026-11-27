"use client";

import { FormEvent, useState } from "react";

type UploadResult = {
  documentId: string;
  sourceFile: string;
  chunkCount: number;
  duplicate: boolean;
  extractedTextPreview: string;
};

type SearchResult = {
  chunk_id: string;
  document_id: string;
  source_file: string;
  page_number: number | null;
  section_title: string | null;
  content: string;
  token_count: number;
  similarity: number;
};

async function readJson(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

export function DocumentWorkspace() {
  const [file, setFile] = useState<File | null>(null);
  const [uploadResult, setUploadResult] = useState<UploadResult | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const [isSearching, setIsSearching] = useState(false);

  async function uploadDocument(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) return;

    setError("");
    setStatus("");
    setIsUploading(true);
    try {
      const formData = new FormData();
      formData.set("file", file);
      const response = await fetch("/api/documents", {
        method: "POST",
        body: formData,
      });
      const body = await readJson(response);
      if (!response.ok) {
        throw new Error(
          typeof body.error === "string"
            ? body.error
            : "Unable to index this document.",
        );
      }
      const indexed = body as UploadResult;
      setUploadResult(indexed);
      setStatus(
        indexed.duplicate
          ? "This file was already indexed for your account."
          : `Indexed ${indexed.chunkCount} chunks from ${indexed.sourceFile}.`,
      );
    } catch (uploadError) {
      setError(
        uploadError instanceof Error
          ? uploadError.message
          : "Unable to upload this document.",
      );
    } finally {
      setIsUploading(false);
    }
  }

  async function searchDocuments(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setStatus("");
    setIsSearching(true);
    try {
      const response = await fetch("/api/documents/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, topK: 5 }),
      });
      const body = await readJson(response);
      if (!response.ok) {
        throw new Error(
          typeof body.error === "string"
            ? body.error
            : "Unable to search your documents.",
        );
      }
      const found = body.results as SearchResult[];
      setResults(found);
      setStatus(
        found.length === 0
          ? "No chunks found yet. Upload a document, then try another query."
          : `Found ${found.length} matching chunks.`,
      );
    } catch (searchError) {
      setError(
        searchError instanceof Error
          ? searchError.message
          : "Unable to search your documents.",
      );
    } finally {
      setIsSearching(false);
    }
  }

  return (
    <div className="space-y-6">
      <section className="space-y-4 rounded-lg border border-zinc-200 p-5 dark:border-zinc-800">
        <h2 className="text-lg font-medium">Index a document</h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          PDF, DOCX, Markdown, or TXT; maximum 10 MB. Scanned PDFs use local Tesseract OCR.
        </p>
        <form onSubmit={uploadDocument} className="flex flex-col gap-3 sm:flex-row">
          <input
            aria-label="Document file"
            type="file"
            accept=".pdf,.docx,.md,.markdown,.txt"
            onChange={(event) => {
              setFile(event.currentTarget.files?.[0] ?? null);
              setUploadResult(null);
            }}
            className="min-w-0 flex-1 text-sm"
          />
          <button
            type="submit"
            disabled={!file || isUploading}
            className="rounded bg-blue-600 px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            {isUploading ? "Indexing…" : "Upload and index"}
          </button>
        </form>
        {uploadResult && (
          <details className="rounded bg-zinc-50 p-3 text-sm dark:bg-zinc-900">
            <summary className="cursor-pointer font-medium">
              Inspect extracted text preview
            </summary>
            <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap text-xs">
              {uploadResult.extractedTextPreview}
            </pre>
          </details>
        )}
      </section>

      <section className="space-y-4 rounded-lg border border-zinc-200 p-5 dark:border-zinc-800">
        <h2 className="text-lg font-medium">Search indexed chunks</h2>
        <form onSubmit={searchDocuments} className="flex gap-2">
          <input
            aria-label="Search query"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            maxLength={1_000}
            placeholder="Try: refund policy"
            className="min-w-0 flex-1 rounded border border-zinc-300 bg-transparent px-3 py-2 text-sm dark:border-zinc-700"
          />
          <button
            type="submit"
            disabled={!query.trim() || isSearching}
            className="rounded bg-zinc-900 px-4 py-2 text-sm text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          >
            {isSearching ? "Searching…" : "Search"}
          </button>
        </form>
        {results.length > 0 && (
          <ol className="space-y-3">
            {results.map((result) => (
              <li
                key={result.chunk_id}
                className="space-y-2 rounded bg-zinc-50 p-4 dark:bg-zinc-900"
              >
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-zinc-600 dark:text-zinc-400">
                  <span>{result.source_file}</span>
                  {result.page_number != null && (
                    <span>Page {result.page_number}</span>
                  )}
                  {result.section_title && <span>{result.section_title}</span>}
                  <span>Similarity {result.similarity.toFixed(3)}</span>
                </div>
                <p className="whitespace-pre-wrap text-sm">{result.content}</p>
              </li>
            ))}
          </ol>
        )}
      </section>

      {(error || status) && (
        <p
          role={error ? "alert" : "status"}
          className={
            error
              ? "text-sm text-red-600"
              : "text-sm text-emerald-700 dark:text-emerald-400"
          }
        >
          {error || status}
        </p>
      )}
    </div>
  );
}
