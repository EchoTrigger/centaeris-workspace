import { apiUrl } from "../api";

export function attachmentDownloadUrl(link) {
  if (link.assetKind === "userLibraryObject") return apiUrl(`/api/library/${link.asset.id}/download`);
  if (link.assetKind === "sourceObject") return apiUrl(`/api/source-objects/${link.asset.id}/download`);
  if (link.assetKind === "artifact") return apiUrl(`/api/artifacts/${link.asset.id}/download`);
  throw new Error(`unsupported attachment assetKind: ${link.assetKind}`);
}

export function attachmentPreviewUrl(link) {
  return link.assetKind === "userLibraryObject"
    ? apiUrl(`/api/library/${link.asset.id}/preview`)
    : attachmentDownloadUrl(link);
}

export function attachmentIsImage(link) {
  return (link.contentType || link.asset?.contentType || "").startsWith("image/");
}

export function attachmentCanPreview(link) {
  const contentType = link.contentType || link.asset?.contentType || "";
  return attachmentIsImage(link)
    || (link.assetKind === "userLibraryObject" && (contentType === "application/pdf" || contentType.startsWith("text/")));
}
