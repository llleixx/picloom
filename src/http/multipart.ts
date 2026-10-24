import Busboy, { type BusboyInstance } from "@fastify/busboy";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { AppError } from "../core/errors";
import type { TemporarySpace } from "../infra/temporary-space";

const bufferBytes = 64 * 1024;
const fieldNames = new Set(["file", "profileId", "params", "organization"]);
const invalid = () => new AppError("INVALID_INPUT", "Invalid multipart upload");
const tooLarge = () =>
  new AppError("TOO_LARGE", "Upload exceeds size limit", 413);

/** Owns the temporary file until the complete request has been received. */
export async function receiveMultipart(
  req: Request,
  temporary: TemporarySpace,
  maximum: number,
) {
  const contentType = req.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data\s*(?:;|$)/i.test(contentType) || !req.body)
    throw invalid();
  req.signal.throwIfAborted();
  const rawLength = req.headers.get("content-length");
  const length =
    rawLength !== null && /^\d+$/.test(rawLength) ? Number(rawLength) : NaN;
  const knownLength = Number.isSafeInteger(length) && length >= 0;
  if (knownLength && length > maximum + bufferBytes) throw tooLarge();

  let parser: BusboyInstance;
  try {
    parser = new Busboy({
      headers: { "content-type": contentType },
      highWaterMark: bufferBytes,
      fileHwm: bufferBytes,
      isPartAFile: (_name, _type, filename) => filename !== undefined,
      limits: { fileSize: maximum, fieldSize: bufferBytes },
    });
  } catch {
    throw invalid();
  }
  const path = temporary.create(knownLength ? Math.min(length, maximum) : 0);
  const fields: Record<string, string> = Object.create(null);
  const seen = new Set<string>();
  const files = new Set<Readable>();
  let name: string | undefined;
  let size = 0;
  let writing: Promise<void> | undefined;
  let failure: Error | undefined;
  const controller = new AbortController();
  const source = Readable.fromWeb(
    req.body as unknown as Parameters<typeof Readable.fromWeb>[0],
    { highWaterMark: bufferBytes },
  );
  let received = 0;
  const counter = new Transform({
    highWaterMark: bufferBytes,
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.byteLength;
      callback(received > maximum + bufferBytes ? tooLarge() : null, chunk);
    },
  });
  function fail(error: Error) {
    if (failure) return;
    failure = error;
    controller.abort(error);
    // The pipeline owns its three nodes; file parts are separate streams.
    for (const file of files) file.destroy(error);
  }
  function claim(key: string) {
    if (!fieldNames.has(key)) return false;
    if (seen.has(key)) {
      fail(
        new AppError(
          key === "params" ? "INVALID_PARAMS" : "INVALID_INPUT",
          `Repeated ${key} field`,
        ),
      );
      return false;
    }
    seen.add(key);
    return true;
  }
  parser.on("error", (error: Error) =>
    fail(error instanceof AppError ? error : invalid()),
  );
  parser.on("field", (key, value, _nameTruncated, truncated) => {
    if (failure) return;
    if (truncated) return fail(tooLarge());
    if (!claim(key)) return;
    if (key === "file") return fail(invalid());
    fields[key] = value;
  });
  parser.on("file", (key, file, filename) => {
    files.add(file);
    file.once("end", () => files.delete(file));
    file.once("close", () => files.delete(file));
    // Parser errors are handled above; file read/write errors reach writing.catch.
    // Cancelling a failed writer can emit a secondary error before it rejects.
    file.on("error", () => {});
    file.on("limit", () => fail(tooLarge()));
    if (failure) {
      file.destroy(failure);
      return;
    }
    if (!claim(key)) {
      file.resume();
      return;
    }
    if (key !== "file") {
      fail(
        new AppError(
          key === "params" ? "INVALID_PARAMS" : "INVALID_INPUT",
          "Expected text field",
        ),
      );
      return;
    }
    name = filename;
    const stream = Readable.toWeb(file, {
      strategy: {
        highWaterMark: bufferBytes,
        size: (chunk) => chunk.byteLength,
      },
    }) as unknown as ReadableStream<Uint8Array>;
    writing = temporary
      .write(path, stream, maximum, controller.signal)
      .then((bytes) => {
        size = bytes;
        if (file.truncated) fail(tooLarge());
      })
      .catch((error: Error) => {
        fail(error);
      });
  });
  const abort = () =>
    fail(
      req.signal.reason instanceof Error
        ? req.signal.reason
        : new Error("Upload aborted"),
    );
  // Install pipeline error handlers before reacting to an already-aborted request.
  const parsing = pipeline(source, counter, parser, {
    signal: controller.signal,
  }).catch((error: Error) => {
    fail(error instanceof AppError ? error : invalid());
  });
  req.signal.addEventListener("abort", abort, { once: true });
  if (req.signal.aborted) abort();
  try {
    await parsing;
    await writing;
    if (failure) throw failure;
    if (name === undefined) throw invalid();
    return { path, name, size, fields };
  } catch (error) {
    await temporary.remove(path);
    throw error;
  } finally {
    req.signal.removeEventListener("abort", abort);
  }
}
