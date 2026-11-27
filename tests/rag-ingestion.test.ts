import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import {
  chunkDocumentSections,
  countDocumentTokens,
} from "../lib/rag/chunking";
import {
  DocumentParseError,
  getDocumentFormat,
  parseDocument,
} from "../lib/rag/parse-document";
import { recognizeImageWithTesseract } from "../lib/rag/tesseract-ocr";

function createTextImage(text: string) {
  const font: Record<string, string[]> = {
    D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
    E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
    F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
    N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
    R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
    U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  };
  const scale = 20;
  const margin = 30;
  const width = text.length * 6 * scale + margin * 2;
  const height = 7 * scale + margin * 2;
  const pixels = Buffer.alloc(width * height, 255);

  for (const [charIndex, char] of [...text].entries()) {
    for (const [rowIndex, row] of font[char].entries()) {
      for (const [columnIndex, pixel] of [...row].entries()) {
        if (pixel !== "1") continue;
        const x = margin + (charIndex * 6 + columnIndex) * scale;
        const y = margin + rowIndex * scale;
        for (let dy = 0; dy < scale; dy += 1) {
          pixels.fill(0, (y + dy) * width + x, (y + dy) * width + x + scale);
        }
      }
    }
  }

  return { width, height, pixels };
}

function createScannedPdf(text: string) {
  const image = createTextImage(text);
  const compressedPixels = deflateSync(image.pixels);
  const content = Buffer.from("q\n612 0 0 160 0 632 cm\n/Im1 Do\nQ\n");
  const objects = [
    Buffer.from("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
    Buffer.from("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"),
    Buffer.from(
      "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
    ),
    Buffer.concat([
      Buffer.from(
        `4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${compressedPixels.length} >>\nstream\n`,
      ),
      compressedPixels,
      Buffer.from("\nendstream\nendobj\n"),
    ]),
    Buffer.concat([
      Buffer.from(
        `5 0 obj\n<< /Length ${content.length} >>\nstream\n`,
      ),
      content,
      Buffer.from("endstream\nendobj\n"),
    ]),
  ];
  const header = Buffer.from("%PDF-1.4\n");
  let offset = header.length;
  const offsets = objects.map((object) => {
    const objectOffset = offset;
    offset += object.length;
    return objectOffset;
  });
  const xrefOffset = offset;
  const xref = Buffer.from(
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
      .map((objectOffset) => `${String(objectOffset).padStart(10, "0")} 00000 n \n`)
      .join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
  );

  return Buffer.concat([header, ...objects, xref]);
}

test("chunks preserve page and heading metadata with bounded overlap", () => {
  const text = Array.from({ length: 1_200 }, (_, index) => `word${index}`).join(
    " ",
  );
  const chunks = chunkDocumentSections([
    { text, pageNumber: 3, sectionTitle: "Returns" },
  ]);

  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.tokenCount <= 500));
  assert.deepEqual(
    chunks.map((chunk) => chunk.chunkIndex),
    chunks.map((_, index) => index),
  );
  assert.ok(chunks.every((chunk) => chunk.pageNumber === 3));
  assert.ok(chunks.every((chunk) => chunk.sectionTitle === "Returns"));

  assert.ok(chunks[1].text.includes(chunks[0].text.slice(-50)));
  assert.ok(countDocumentTokens([{ text, pageNumber: null, sectionTitle: null }]) > 500);
});

test("Markdown headings are preserved as section metadata", async () => {
  const sections = await parseDocument(
    "markdown",
    Buffer.from("# Refunds\nRefunds are available within 30 days.\n\n## Exceptions\nDigital items are excluded."),
  );

  assert.equal(sections.length, 2);
  assert.equal(sections[0].sectionTitle, "Refunds");
  assert.match(sections[0].text, /Refunds are available within 30 days/);
  assert.equal(sections[1].sectionTitle, "Exceptions");
});

test("text extraction rejects invalid UTF-8 and unsupported file types", async () => {
  assert.equal(getDocumentFormat("handbook.PDF"), "pdf");
  assert.equal(getDocumentFormat("archive.doc"), null);
  await assert.rejects(
    parseDocument("text", Buffer.from([0xc3, 0x28])),
    DocumentParseError,
  );
});

test("PDF parse failures preserve their underlying cause for diagnostics", async () => {
  await assert.rejects(
    parseDocument("pdf", Buffer.from("%PDF-invalid")),
    (error: unknown) => {
      assert.ok(error instanceof DocumentParseError);
      assert.ok(error.cause instanceof Error);
      return true;
    },
  );
});

const tesseractAvailable =
  spawnSync("tesseract", ["--version"], { stdio: "ignore" }).status === 0;

test(
  "local Tesseract extracts text from a scanned page image",
  { skip: tesseractAvailable ? false : "Tesseract is not installed" },
  async () => {
    const { width, height, pixels } = createTextImage("REFUND");
    const text = await recognizeImageWithTesseract(
      Buffer.concat([
        Buffer.from(`P5\n${width} ${height}\n255\n`),
        pixels,
      ]),
      15_000,
    );
    assert.match(text, /REFUND/i);
  },
);

test(
  "scanned PDFs are rendered and OCR text keeps its page number",
  { skip: tesseractAvailable ? false : "Tesseract is not installed" },
  async () => {
    const sections = await parseDocument("pdf", createScannedPdf("REFUND"));

    assert.equal(sections.length, 1);
    assert.equal(sections[0].pageNumber, 1);
    assert.match(sections[0].text, /REFUND/i);
  },
);
