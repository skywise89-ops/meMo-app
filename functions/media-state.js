"use strict";

const ROOM_ID = "memo_private_room";
const ADMIN_EMAIL = "fromkevinjung@gmail.com";
const MEMBER_NAMES = Object.freeze({
  "fromkevinjung@gmail.com":"Kevin",
  "momo.021118@gmail.com":"Momo"
});
const AUDIO_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MEDIA_TRASH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_AUDIO_BYTES = 2 * 1024 * 1024;

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function memberName(email) {
  return MEMBER_NAMES[normalizeEmail(email)] || "";
}

function validPushKey(value) {
  return typeof value === "string"
    && value.length >= 8
    && value.length <= 128
    && /^[A-Za-z0-9_-]+$/.test(value);
}

function mapMessageItems(items, transform) {
  if (Array.isArray(items)) return items.map(transform);
  if (!items || typeof items !== "object") return items;

  return Object.fromEntries(
    Object.entries(items).map(([key, item]) => [key, transform(item)])
  );
}

function mediaItemMatches(item, mediaKey, url) {
  return Boolean(item) && (
    item.mediaKey === mediaKey
    || item.deletedMediaKey === mediaKey
    || (url && item.url === url)
  );
}

function findMessageKeyForMedia(messages, media, mediaKey) {
  if (!messages || typeof messages !== "object") return "";

  for (const [messageKey, message] of Object.entries(messages)) {
    if (!message || typeof message !== "object") continue;

    if (
      message.mediaKey === mediaKey
      || (media?.url && message.url === media.url)
    ) {
      return messageKey;
    }

    let found = false;
    mapMessageItems(message.items, item => {
      if (mediaItemMatches(item, mediaKey, media?.url)) found = true;
      return item;
    });
    if (found) return messageKey;
  }

  return "";
}

function tombstoneMessage(message, media, mediaKey, deletedAt) {
  if (!message || typeof message !== "object") return message;

  if (message.type === "album") {
    return {
      ...message,
      items:mapMessageItems(message.items, item => (
        mediaItemMatches(item, mediaKey, media.url)
          ? {
              ...item,
              deleted:true,
              deletedAt,
              deletedMediaKey:mediaKey,
              url:null
            }
          : item
      ))
    };
  }

  if (
    message.mediaKey === mediaKey
    || (media.url && message.url === media.url)
  ) {
    return {
      ...message,
      type:"deleted-media",
      originalType:message.type,
      deletedAt,
      deletedMediaKey:mediaKey,
      url:null
    };
  }

  return message;
}

function restoreMessage(currentMessage, originalMessage, media, mediaKey) {
  if (!originalMessage || typeof originalMessage !== "object") return currentMessage;
  if (!currentMessage) return originalMessage;

  if (originalMessage.type !== "album") {
    return currentMessage.deletedMediaKey === mediaKey
      ? originalMessage
      : currentMessage;
  }

  let originalItem = null;
  mapMessageItems(originalMessage.items, item => {
    if (mediaItemMatches(item, mediaKey, media.url)) originalItem = item;
    return item;
  });

  if (!originalItem) return currentMessage;

  return {
    ...currentMessage,
    items:mapMessageItems(currentMessage.items, item => (
      mediaItemMatches(item, mediaKey, media.url) ? originalItem : item
    ))
  };
}

function storagePathFromDownloadUrl(url, bucketName = "") {
  if (typeof url !== "string" || !url) return "";

  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "firebasestorage.googleapis.com") return "";

    const match = parsed.pathname.match(/^\/v0\/b\/([^/]+)\/o\/(.+)$/);
    if (!match) return "";
    if (bucketName && decodeURIComponent(match[1]) !== bucketName) return "";
    return decodeURIComponent(match[2]);
  } catch {
    return "";
  }
}

module.exports = {
  ADMIN_EMAIL,
  AUDIO_RETENTION_MS,
  MAX_AUDIO_BYTES,
  MEDIA_TRASH_RETENTION_MS,
  MEMBER_NAMES,
  ROOM_ID,
  findMessageKeyForMedia,
  mapMessageItems,
  mediaItemMatches,
  memberName,
  normalizeEmail,
  restoreMessage,
  storagePathFromDownloadUrl,
  tombstoneMessage,
  validPushKey
};
