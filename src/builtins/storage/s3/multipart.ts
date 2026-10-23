import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  type CreateMultipartUploadCommandInput,
  type CompletedPart,
} from "@aws-sdk/client-s3";
import {
  PluginError,
  isPluginError,
  type FileInput,
  type Context,
} from "@picloom/plugin-sdk";

// Keep only one batch of parts in memory; no durable multipart session is needed.
export async function multipartWrite(
  client: S3Client,
  input: CreateMultipartUploadCommandInput,
  file: FileInput,
  partSize: number,
  concurrency: number,
  ctx: Context,
) {
  const size = file.metadata.byteSize!;
  if (Math.ceil(size / partSize) > 10000)
    throw new PluginError(
      "RESOURCE_LIMIT",
      "Increase part size: upload exceeds 10,000 parts",
      false,
    );
  const signal = ctx.signal;
  let uploadId: string | undefined;
  let completing = false;
  let completed = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let pending: Promise<void>[] = [];
  let failure: unknown;
  const parts: CompletedPart[] = [];
  const cancel = () => {
    void reader?.cancel(signal.reason).catch(() => {});
  };
  try {
    signal.throwIfAborted();
    const created = await client.send(new CreateMultipartUploadCommand(input), {
      abortSignal: signal,
    });
    uploadId = created.UploadId;
    if (!uploadId)
      throw new PluginError("INVALID_DATA", "Missing multipart upload ID");
    reader = (await file.openRead()).getReader();
    signal.addEventListener("abort", cancel, { once: true });
    let buffer = Buffer.alloc(Math.min(partSize, size)),
      offset = 0,
      total = 0,
      number = 0;
    const flush = async () => {
      signal.throwIfAborted();
      const body = buffer.subarray(0, offset),
        PartNumber = ++number;
      pending.push(
        client
          .send(
            new UploadPartCommand({
              Bucket: input.Bucket,
              Key: input.Key,
              UploadId: uploadId,
              PartNumber,
              Body: body,
              ContentLength: body.length,
            }),
            { abortSignal: signal },
          )
          .then((result) => {
            if (!result.ETag)
              throw new PluginError("INVALID_DATA", "Missing part ETag");
            parts.push({ PartNumber, ETag: result.ETag });
          })
          .catch((error) => {
            failure ??= error;
          }),
      );
      if (pending.length >= concurrency) {
        await Promise.all(pending);
        pending = [];
        if (failure) throw failure;
      }
    };
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.length > size)
        throw new PluginError("INVALID_DATA", "Unexpected stream size");
      let pos = 0;
      while (pos < value.length) {
        signal.throwIfAborted();
        const count = Math.min(buffer.length - offset, value.length - pos);
        buffer.set(value.subarray(pos, pos + count), offset);
        offset += count;
        pos += count;
        total += count;
        if (offset === buffer.length) {
          await flush();
          offset = 0;
          buffer = Buffer.alloc(Math.min(partSize, size - total));
        }
      }
    }
    if (total !== size)
      throw new PluginError("INVALID_DATA", "Unexpected stream size");
    if (offset) await flush();
    await Promise.all(pending);
    if (failure) throw failure;
    signal.throwIfAborted();
    completing = true;
    const result = await client.send(
      new CompleteMultipartUploadCommand({
        Bucket: input.Bucket,
        Key: input.Key,
        UploadId: uploadId,
        IfNoneMatch: "*",
        MultipartUpload: {
          Parts: parts.sort((a, b) => a.PartNumber! - b.PartNumber!),
        },
      }),
      { abortSignal: signal },
    );
    if (!result.ETag)
      throw new PluginError("INVALID_DATA", "Missing completed object ETag");
    completed = true;
  } catch (error) {
    if (isPluginError(error) || completing) throw error; // The caller handles conditional completion and retryable failures.
    const status = (error as { $metadata?: { httpStatusCode?: number } })
      .$metadata?.httpStatusCode;
    throw new PluginError(
      status === 401 || status === 403
        ? "ACCESS_DENIED"
        : status === 429
          ? "RATE_LIMITED"
          : status === undefined
            ? "NETWORK"
            : "SERVICE",
      "S3 multipart upload failed",
      status === undefined || status === 408 || status === 429 || status >= 500,
    );
  } finally {
    await Promise.all(pending);
    signal.removeEventListener("abort", cancel);
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
    if (uploadId && !completed) {
      try {
        await client.send(
          new AbortMultipartUploadCommand({
            Bucket: input.Bucket,
            Key: input.Key,
            UploadId: uploadId,
          }),
          { abortSignal: AbortSignal.timeout(10000) },
        );
      } catch {
        ctx.log("s3_multipart_cleanup_failed");
      }
    }
  }
}
