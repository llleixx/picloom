export type UserRole = "owner" | "admin" | "member";
export const isSiteAdmin = (role: UserRole | undefined) =>
  role === "owner" || role === "admin";
export const canManageUser = (actor: UserRole | undefined, target: UserRole) =>
  target !== "owner" &&
  (actor === "owner" || (actor === "admin" && target === "member"));
