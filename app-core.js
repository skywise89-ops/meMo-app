export const APP_VERSION = "3.0.1";
export const MAX_VIDEO_BYTES = 5 * 1024 * 1024;
export const SEARCH_PAGE_SIZE = 200;
export const SEARCH_RESULT_LIMIT = 300;

export function normalizeSearchText(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase();
}

export function albumMonthKey(ts) {
  const d = new Date(ts || Date.now());
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function mediaKind(file) {
  const type = String(file?.type || "").toLowerCase();
  const name = String(file?.name || "").toLowerCase();

  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (/\.(jpe?g|png|gif|webp|heic|heif)$/.test(name)) return "image";
  if (/\.(mp4|mov|m4v|webm)$/.test(name)) return "video";
  return null;
}

export function validateMediaFile(file) {
  const kind = mediaKind(file);

  if (!kind) {
    throw new Error(`${file.name || "선택한 파일"}은 지원하지 않는 형식입니다.`);
  }

  if (kind === "video" && file.size > MAX_VIDEO_BYTES) {
    throw new Error(`${file.name || "영상"}: 영상은 5MB 이하만 업로드할 수 있습니다.`);
  }
}

export function videoContentType(file) {
  const type = String(file?.type || "").toLowerCase();
  const name = String(file?.name || "").toLowerCase();

  if (type.startsWith("video/") && type !== "video/*") return type;
  if (/\.mov$/.test(name)) return "video/quicktime";
  if (/\.webm$/.test(name)) return "video/webm";
  return "video/mp4";
}

export function normalizedVideoFileName(file) {
  const name = String(file?.name || "").trim();

  if (/\.(mp4|mov|m4v|webm)$/i.test(name)) return name;

  const type = videoContentType(file);
  const extension = type === "video/quicktime"
    ? ".mov"
    : type === "video/webm"
      ? ".webm"
      : ".mp4";

  return `${name || "video"}${extension}`;
}
