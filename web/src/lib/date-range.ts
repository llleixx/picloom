export function localDate(value: Date) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}
export function dateBoundary(
  value: string,
  nextDay = false,
): number | undefined {
  if (!value) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Invalid date");
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(y!, m! - 1, d!);
  if (localDate(date) !== value || date.getTime() < 0)
    throw new Error("Invalid date");
  if (nextDay) date.setDate(date.getDate() + 1);
  return date.getTime();
}

export function localDayBoundaries(days: number, now = new Date()): number[] {
  return Array.from({ length: days + 1 }, (_, i) =>
    new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - days + 1 + i,
    ).getTime(),
  );
}
