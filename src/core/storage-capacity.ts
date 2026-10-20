import type { Repositories } from "../persistence/port";
import { AppError, requireValue } from "./errors";

export async function storageHasCapacity(
  r: Repositories,
  id: string,
  bytes: number,
  excludeReplicaId?: string,
) {
  const source = requireValue(await r.instance(id));
  const limit = source.max_storage_bytes;
  return (
    limit == null ||
    (await r.storageUsedBytes(id, excludeReplicaId)) <= limit - bytes
  );
}

export async function checkStorageCapacity(
  r: Repositories,
  id: string,
  bytes: number,
  excludeReplicaId?: string,
) {
  if (!(await storageHasCapacity(r, id, bytes, excludeReplicaId)))
    throw new AppError(
      "STORAGE_CAPACITY_EXCEEDED",
      "Storage source capacity exceeded",
      409,
    );
}
