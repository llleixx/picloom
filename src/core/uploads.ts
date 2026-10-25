import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Settings } from "../config";
import {
  entity,
  type Persistence,
  type UploadSession,
} from "../persistence/port";
import { publicPath, remove, writeStream } from "../infra/files";
import { hash, type Identity, type Auth } from "./auth";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Files } from "./files";
import { AppError } from "./errors";
import { InFlight, Mutex } from "./concurrency";
import { parseUploadParams } from "./request-params";

/** Transport staging only. Storage plugins receive the same complete file as before. */
export class Uploads {
  private locks = new Map<string, { mutex: Mutex; users: number }>();
  private inFlight = new InFlight();
  private partsInFlight = new InFlight();
  private partCounts = new Map<string, number>();
  private closing = false;
  private lastCleanup = 0;
  private root: string;
  constructor(
    private db: Persistence,
    private files: Files,
    private auth: Auth,
    private config: Settings,
  ) {
    this.root = join(config.root, "uploads");
  }
  private async locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
    if (this.closing)
      throw new AppError("UNAVAILABLE", "Service stopping", 503);
    const end = this.inFlight.enter(id);
    let entry = this.locks.get(id);
    if (!entry) {
      entry = { mutex: new Mutex(), users: 0 };
      this.locks.set(id, entry);
    }
    entry.users++;
    try {
      return await entry.mutex.run(fn);
    } finally {
      if (--entry.users === 0) this.locks.delete(id);
      end();
    }
  }
  private reservation(session: UploadSession) {
    const size = session.byte_size;
    return Math.max(
      size + this.config.partConcurrency * Math.min(size, session.part_size),
      2 * size,
    );
  }
  private key(id: string) {
    return "upload:" + id;
  }
  private async owned(id: string, key: string) {
    const session = await this.db.read((r) => r.uploadSession(id));
    if (
      !session ||
      !key ||
      !timingSafeEqual(
        Buffer.from(session.upload_key_hash, "hex"),
        Buffer.from(hash(key), "hex"),
      )
    )
      throw new AppError("NOT_FOUND", "Upload session not found", 404);
    if (session.expires_at <= Date.now())
      throw new AppError("UPLOAD_EXPIRED", "Upload session expired", 410);
    return session;
  }
  async create(
    input: Record<string, unknown>,
    identity: Identity | null,
    guestIp: string | null = null,
  ) {
    return this.locked("create", () =>
      this.createSession(input, identity, guestIp),
    );
  }
  private async createSession(
    input: Record<string, unknown>,
    identity: Identity | null,
    guestIp: string | null,
  ) {
    if (this.closing)
      throw new AppError("UNAVAILABLE", "Service stopping", 503);
    if (
      typeof input.size !== "number" ||
      (input.name !== undefined &&
        (typeof input.name !== "string" || input.name.length > 1024))
    )
      throw new AppError(
        "INVALID_INPUT",
        "Expected size and optional profileId and name",
      );
    const profileId = await this.auth.resolveUploadProfile(
      input.profileId,
      identity,
    );
    const params = parseUploadParams(
      input.params === undefined ? null : JSON.stringify(input.params),
    );
    await this.files.validateUpload(profileId, input.size, identity, guestIp);
    const uploadKey = randomBytes(32).toString("base64url");
    const owner = this.auth.uploadOwner(identity);
    const selection = await this.files.uploadOrganization(
      owner.ownerId,
      input.organization,
    );
    const session: UploadSession = {
      ...entity(),
      upload_key_hash: hash(uploadKey),
      guest_ip: owner.ownerId ? null : guestIp,
      owner_id: owner.ownerId,
      source_token_id: owner.sourceTokenId,
      profile_id: profileId,
      source_name: (input.name as string) ?? "image",
      params_json: params,
      organization_json: {
        tagIds: selection.tags.map((x) => x.id),
        collectionIds: selection.collections.map((x) => x.id),
      },
      byte_size: input.size,
      part_size: this.config.chunkPartBytes,
      status: "pending",
      file_id: crypto.randomUUID(),
      expires_at: Date.now() + this.config.uploadSessionTtlMs,
    };
    const reservation = this.key(session.id);
    this.files.temporary.reserve(reservation, this.reservation(session));
    try {
      await this.db.transaction(async (r) => {
        await this.auth.authorizeUpload(identity, profileId, r);
        const active = (await r.uploadSessions()).filter(
          (x) => x.status === "pending" || x.status === "completing",
        );
        if (active.length >= this.config.uploadSessionLimit)
          throw new AppError("UPLOAD_CAPACITY", "Upload staging is full", 503);
        await r.insertUploadSession(session);
      });
    } catch (error) {
      this.files.temporary.release(reservation);
      throw error;
    }
    return {
      id: session.id,
      uploadKey,
      partSize: session.part_size,
      expiresAt: session.expires_at,
    };
  }
  async progress(id: string, key: string) {
    const session = await this.owned(id, key);
    const parts = (await readdir(join(this.root, id)).catch(() => []))
      .filter((x) => /^\d+$/.test(x))
      .map(Number)
      .sort((a, b) => a - b);
    return {
      id: session.id,
      status: session.status,
      partSize: session.part_size,
      expiresAt: session.expires_at,
      parts,
    };
  }
  private exclusive<T>(id: string, fn: () => Promise<T>) {
    return this.locked(id, async () => {
      await this.partsInFlight.wait(id);
      return fn();
    });
  }
  async part(id: string, index: number, request: Request, key: string) {
    // Hold the session lock only for admission. Completion/cancellation wait for
    // admitted writes; different indices can stream concurrently.
    const { session, release } = await this.locked(id, async () => {
      const session = await this.owned(id, key);
      if (session.status !== "pending")
        throw new AppError(
          "UPLOAD_CLOSED",
          "Upload no longer accepts parts",
          409,
        );
      const active = this.partCounts.get(id) ?? 0;
      if (active >= this.config.partConcurrency)
        throw new AppError("BUSY", "Too many in-flight parts", 503);
      const reservationKey = this.key(id);
      this.files.temporary.reserve(
        reservationKey,
        Math.max(
          this.files.temporary.size(reservationKey),
          this.reservation(session),
        ),
      );
      this.partCounts.set(id, active + 1);
      const end = this.partsInFlight.enter(id);
      return {
        session,
        release: () => {
          const count = this.partCounts.get(id)! - 1;
          if (count) this.partCounts.set(id, count);
          else this.partCounts.delete(id);
          end();
        },
      };
    });
    try {
      return await this.locked(`${id}:${index}`, async () => {
        const count = Math.ceil(session.byte_size / session.part_size);
        if (
          !Number.isSafeInteger(index) ||
          index < 0 ||
          index >= count ||
          !request.body
        )
          throw new AppError("INVALID_INPUT", "Invalid part index or body");
        const expected = Math.min(
          session.part_size,
          session.byte_size - index * session.part_size,
        );
        const directory = join(this.root, session.id);
        await mkdir(directory, { recursive: true });
        const temp = join(directory, crypto.randomUUID() + ".tmp");
        try {
          const size = await writeStream(
            temp,
            request.body,
            expected,
            request.signal,
          );
          if (size !== expected)
            throw new AppError("INCOMPLETE", "Incorrect part size");
          await rename(temp, join(directory, String(index)));
        } finally {
          await remove(temp);
        }
      });
    } finally {
      release();
    }
  }
  private async result(session: UploadSession) {
    const file = await this.db.read((r) => r.file(session.file_id));
    if (!file || !["ready", "blocked"].includes(file.status))
      throw new AppError(
        "UPLOAD_CLOSED",
        "Uploaded file is no longer available",
        409,
      );
    return {
      id: file.id,
      url:
        this.config.imageOrigin +
        publicPath(file.public_prefix, file.logical_key),
    };
  }
  async complete(id: string, key: string, signal: AbortSignal) {
    const leave = this.files.temporary.enterUpload();
    try {
      return await this.exclusive(id, async () => {
        const session = await this.owned(id, key);
        if (session.status === "completed") return this.result(session);
        const identity = {
          ownerId: session.owner_id,
          sourceTokenId: session.source_token_id,
        };
        await this.auth.authorizeUpload(identity, session.profile_id);
        if (session.status !== "pending")
          throw new AppError(
            "UPLOAD_CLOSED",
            "Upload failed; start a new upload",
            409,
          );
        await this.files.validateUpload(
          session.profile_id,
          session.byte_size,
          identity,
          session.guest_ip,
        );
        const directory = join(this.root, session.id);
        const count = Math.ceil(session.byte_size / session.part_size);
        for (let index = 0; index < count; index++) {
          const info = await stat(join(directory, String(index))).catch(
            () => null,
          );
          if (
            info?.size !==
            Math.min(
              session.part_size,
              session.byte_size - index * session.part_size,
            )
          )
            throw new AppError("INCOMPLETE", "Upload parts are missing");
        }
        session.status = "completing";
        session.updated_at = Date.now();
        await this.db.transaction((r) => r.saveUploadSession(session));
        try {
          const combined = join(directory, "combined");
          async function* chunks() {
            for (let index = 0; index < count; index++)
              for await (const chunk of Bun.file(
                join(directory, String(index)),
              ).stream())
                yield chunk;
          }
          const iterator = chunks();
          const stream = new ReadableStream<Uint8Array>({
            async pull(controller) {
              const next = await iterator.next();
              if (next.done) controller.close();
              else controller.enqueue(next.value);
            },
            async cancel() {
              await iterator.return(undefined);
            },
          });
          await writeStream(combined, stream, session.byte_size, signal);
          for (let index = 0; index < count; index++)
            await remove(join(directory, String(index)));
          const inputPath = await this.files.temporary.takeSession(
            this.key(id),
            combined,
            session.byte_size,
          );
          this.files.temporary.release(this.key(id));
          const blob = Bun.file(inputPath);
          const result = await this.files.upload(
            {
              size: blob.size,
              name: session.source_name,
              stream: () => blob.stream(),
            },
            session.profile_id,
            identity,
            signal,
            session.params_json,
            session.file_id,
            session.guest_ip,
            inputPath,
            session.owner_id === null ? undefined : session.organization_json,
            true,
          );
          session.status = "completed";
          await this.db.transaction(async (r) => {
            if (await r.uploadSession(session.id))
              await r.saveUploadSession(session);
          });
          return result;
        } catch (error) {
          // Publication may have succeeded before the response/session update failed.
          const file = await this.db.read((r) => r.file(session.file_id));
          session.status =
            file && ["ready", "blocked"].includes(file.status)
              ? "completed"
              : "failed";
          await this.db.transaction(async (r) => {
            if (await r.uploadSession(session.id))
              await r.saveUploadSession(session);
          });
          if (session.status === "completed") return this.result(session);
          throw error;
        } finally {
          await rm(directory, { recursive: true, force: true });
          this.files.temporary.release(this.key(id));
        }
      });
    } finally {
      leave();
    }
  }
  async cancel(id: string, key: string) {
    return this.exclusive(id, async () => {
      const session = await this.owned(id, key);
      if (session.status === "completed")
        throw new AppError("UPLOAD_CLOSED", "Upload already completed", 409);
      await rm(join(this.root, session.id), { recursive: true, force: true });
      await this.db.transaction((r) => r.deleteUploadSession(id));
      this.files.temporary.release(this.key(id));
    });
  }
  async recover() {
    await mkdir(this.root, { recursive: true });
    const sessions = await this.db.read((r) => r.uploadSessions());
    for (const session of sessions) {
      if (session.status === "completing") {
        const file = await this.db.read((r) => r.file(session.file_id));
        session.status =
          file && ["ready", "blocked"].includes(file.status)
            ? "completed"
            : "failed";
        await this.db.transaction((r) => r.saveUploadSession(session));
      }
      const directory = join(this.root, session.id);
      if (session.status !== "pending")
        await rm(directory, { recursive: true, force: true });
      else
        for (const name of await readdir(directory).catch(() => []))
          if (name.endsWith(".tmp")) await remove(join(directory, name));
    }
    const known = new Set(sessions.map((x) => x.id));
    for (const name of await readdir(this.root))
      if (!known.has(name))
        await rm(join(this.root, name), { recursive: true, force: true });
    await this.cleanup(true);
    for (const session of await this.db.read((r) => r.uploadSessions()))
      if (session.status === "pending")
        this.files.temporary.restore(
          this.key(session.id),
          this.reservation(session),
        );
  }
  async cleanup(force = false) {
    if (this.closing || (!force && Date.now() - this.lastCleanup < 60_000))
      return;
    this.lastCleanup = Date.now();
    await this.db.transaction((r) =>
      r.clearDailyUploads(
        new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10),
      ),
    );
    for (const session of await this.db.read((r) => r.uploadSessions())) {
      if (session.expires_at > Date.now() || this.locks.has(session.id))
        continue;
      try {
        await this.exclusive(session.id, async () => {
          await rm(join(this.root, session.id), {
            recursive: true,
            force: true,
          });
          await this.db.transaction((r) => r.deleteUploadSession(session.id));
          this.files.temporary.release(this.key(session.id));
        });
      } catch {
        console.warn(
          JSON.stringify({
            event: "upload_cleanup_failed",
            sessionId: session.id,
          }),
        );
      }
    }
  }
  async close() {
    this.closing = true;
    await this.inFlight.drain();
    await this.partsInFlight.drain();
  }
}
