import { isSiteAdmin, canManageUser } from "../../shared/roles";
import {
  randomBytes,
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import { AppError, requireValue } from "./errors";
import {
  entity,
  type Persistence,
  type User,
  type Credential,
  type Repositories,
  type FileRecord,
} from "../persistence/port";
import type { Settings } from "../config";
export interface Identity {
  user: User;
  credential: Credential;
  kind: "session" | "token";
  hash: string;
}
export type UploadIdentity =
  | Identity
  | { ownerId: string | null; sourceTokenId: string | null }
  | null;
export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const normalize = (name: string) => name.trim().toLowerCase();
export class Auth {
  private rate = new Map<string, { count: number; until: number }>();
  constructor(
    private db: Persistence,
    private config: Settings,
  ) {}
  async initializeOnStartup(
    password?: string,
    username?: string,
  ): Promise<string | null> {
    if (await this.db.read((r) => r.userCount())) return null;
    const name = normalize(username ?? "") || "admin";
    if (!/^[a-z0-9_.-]{1,64}$/.test(name))
      throw new AppError(
        "INVALID_INPUT",
        "Initial Owner username must contain 1–64 letters, digits, underscores, dots or hyphens",
      );
    const generated = !password;
    const value = password || randomBytes(24).toString("base64url");
    const created = await this.initialize(name, value);
    return created && generated ? value : null;
  }
  async initialize(username: string, password: string) {
    if (!username.trim() || password.length < 6)
      throw new AppError(
        "INVALID_INPUT",
        "Username and password of at least 6 characters required",
      );
    const encoded = await Bun.password.hash(password, {
      algorithm: "argon2id",
    });
    return this.db.transaction(async (r) => {
      if (await r.userCount()) return false;
      await r.insertUser({
        ...entity(),
        username: normalize(username),
        password_hash: encoded,
        role: "owner",
        status: "active",
        max_upload_bytes: null,
        daily_upload_limit: null,
        default_upload_profile_id: null,
        auth_version: 1,
      });
      return true;
    });
  }
  async login(username: string, password: string, client: string) {
    const now = Date.now();
    for (const [k, v] of this.rate) if (v.until <= now) this.rate.delete(k);
    if (this.rate.size >= 1000 && !this.rate.has(client))
      throw new AppError("RATE_LIMIT", "Try again later", 429);
    const bucket = this.rate.get(client) ?? { count: 0, until: now + 60000 };
    this.rate.set(client, bucket);
    if (++bucket.count > 10)
      throw new AppError("RATE_LIMIT", "Try again later", 429);
    const user = await this.db.read((r) => r.userByName(normalize(username)));
    if (
      !user ||
      user.status !== "active" ||
      !(await Bun.password.verify(password, user.password_hash))
    )
      throw new AppError("UNAUTHORIZED", "Invalid login", 401);
    const secret = randomBytes(32).toString("base64url");
    const cred: Credential = {
      ...entity(),
      user_id: user.id,
      token_hash: hash(secret),
      auth_version: user.auth_version,
      expires_at: now + 7 * 86400000,
      revoked_at: null,
    };
    await this.db.transaction(async (r) => {
      const current = requireValue(await r.user(user.id));
      if (
        current.auth_version !== user.auth_version ||
        current.status !== "active"
      )
        throw new AppError("UNAUTHORIZED", "Account changed", 401);
      await r.insertCredential("session", cred);
    });
    return { secret, user };
  }
  async verify(
    r: Repositories,
    kind: Identity["kind"],
    digest: string,
  ): Promise<Identity> {
    const cred = await r.credential(kind, digest);
    const user = cred ? await r.user(cred.user_id) : null;
    if (
      !cred ||
      !user ||
      cred.revoked_at !== null ||
      (cred.expires_at !== null && cred.expires_at <= Date.now()) ||
      (kind === "session" && cred.auth_version !== user.auth_version) ||
      user.status !== "active"
    )
      throw new AppError("UNAUTHORIZED", "Authentication required", 401);
    return { user, credential: cred, kind, hash: digest };
  }
  async authenticate(req: Request, sessionOnly = false) {
    const bearer = req.headers.get("authorization");
    const cookie = req.headers
      .get("cookie")
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith("session="))
      ?.slice(8);
    const kind = bearer ? "token" : "session";
    const secret =
      bearer?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1] ??
      (!bearer ? cookie : undefined);
    if (!secret)
      throw new AppError("UNAUTHORIZED", "Authentication required", 401);
    if (sessionOnly && kind === "token")
      throw new AppError("FORBIDDEN", "Session required", 403);
    const identity = await this.db.read((r) =>
      this.verify(r, kind, hash(secret)),
    );
    if (kind === "session" && !["GET", "HEAD"].includes(req.method)) {
      const actual = req.headers.get("x-csrf-token") ?? "";
      const expected = this.csrf(identity.hash);
      if (
        actual.length !== expected.length ||
        !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
      )
        throw new AppError("CSRF", "Invalid CSRF token", 403);
    }
    return identity;
  }
  csrf(digest: string) {
    return createHmac("sha256", Buffer.from(this.config.encryptionKey, "hex"))
      .update("csrf:" + digest)
      .digest("hex");
  }
  cookie(secret: string, clear = false, requestOrigin = "") {
    return `session=${secret}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${clear ? 0 : 604800}${(this.config.origin ? this.config.secureCookie : requestOrigin.startsWith("https://")) ? "; Secure" : ""}`;
  }
  uploadOwner(identity: UploadIdentity) {
    return identity && "user" in identity
      ? {
          ownerId: identity.user.id,
          sourceTokenId:
            identity.kind === "token" ? identity.credential.id : null,
        }
      : (identity ?? { ownerId: null, sourceTokenId: null });
  }
  async optional(req: Request, sessionOnly = false) {
    const hasCredentials =
      req.headers.has("authorization") ||
      /(?:^|;\s*)session=/.test(req.headers.get("cookie") ?? "");
    return hasCredentials ? this.authenticate(req, sessionOnly) : null;
  }
  requireAdmin(identity: Identity) {
    if (!isSiteAdmin(identity.user.role) || identity.kind !== "session")
      throw new AppError("FORBIDDEN", "Administrator session required", 403);
  }
  assertFile(identity: Identity, file: FileRecord) {
    if (!isSiteAdmin(identity.user.role) && file.owner_id !== identity.user.id)
      throw new AppError("NOT_FOUND", "File not found", 404);
  }
  private async permittedProfiles(r: Repositories, identity: Identity | null) {
    const grants = identity ? await r.userProfiles(identity.user.id) : [];
    return (await r.profiles()).filter(
      (p) =>
        (isSiteAdmin(identity?.user.role) ||
          p.allow_guest_upload ||
          grants.includes(p.id)) &&
        (identity?.kind !== "token" ||
          identity.credential.allowed_profile_ids == null ||
          identity.credential.allowed_profile_ids.includes(p.id)),
    );
  }
  async allowedProfiles(identity: Identity | null) {
    return this.db.read(async (r) => {
      const current = identity
        ? await this.verify(r, identity.kind, identity.hash)
        : null;
      return this.permittedProfiles(r, current);
    });
  }
  async uploadDefaults(
    identity: Identity | null,
  ): Promise<import("../../shared/api").UploadDefaults> {
    return this.db.read(async (r) => {
      const current = identity
        ? await this.verify(r, identity.kind, identity.hash)
        : null;
      const visible = await this.permittedProfiles(r, current);
      const site = (await r.profiles()).find((p) => p.is_default);
      const userDefaultProfileId =
        current?.user.default_upload_profile_id ?? null;
      return {
        userDefaultProfileId,
        siteDefaultProfileId: visible.find((p) => p.is_default)?.id ?? null,
        defaultProfileId: userDefaultProfileId ?? site?.id ?? null,
      };
    });
  }
  async resolveUploadProfile(
    value: unknown,
    identity: Identity | null,
  ): Promise<string> {
    if (value !== undefined) {
      if (typeof value !== "string" || !value.trim())
        throw new AppError("INVALID_INPUT", "Expected a non-empty profileId");
      await this.authorizeUpload(identity, value);
      return value;
    }
    const id = (await this.uploadDefaults(identity)).defaultProfileId;
    if (!id)
      throw new AppError(
        "DEFAULT_PROFILE_REQUIRED",
        "Select an upload profile",
        400,
      );
    await this.authorizeUpload(identity, id);
    return id;
  }
  async setDefaultProfile(identity: Identity, value: unknown, site = false) {
    if (value !== null && (typeof value !== "string" || !value.trim()))
      throw new AppError("INVALID_INPUT", "Expected profileId or null");
    await this.db.transaction(async (r) => {
      const current = await this.verify(r, identity.kind, identity.hash);
      if (current.kind !== "session")
        throw new AppError("FORBIDDEN", "Session required", 403);
      if (site) this.requireAdmin(current);
      if (value !== null) {
        const profile = await r.profile(value as string);
        if (!profile?.enabled)
          throw new AppError("INVALID_INPUT", "Upload profile unavailable");
        await this.authorizeUpload(current, profile.id, r);
      }
      if (site) await r.setSiteDefaultProfile(value as string | null);
      else
        await r.setUserDefaultProfile(current.user.id, value as string | null);
    });
  }
  async authorizeUpload(
    identity: UploadIdentity,
    profileId: string,
    repositories?: Repositories,
  ): Promise<void> {
    const check = async (r: Repositories) => {
      if (identity && "user" in identity)
        await this.verify(r, identity.kind, identity.hash);
      const source = this.uploadOwner(identity);
      const profile = await r.profile(profileId);
      if (!profile)
        throw new AppError("FORBIDDEN", "Upload profile unavailable", 403);
      if (source.ownerId === null) {
        if (!profile.allow_guest_upload)
          throw new AppError("FORBIDDEN", "Guest uploads are not allowed", 403);
        return;
      }
      const user = await r.user(source.ownerId);
      if (!user || user.status !== "active")
        throw new AppError("FORBIDDEN", "Account unavailable", 403);
      if (
        !isSiteAdmin(user.role) &&
        !profile.allow_guest_upload &&
        !(await r.userProfiles(user.id)).includes(profileId)
      )
        throw new AppError("FORBIDDEN", "Upload profile not allowed", 403);
      if (source.sourceTokenId !== null) {
        const token = await r.tokenById(source.sourceTokenId);
        if (
          !token ||
          token.user_id !== user.id ||
          token.revoked_at !== null ||
          (token.expires_at !== null && token.expires_at <= Date.now())
        )
          throw new AppError("FORBIDDEN", "Upload token unavailable", 403);
        if (
          token.allowed_profile_ids !== null &&
          token.allowed_profile_ids !== undefined &&
          !token.allowed_profile_ids.includes(profileId)
        )
          throw new AppError(
            "FORBIDDEN",
            "Token cannot use this upload profile",
            403,
          );
      }
    };
    return repositories ? check(repositories) : this.db.read(check);
  }
  async uploadLimits(identity: UploadIdentity, repositories?: Repositories) {
    const owner = this.uploadOwner(identity).ownerId;
    const read = async (r: Repositories) => {
      const user = owner ? requireValue(await r.user(owner)) : null;
      return {
        maxBytes: Math.min(
          this.config.maxUploadBytes,
          (user ? user.max_upload_bytes : this.config.guestMaxUploadBytes) ??
            Infinity,
        ),
        daily:
          (user
            ? user.daily_upload_limit
            : this.config.guestDailyUploadLimit) ?? null,
      };
    };
    return repositories ? read(repositories) : this.db.read(read);
  }
  async checkUploadQuota(
    identity: UploadIdentity,
    size: number,
    guestIp: string | null,
  ) {
    return this.db.read(async (r) => {
      const limits = await this.uploadLimits(identity, r);
      if (size > limits.maxBytes)
        throw new AppError("TOO_LARGE", "File exceeds upload limit", 413);
      const owner = this.uploadOwner(identity).ownerId;
      if (!owner && !guestIp)
        throw new AppError("INVALID_INPUT", "Guest IP is required");
      const subject = owner ? "u:" + owner : "g:" + guestIp;
      const day = new Date().toISOString().slice(0, 10);
      const allowed =
        limits.daily === null ||
        (await r.dailyUploadCount(subject, day)) < limits.daily;
      if (!allowed)
        throw new AppError(
          "DAILY_UPLOAD_LIMIT",
          "Daily upload limit reached",
          429,
        );
    });
  }
  async recordSuccessfulUpload(
    identity: UploadIdentity,
    guestIp: string | null,
    r: Repositories,
  ) {
    const owner = this.uploadOwner(identity).ownerId;
    await r.recordSuccessfulUpload(
      owner ? "u:" + owner : "g:" + guestIp,
      new Date().toISOString().slice(0, 10),
    );
  }
  async listUsers(limit: number, offset: number, q = "", status = "") {
    return this.db.read(async (r) => {
      const users = await r.users(limit, offset, q, status);
      const profiles = await r.profilesForUsers(users.map((u) => u.id));
      return {
        items: users.map((u) => ({
          id: u.id,
          username: u.username,
          maxUploadBytes: u.max_upload_bytes,
          dailyUploadLimit: u.daily_upload_limit,
          role: u.role,
          status: u.status,
          createdAt: u.created_at,
          profileIds: profiles.get(u.id) ?? [],
        })),
        total: await r.countUsers(q, status),
      };
    });
  }
  private assertManageUser(
    actor: Identity,
    target: User | null,
    role?: User["role"],
  ) {
    if (target?.role === "owner")
      throw new AppError(
        "FORBIDDEN",
        "Owner account is managed from Account settings",
        403,
      );
    if (
      actor.user.role === "admin" &&
      ((target && !canManageUser(actor.user.role, target.role)) ||
        (role && role !== "member"))
    )
      throw new AppError(
        "FORBIDDEN",
        "Administrators can only manage members",
        403,
      );
  }
  async saveUser(actor: Identity, input: Record<string, unknown>, id?: string) {
    this.requireAdmin(actor);
    const role = input.role,
      status = input.status ?? "active",
      profiles = input.profileIds ?? [];
    if (
      !["admin", "member"].includes(String(role)) ||
      !["active", "disabled"].includes(String(status)) ||
      !Array.isArray(profiles) ||
      profiles.length > 1000 ||
      profiles.some((x) => typeof x !== "string") ||
      new Set(profiles).size !== profiles.length
    )
      throw new AppError("INVALID_INPUT", "Invalid user settings");
    const maxBytes = input.maxUploadBytes ?? null,
      dailyLimit = input.dailyUploadLimit ?? null;
    if (
      (maxBytes !== null &&
        (!Number.isSafeInteger(maxBytes) || Number(maxBytes) <= 0)) ||
      (dailyLimit !== null &&
        (!Number.isSafeInteger(dailyLimit) || Number(dailyLimit) < 0))
    )
      throw new AppError("INVALID_INPUT", "Invalid upload limits");
    let password: string | undefined;
    if (!id) {
      if (
        typeof input.username !== "string" ||
        !/^[a-zA-Z0-9_.-]{1,64}$/.test(input.username.trim()) ||
        typeof input.password !== "string" ||
        input.password.length < 6
      )
        throw new AppError(
          "INVALID_INPUT",
          "Use a valid username and password of at least 6 characters",
        );
      password = await Bun.password.hash(input.password, {
        algorithm: "argon2id",
      });
    }
    return this.db.transaction(async (r) => {
      const current = await this.verify(r, actor.kind, actor.hash);
      this.requireAdmin(current);
      const previous = id ? requireValue(await r.user(id)) : null;
      this.assertManageUser(current, previous, role as User["role"]);
      for (const profile of profiles)
        if (!(await r.profile(profile as string)))
          throw new AppError("INVALID_INPUT", "Upload profile not found");
      const user = previous ?? {
        ...entity(),
        username: normalize(input.username as string),
        password_hash: password!,
        role: role as User["role"],
        status: status as User["status"],
        max_upload_bytes: null,
        daily_upload_limit: null,
        default_upload_profile_id: null,
        auth_version: 1,
      };
      if (previous)
        await r.updateUser(
          user.id,
          role as User["role"],
          status as User["status"],
        );
      else await r.insertUser(user);
      await r.setUserUploadLimits(
        user.id,
        maxBytes as number | null,
        dailyLimit as number | null,
      );
      if (status === "disabled") await r.revokeUserCredentials(user.id);
      await r.replaceUserProfiles(
        user.id,
        role === "admin" ? [] : (profiles as string[]),
      );
      return { id: user.id };
    });
  }
  private async encodePassword(password: string) {
    if (password.length < 6)
      throw new AppError(
        "INVALID_INPUT",
        "Password must contain at least 6 characters",
      );
    return Bun.password.hash(password, { algorithm: "argon2id" });
  }
  async recoverOwnerPassword(password: string) {
    const encoded = await this.encodePassword(password);
    return this.db.transaction(async (r) => {
      const owners = await r.owners();
      if (owners.length !== 1)
        throw new AppError(
          "INVALID_INPUT",
          "Expected exactly one Owner account",
        );
      const owner = owners[0]!;
      await r.changePassword(owner.id, owner.auth_version, encoded);
      return owner.username;
    });
  }
  async resetPassword(actor: Identity, id: string, password: string) {
    this.requireAdmin(actor);
    const encoded = await this.encodePassword(password);
    await this.db.transaction(async (r) => {
      const current = await this.verify(r, actor.kind, actor.hash);
      this.requireAdmin(current);
      const user = requireValue(await r.user(id));
      this.assertManageUser(current, user);
      await r.changePassword(id, user.auth_version, encoded);
    });
  }
  async token(
    identity: Identity,
    name: string,
    expiresAt: unknown = Date.now() + 90 * 86400000,
    profileIds: unknown = null,
  ) {
    if (
      expiresAt !== null &&
      (typeof expiresAt !== "number" ||
        !Number.isSafeInteger(expiresAt) ||
        expiresAt <= Date.now() ||
        expiresAt > 8640000000000000)
    )
      throw new AppError(
        "INVALID_INPUT",
        "Expiration must be a future UTC timestamp",
      );
    if (
      profileIds !== null &&
      (!Array.isArray(profileIds) ||
        !profileIds.length ||
        profileIds.length > 100 ||
        profileIds.some((id) => typeof id !== "string") ||
        new Set(profileIds).size !== profileIds.length)
    )
      throw new AppError(
        "INVALID_INPUT",
        "Select one or more distinct upload profiles",
      );
    if (!name.trim() || name.length > 100)
      throw new AppError("INVALID_INPUT", "Invalid token name");
    const secret = randomBytes(32).toString("base64url");
    const value: Credential = {
      ...entity(),
      user_id: identity.user.id,
      token_hash: hash(secret),
      expires_at: expiresAt,
      allowed_profile_ids: profileIds as string[] | null,
      revoked_at: null,
      name,
      token_hint: secret.slice(-6),
    };
    await this.db.transaction(async (r) => {
      await this.verify(r, identity.kind, identity.hash);
      for (const id of value.allowed_profile_ids ?? []) {
        if (!(await r.profile(id)))
          throw new AppError("INVALID_INPUT", "Upload profile not found");
        await this.authorizeUpload(identity, id, r);
      }
      await r.insertCredential("token", value);
    });
    return { id: value.id, token: secret, expiresAt: value.expires_at };
  }
  async password(identity: Identity, oldPassword: string, password: string) {
    const value = await this.encodePassword(password);
    if (!(await Bun.password.verify(oldPassword, identity.user.password_hash)))
      throw new AppError("INCORRECT_PASSWORD", "Incorrect password", 400);
    await this.db.transaction(async (r) => {
      await this.verify(r, identity.kind, identity.hash);
      await r.changePassword(
        identity.user.id,
        identity.user.auth_version,
        value,
      );
    });
  }
}
