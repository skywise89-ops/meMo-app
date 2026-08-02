"use strict";

const { setGlobalOptions } = require("firebase-functions/v2");
const { HttpsError, onCall } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { initializeApp } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");
const { getStorage } = require("firebase-admin/storage");
const {
  ADMIN_EMAIL,
  AUDIO_RETENTION_MS,
  MAX_AUDIO_BYTES,
  MEDIA_TRASH_RETENTION_MS,
  ROOM_ID,
  findMessageKeyForMedia,
  memberName,
  normalizeEmail,
  restoreMessage,
  storagePathFromDownloadUrl,
  tombstoneMessage,
  validPushKey
} = require("./media-state");

initializeApp();
setGlobalOptions({
  region:"asia-northeast3",
  maxInstances:3,
  memory:"256MiB",
  timeoutSeconds:60
});

function authEmail(auth) {
  return normalizeEmail(auth?.token?.email);
}

function requireMember(auth) {
  const email = authEmail(auth);

  if (!auth || auth.token?.email_verified !== true || !memberName(email)) {
    throw new HttpsError("permission-denied", "허용된 사용자만 실행할 수 있습니다.");
  }

  return email;
}

function requireAdmin(auth) {
  const email = requireMember(auth);

  if (email !== ADMIN_EMAIL) {
    throw new HttpsError("permission-denied", "앨범 삭제 권한이 없습니다.");
  }

  return email;
}

function requireMediaKey(value) {
  if (!validPushKey(value)) {
    throw new HttpsError("invalid-argument", "올바르지 않은 미디어 식별자입니다.");
  }

  return value;
}

async function deleteStorageObject(bucket, storagePath) {
  if (!storagePath) return;

  try {
    await bucket.file(storagePath).delete();
  } catch (err) {
    if (err?.code !== 404) throw err;
  }
}

exports.deleteAlbumMedia = onCall(async request => {
  const email = requireAdmin(request.auth);
  const mediaKey = requireMediaKey(request.data?.mediaKey);
  const db = getDatabase();
  const roomRef = db.ref(ROOM_ID);
  const mediaRef = roomRef.child(`media/${mediaKey}`);
  const trashRef = roomRef.child(`trash/media/${mediaKey}`);
  const [mediaSnapshot, trashSnapshot] = await Promise.all([
    mediaRef.get(),
    trashRef.get()
  ]);

  if (!mediaSnapshot.exists()) {
    if (trashSnapshot.exists()) return { status:"already-trashed", mediaKey };
    throw new HttpsError("not-found", "앨범 미디어를 찾을 수 없습니다.");
  }

  const media = mediaSnapshot.val();
  if (media.type !== "image" && media.type !== "video") {
    throw new HttpsError("failed-precondition", "사진과 영상만 삭제할 수 있습니다.");
  }

  let resolvedMessageKey = media.messageKey || "";

  if (!resolvedMessageKey) {
    const messagesSnapshot = await roomRef.child("messages").get();
    resolvedMessageKey = findMessageKeyForMedia(
      messagesSnapshot.val(),
      media,
      mediaKey
    );
  }

  const normalizedMedia = resolvedMessageKey
    ? { ...media, messageKey:resolvedMessageKey }
    : media;
  const now = Date.now();
  const bucket = getStorage().bucket();
  const storagePath = media.storagePath
    || storagePathFromDownloadUrl(media.url, bucket.name);
  const messageSnapshot = resolvedMessageKey
    ? await roomRef.child(`messages/${resolvedMessageKey}`).get()
    : null;
  const todoSnapshot = media.sourceTodoKey
    ? await roomRef.child(`todos/${media.sourceTodoKey}`).get()
    : null;
  const archiveSnapshot = await roomRef.child("archive").get();
  const messageBefore = messageSnapshot?.exists() ? messageSnapshot.val() : null;
  const todoBefore = todoSnapshot?.exists() ? todoSnapshot.val() : null;
  const archiveBefore = {};
  const trash = {
    media:{ ...normalizedMedia, storagePath },
    messageBefore,
    todoBefore,
    archiveBefore,
    deletedAt:now,
    deletedBy:email,
    expiresAt:now + MEDIA_TRASH_RETENTION_MS,
    state:"active"
  };
  const updates = {
    [`trash/media/${mediaKey}`]:trash,
    [`media/${mediaKey}`]:null
  };

  if (resolvedMessageKey && messageBefore) {
    updates[`messages/${resolvedMessageKey}`] = tombstoneMessage(
      messageBefore,
      normalizedMedia,
      mediaKey,
      now
    );
  }

  if (media.sourceTodoKey && todoBefore?.proofUrl === media.url) {
    updates[`todos/${media.sourceTodoKey}/proofUrl`] = null;
    updates[`todos/${media.sourceTodoKey}/proofType`] = null;
  }

  for (const [archiveOwner, entries] of Object.entries(archiveSnapshot.val() || {})) {
    for (const [archiveKey, archivedMessage] of Object.entries(entries || {})) {
      const tombstone = tombstoneMessage(
        archivedMessage,
        normalizedMedia,
        mediaKey,
        now
      );

      if (JSON.stringify(tombstone) !== JSON.stringify(archivedMessage)) {
        if (!archiveBefore[archiveOwner]) archiveBefore[archiveOwner] = {};
        archiveBefore[archiveOwner][archiveKey] = archivedMessage;
        updates[`archive/${archiveOwner}/${archiveKey}`] = tombstone;
      }
    }
  }

  await roomRef.update(updates);
  return { status:"trashed", mediaKey, expiresAt:trash.expiresAt };
});

exports.restoreAlbumMedia = onCall(async request => {
  requireAdmin(request.auth);
  const mediaKey = requireMediaKey(request.data?.mediaKey);
  const db = getDatabase();
  const roomRef = db.ref(ROOM_ID);
  const trashRef = roomRef.child(`trash/media/${mediaKey}`);
  const now = Date.now();
  const claim = await trashRef.transaction(current => {
    if (!current || current.expiresAt <= now || current.state === "purging") return;
    return { ...current, state:"restoring", restoringAt:now };
  }, undefined, false);

  if (!claim.committed || !claim.snapshot.exists()) {
    throw new HttpsError("failed-precondition", "복구 기간이 지났거나 삭제 처리 중입니다.");
  }

  const trash = claim.snapshot.val();
  const media = trash.media;
  const bucket = getStorage().bucket();
  const storagePath = media.storagePath
    || storagePathFromDownloadUrl(media.url, bucket.name);

  try {
    if (storagePath) {
      const [exists] = await bucket.file(storagePath).exists();
      if (!exists) throw new HttpsError("failed-precondition", "원본 파일이 이미 삭제되었습니다.");
    }

    const updates = {
      [`media/${mediaKey}`]:{ ...media, storagePath },
      [`trash/media/${mediaKey}`]:null
    };

    if (media.messageKey && trash.messageBefore) {
      const currentSnapshot = await roomRef.child(`messages/${media.messageKey}`).get();
      const currentMessage = currentSnapshot.exists() ? currentSnapshot.val() : null;
      updates[`messages/${media.messageKey}`] = restoreMessage(
        currentMessage,
        trash.messageBefore,
        media,
        mediaKey
      );
    }

    if (media.sourceTodoKey && trash.todoBefore?.proofUrl === media.url) {
      const currentTodo = await roomRef.child(`todos/${media.sourceTodoKey}`).get();
      if (!currentTodo.child("proofUrl").exists()) {
        updates[`todos/${media.sourceTodoKey}/proofUrl`] = media.url;
        updates[`todos/${media.sourceTodoKey}/proofType`] = media.type;
      }
    }

    for (const [archiveOwner, entries] of Object.entries(trash.archiveBefore || {})) {
      for (const [archiveKey, originalMessage] of Object.entries(entries || {})) {
        const currentArchive = await roomRef.child(`archive/${archiveOwner}/${archiveKey}`).get();
        updates[`archive/${archiveOwner}/${archiveKey}`] = restoreMessage(
          currentArchive.exists() ? currentArchive.val() : null,
          originalMessage,
          media,
          mediaKey
        );
      }
    }

    await roomRef.update(updates);
    return { status:"restored", mediaKey };
  } catch (err) {
    await trashRef.update({ state:"active", restoringAt:null });
    throw err;
  }
});

exports.createVoiceMessage = onCall(async request => {
  const email = requireMember(request.auth);
  const messageKey = requireMediaKey(request.data?.messageKey);
  const storagePath = String(request.data?.storagePath || "");
  const url = String(request.data?.url || "");
  const durationMs = Number(request.data?.durationMs);
  const reportedSize = Number(request.data?.size);
  const reportedMimeType = String(request.data?.mimeType || "").toLowerCase();
  const expectedPath = new RegExp(`^${ROOM_ID}/audio/${messageKey}\\.(m4a|webm|ogg)$`);

  if (!expectedPath.test(storagePath)) {
    throw new HttpsError("invalid-argument", "올바르지 않은 음성 파일 경로입니다.");
  }

  if (!Number.isFinite(durationMs) || durationMs < 300 || durationMs > 61_000) {
    throw new HttpsError("invalid-argument", "음성 길이는 60초 이하여야 합니다.");
  }

  const bucket = getStorage().bucket();
  if (storagePathFromDownloadUrl(url, bucket.name) !== storagePath) {
    throw new HttpsError("invalid-argument", "음성 파일 URL이 경로와 일치하지 않습니다.");
  }

  const file = bucket.file(storagePath);
  const [exists] = await file.exists();
  if (!exists) throw new HttpsError("not-found", "업로드된 음성 파일이 없습니다.");

  const [metadata] = await file.getMetadata();
  const size = Number(metadata.size || 0);
  const mimeType = String(metadata.contentType || "").toLowerCase();
  const ownerUid = metadata.metadata?.ownerUid || "";
  const metadataMessageKey = metadata.metadata?.messageKey || "";

  if (
    size <= 0
    || size > MAX_AUDIO_BYTES
    || size !== reportedSize
    || !mimeType.startsWith("audio/")
    || !reportedMimeType.startsWith("audio/")
    || ownerUid !== request.auth.uid
    || metadataMessageKey !== messageKey
  ) {
    throw new HttpsError("failed-precondition", "음성 파일 검증에 실패했습니다.");
  }

  const db = getDatabase();
  const roomRef = db.ref(ROOM_ID);
  const messageRef = roomRef.child(`messages/${messageKey}`);
  const existing = await messageRef.get();

  if (existing.exists()) {
    const value = existing.val();
    if (value.type === "audio" && value.authUid === request.auth.uid && value.storagePath === storagePath) {
      return { status:"already-created", messageKey, expiresAt:value.expiresAt };
    }
    throw new HttpsError("already-exists", "같은 식별자의 메시지가 이미 존재합니다.");
  }

  const now = Date.now();
  const expiresAt = now + AUDIO_RETENTION_MS;
  const name = memberName(email);
  const message = {
    uid:name,
    name,
    authUid:request.auth.uid,
    email,
    photoURL:request.auth.token?.picture || "",
    type:"audio",
    url,
    storagePath,
    durationMs:Math.round(durationMs),
    size,
    mimeType,
    ts:now,
    expiresAt,
    expired:false
  };

  await roomRef.update({
    [`messages/${messageKey}`]:message,
    [`audioExpirations/${messageKey}`]:{
      expiresAt,
      storagePath,
      ownerUid:request.auth.uid
    }
  });

  return { status:"created", messageKey, expiresAt };
});

exports.purgeExpiredMedia = onSchedule({
  schedule:"every 15 minutes",
  retryCount:3,
  timeoutSeconds:300
}, async () => {
  const db = getDatabase();
  const roomRef = db.ref(ROOM_ID);
  const bucket = getStorage().bucket();
  const now = Date.now();

  const [trashSnapshot, audioSnapshot] = await Promise.all([
    roomRef.child("trash/media")
      .orderByChild("expiresAt")
      .endAt(now)
      .limitToFirst(50)
      .get(),
    roomRef.child("audioExpirations")
      .orderByChild("expiresAt")
      .endAt(now)
      .limitToFirst(100)
      .get()
  ]);

  for (const [mediaKey] of Object.entries(trashSnapshot.val() || {})) {
    const trashRef = roomRef.child(`trash/media/${mediaKey}`);
    const claim = await trashRef.transaction(current => {
      const stalePurge = current?.state === "purging"
        && Number(current.purgingAt || 0) < now - 60 * 60 * 1000;
      if (!current || current.expiresAt > now || (current.state !== "active" && !stalePurge)) return;
      return { ...current, state:"purging", purgingAt:now };
    }, undefined, false);

    if (!claim.committed || !claim.snapshot.exists()) continue;

    const trash = claim.snapshot.val();
    const storagePath = trash.media?.storagePath
      || storagePathFromDownloadUrl(trash.media?.url, bucket.name);

    try {
      await deleteStorageObject(bucket, storagePath);
      await trashRef.remove();
    } catch (err) {
      console.error("[Album purge]", mediaKey, err);
      await trashRef.update({
        state:"active",
        purgingAt:null,
        lastPurgeErrorAt:Date.now()
      });
    }
  }

  for (const [messageKey, expiration] of Object.entries(audioSnapshot.val() || {})) {
    try {
      await deleteStorageObject(bucket, expiration.storagePath);
      const messageRef = roomRef.child(`messages/${messageKey}`);

      await messageRef.transaction(message => {
        if (!message || message.type !== "audio" || message.storagePath !== expiration.storagePath) {
          return message;
        }

        return {
          ...message,
          expired:true,
          expiredAt:now,
          url:null,
          storagePath:null
        };
      }, undefined, false);

      await roomRef.child(`audioExpirations/${messageKey}`).remove();
    } catch (err) {
      console.error("[Voice purge]", messageKey, err);
    }
  }
});

exports.cleanupOrphanVoiceUploads = onSchedule({
  schedule:"every day 03:17",
  timeZone:"Asia/Seoul",
  retryCount:2,
  timeoutSeconds:300
}, async () => {
  const db = getDatabase();
  const roomRef = db.ref(ROOM_ID);
  const bucket = getStorage().bucket();
  const [files] = await bucket.getFiles({ prefix:`${ROOM_ID}/audio/` });
  const cutoff = Date.now() - 8 * 24 * 60 * 60 * 1000;

  for (const file of files) {
    const [metadata] = await file.getMetadata();
    const createdAt = Date.parse(metadata.timeCreated || "");
    if (!Number.isFinite(createdAt) || createdAt > cutoff) continue;

    const messageKey = metadata.metadata?.messageKey;
    if (!validPushKey(messageKey)) continue;

    const [message, expiration] = await Promise.all([
      roomRef.child(`messages/${messageKey}`).get(),
      roomRef.child(`audioExpirations/${messageKey}`).get()
    ]);

    if (!message.exists() && !expiration.exists()) {
      await deleteStorageObject(bucket, file.name);
    }
  }
});
