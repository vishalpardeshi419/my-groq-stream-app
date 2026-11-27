import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const MAX_OCR_OUTPUT_BYTES = 1_000_000;

export class TesseractUnavailableError extends Error {
  constructor() {
    super("Tesseract is not installed or is not available on PATH.");
    this.name = "TesseractUnavailableError";
  }
}

export class TesseractTimeoutError extends Error {
  constructor() {
    super("Tesseract OCR exceeded its processing timeout.");
    this.name = "TesseractTimeoutError";
  }
}

export class TesseractOutputLimitError extends Error {
  constructor() {
    super("Tesseract OCR output exceeded the per-page limit.");
    this.name = "TesseractOutputLimitError";
  }
}

export class TesseractExecutionError extends Error {
  constructor() {
    super("Tesseract OCR could not process the rendered PDF page.");
    this.name = "TesseractExecutionError";
  }
}

export function recognizeImageWithTesseract(image: Buffer, timeoutMs: number) {
  const language = process.env.TESSERACT_LANG?.trim() || "eng";
  if (!/^[a-zA-Z0-9_+-]+$/.test(language)) {
    throw new Error("TESSERACT_LANG contains unsupported characters.");
  }

  return new Promise<string>((resolve, reject) => {
    const child = spawn(
      "tesseract",
      ["stdin", "stdout", "-l", language, "quiet"],
      { stdio: ["pipe", "pipe", "ignore"] },
    );
    const decoder = new StringDecoder("utf8");
    let output = "";
    let outputBytes = 0;
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new TesseractTimeoutError());
    }, timeoutMs);

    function finish(error?: Error, value?: string) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(value ?? "");
    }

    child.once("error", (error: NodeJS.ErrnoException) => {
      finish(
        error.code === "ENOENT"
          ? new TesseractUnavailableError()
          : new TesseractExecutionError(),
      );
    });
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_OCR_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(new TesseractOutputLimitError());
        return;
      }
      output += decoder.write(chunk);
    });
    child.stdin.once("error", () => {
      finish(new TesseractExecutionError());
    });
    child.once("close", (code) => {
      output += decoder.end();
      if (code !== 0) {
        finish(new TesseractExecutionError());
        return;
      }
      finish(undefined, output.trim());
    });
    child.stdin.end(image);
  });
}
