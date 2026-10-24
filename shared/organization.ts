export interface FileOrigin {
  kind: "upload" | "import";
  userId: string | null;
}
export interface OrganizationItem {
  id: string;
  name: string;
}
export interface FileOrganization {
  tags: readonly OrganizationItem[];
  collections: readonly OrganizationItem[];
}
export interface OrganizationUpdate {
  readonly tagIds?: readonly string[];
  readonly collectionIds?: readonly string[];
}
export interface OrganizationSelection {
  tagIds: string[];
  collectionIds: string[];
}
export interface OrganizationQuery {
  q?: string;
  limit?: number;
  offset?: number;
  sort?: "name" | "createdAt";
  order?: "asc" | "desc";
}
export interface TagView {
  id: string;
  ownerId: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}
export interface CollectionView extends TagView {
  description: string;
  readyFileCount: number;
  preview: { fileId: string; thumbnailUrl: string } | null;
}
export const ORGANIZATION_LIMIT = 100;
/** Returns null when a value cannot be used as a category name. */
export function normalizeOrganizationName(
  value: unknown,
  kind: "tag" | "collection",
): { name: string; nameKey: string } | null {
  if (typeof value !== "string") return null;
  const name = value.trim().normalize("NFC");
  if (
    !name ||
    [...name].length > (kind === "tag" ? 64 : 100) ||
    /\p{Cc}/u.test(name)
  )
    return null;
  return { name, nameKey: name.toLowerCase().normalize("NFC") };
}
export function validOrganizationDescription(value: unknown): value is string {
  return typeof value === "string" && [...value].length <= 2000;
}
