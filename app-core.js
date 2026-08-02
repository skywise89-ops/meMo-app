export const APP_VERSION = "4.0.0";
export const MAX_VIDEO_BYTES = 5 * 1024 * 1024;
export const MAX_AUDIO_BYTES = 2 * 1024 * 1024;
export const MAX_AUDIO_DURATION_MS = 60 * 1000;
export const AUDIO_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const ALBUM_ADMIN_EMAIL = "fromkevinjung@gmail.com";
export const SEARCH_PAGE_SIZE = 200;
export const SEARCH_RESULT_LIMIT = 300;

export const AUDIO_MIME_CANDIDATES = Object.freeze([
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus"
]);

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

export function selectAudioMimeType(isTypeSupported) {
  if (typeof isTypeSupported !== "function") return "";
  return AUDIO_MIME_CANDIDATES.find(type => isTypeSupported(type)) || "";
}

export function audioFileExtension(mimeType) {
  const type = String(mimeType || "").toLowerCase();
  if (type.startsWith("audio/mp4")) return "m4a";
  if (type.startsWith("audio/ogg")) return "ogg";
  return "webm";
}

export function validateAudioRecording(blob, durationMs) {
  if (!blob || !Number.isFinite(blob.size) || blob.size <= 0) {
    throw new Error("녹음된 음성이 없습니다.");
  }

  if (!Number.isFinite(durationMs) || durationMs < 300) {
    throw new Error("음성 메시지가 너무 짧습니다.");
  }

  if (durationMs > MAX_AUDIO_DURATION_MS + 1000) {
    throw new Error("음성 메시지는 최대 60초까지 녹음할 수 있습니다.");
  }

  if (blob.size > MAX_AUDIO_BYTES) {
    throw new Error("음성 메시지는 2MB 이하만 전송할 수 있습니다.");
  }
}

export function isAudioExpired(message, now = Date.now()) {
  return Boolean(
    message?.expired ||
    (Number.isFinite(message?.expiresAt) && message.expiresAt <= now)
  );
}

export function formatAudioDuration(durationMs) {
  const totalSeconds = Math.max(0, Math.ceil(Number(durationMs || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}
