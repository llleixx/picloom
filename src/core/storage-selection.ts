import { AppError } from "./errors";
export function selectStorage<T extends { priority: number; weight: number }>(
  values: T[],
  strategy: "priority" | "weighted_random",
  random: () => number = Math.random,
): T {
  if (!values.length)
    throw new AppError("STORAGE_UNAVAILABLE", "可用存储实例不足", 503);
  if (strategy === "priority")
    return [...values].sort((a, b) => a.priority - b.priority)[0]!;
  const max = Math.max(...values.map((x) => x.weight));
  if (
    !Number.isFinite(max) ||
    max <= 0 ||
    values.some((x) => !Number.isFinite(x.weight) || x.weight <= 0)
  )
    throw new AppError("INVALID_WEIGHT", "存储权重无效");
  let n = random() * values.reduce((sum, x) => sum + x.weight / max, 0);
  return values.find((x) => (n -= x.weight / max) < 0) ?? values.at(-1)!;
}
