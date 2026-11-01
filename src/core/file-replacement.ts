import type { FileRecord, Repositories } from "../persistence/port";
import type { Organization } from "./organization";
import { publicPath } from "../infra/files";

/** Call within the transaction that accepts the replacement. */
export async function replaceFile(
  r: Repositories,
  organization: Organization,
  old: FileRecord,
  next: FileRecord,
  status: "ready" | "blocked" = "ready",
) {
  const path = publicPath(old.public_prefix, old.logical_key);
  const previous = next.status;
  next.public_prefix = old.public_prefix;
  next.logical_key = old.logical_key;
  next.owner_id = old.owner_id;
  next.guest_ip = old.guest_ip;
  next.status = status;
  old.logical_key = `.replaced/${crypto.randomUUID()}`;
  old.status = "deleting";
  await r.saveFile(old, "ready");
  await r.saveFile(next, previous);
  await organization.transfer(r, old.id, next.id);
  return { id: next.id, path };
}
