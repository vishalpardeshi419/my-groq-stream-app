import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import type { DocumentSection } from "./chunking";
import { RAG_OCR_TIMEOUT_MS } from "./constants";
import {
  recognizeImageWithTesseract,
  TesseractExecutionError,
  TesseractOutputLimitError,
  TesseractTimeoutError,
  TesseractUnavailableError,
} from "./tesseract-ocr";

export type DocumentFormat = "pdf" | "docx" | "markdown" | "text";

export class DocumentParseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DocumentParseError";
  }
}

export function getDocumentFormat(filename: string): DocumentFormat | null {
  const extension = filename.split(".").at(-1)?.toLowerCase();
  switch (extension) {
    case "pdf":
      return "pdf";
    case "docx":
      return "docx";
    case "md":
    case "markdown":
      return "markdown";
    case "txt":
      return "text";
    default:
      return null;
  }
}

function normalizeText(text: string) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function markdownSections(text: string): DocumentSection[] {
  const sections: DocumentSection[] = [];
  let sectionTitle: string | null = null;
  let lines: string[] = [];

  const flush = () => {
    const normalized = normalizeText(lines.join("\n"));
    if (normalized) {
      sections.push({
        text: normalized,
        pageNumber: null,
        sectionTitle,
      });
    }
    lines = [];
  };

  for (const line of text.split(/\r?\n/)) {
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flush();
      sectionTitle = normalizeText(heading[1]);
      lines.push(line);
    } else {
      lines.push(line);
    }
  }
  flush();

  return sections;
}

function decodeHtmlEntities(text: string) {
  return text.replace(
    /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,
    (entity, value: string) => {
      const namedEntities: Record<string, string> = {
        amp: "&",
        apos: "'",
        gt: ">",
        lt: "<",
        nbsp: " ",
        quot: '"',
      };
      if (!value.startsWith("#")) {
        return namedEntities[value.toLowerCase()] ?? entity;
      }

      const codePoint = value.startsWith("#x")
        ? Number.parseInt(value.slice(2), 16)
        : Number.parseInt(value.slice(1), 10);
      return Number.isInteger(codePoint) && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : entity;
    },
  );
}

function htmlSections(html: string): DocumentSection[] {
  const sections: DocumentSection[] = [];
  const blockPattern = /<(h[1-6]|p|li|td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let sectionTitle: string | null = null;
  let lines: string[] = [];

  const flush = () => {
    const text = normalizeText(lines.join("\n"));
    if (text) {
      sections.push({ text, pageNumber: null, sectionTitle });
    }
    lines = [];
  };

  for (const match of html.matchAll(blockPattern)) {
    const blockTag = match[1].toLowerCase();
    const text = normalizeText(
      decodeHtmlEntities(match[2].replace(/<[^>]*>/g, " ")),
    );
    if (!text) continue;

    if (/^h[1-6]$/.test(blockTag)) {
      flush();
      sectionTitle = text;
    }
    lines.push(text);
  }
  flush();

  return sections;
}

class PdfProcessingTimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new PdfProcessingTimeoutError()),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function toPdfParseError(error: unknown) {
  if (error instanceof TesseractUnavailableError) {
    return new DocumentParseError(
      "This scanned PDF needs local Tesseract OCR. Install Tesseract and its configured language data, then retry.",
      { cause: error },
    );
  }
  if (
    error instanceof TesseractTimeoutError ||
    error instanceof PdfProcessingTimeoutError
  ) {
    return new DocumentParseError(
      "PDF text extraction and OCR exceeded the 2-minute processing limit. Split the document and retry.",
      { cause: error },
    );
  }
  if (error instanceof TesseractOutputLimitError) {
    return new DocumentParseError(
      "A scanned PDF page produced too much OCR text. Split the document and retry.",
      { cause: error },
    );
  }
  if (error instanceof TesseractExecutionError) {
    return new DocumentParseError(
      "Tesseract could not OCR this PDF. Check the installed language data and retry.",
      { cause: error },
    );
  }
  return new DocumentParseError(
    "Could not read this PDF. Ensure it is a valid, text-based or scanned PDF.",
    { cause: error },
  );
}

export async function parseDocument(
  format: DocumentFormat,
  data: Buffer,
): Promise<DocumentSection[]> {
  if (format === "pdf") {
    const parser = new PDFParse({ data: new Uint8Array(data) });
    const deadline = Date.now() + RAG_OCR_TIMEOUT_MS;
    try {
      const result = await withTimeout(
        parser.getText(),
        deadline - Date.now(),
      );
      const pageText = new Map(
        result.pages.map((page) => [page.num, normalizeText(page.text)]),
      );
      const pageCount = Math.max(
        result.total,
        ...result.pages.map((page) => page.num),
      );
      const sections: DocumentSection[] = [];

      for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
        const extractedText = pageText.get(pageNumber) ?? "";
        if (extractedText) {
          sections.push({
            text: extractedText,
            pageNumber,
            sectionTitle: null,
          });
          continue;
        }

        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) throw new PdfProcessingTimeoutError();
        const screenshot = await withTimeout(
          parser.getScreenshot({
            partial: [pageNumber],
            desiredWidth: 1_600,
            imageBuffer: true,
            imageDataUrl: false,
          }),
          remainingMs,
        );
        const image = screenshot.pages[0];
        if (!image) continue;

        const ocrText = await recognizeImageWithTesseract(
          Buffer.from(image.data),
          deadline - Date.now(),
        );
        const normalizedOcrText = normalizeText(ocrText);
        if (normalizedOcrText) {
          sections.push({
            text: normalizedOcrText,
            pageNumber,
            sectionTitle: null,
          });
        }
      }

      return sections;
    } catch (error) {
      throw toPdfParseError(error);
    } finally {
      await parser.destroy();
    }
  }

  if (format === "docx") {
    try {
      const result = await mammoth.convertToHtml(
        { buffer: data },
        { externalFileAccess: false },
      );
      return htmlSections(result.value);
    } catch {
      throw new DocumentParseError(
        "Could not extract text from this DOCX file.",
      );
    }
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw new DocumentParseError(
      "Text documents must use valid UTF-8 encoding.",
    );
  }

  return format === "markdown"
    ? markdownSections(text)
    : [
        {
          text: normalizeText(text),
          pageNumber: null,
          sectionTitle: null,
        },
      ].filter((section) => section.text.length > 0);
}
