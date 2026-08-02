"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  ADMIN_EMAIL,
  AUDIO_RETENTION_MS,
  MAX_AUDIO_BYTES,
  MEDIA_TRASH_RETENTION_MS,
  findMessageKeyForMedia,
  memberName,
  restoreMessage,
  storagePathFromDownloadUrl,
  tombstoneMessage,
  validPushKey
} = require("../media-state");

test("security constants are exact", () => {
  assert.equal(ADMIN_EMAIL, "fromkevinjung@gmail.com");
  assert.equal(memberName("MOMO.021118@gmail.com"), "Momo");
  assert.equal(MAX_AUDIO_BYTES, 2 * 1024 * 1024);
  assert.equal(AUDIO_RETENTION_MS, 7 * 24 * 60 * 60 * 1000);
  assert.equal(MEDIA_TRASH_RETENTION_MS, AUDIO_RETENTION_MS);
});

test("push keys reject paths and punctuation", () => {
  assert.equal(validPushKey("-OabcDEF_12345"), true);
  assert.equal(validPushKey("../../messages"), false);
  assert.equal(validPushKey("short"), false);
});

test("single media message tombstones and restores", () => {
  const media = { type:"image", url:"https://example.com/a.jpg" };
  const original = { type:"image", url:media.url, mediaKey:"mediaKey_123", uid:"Kevin" };
  const deleted = tombstoneMessage(original, media, "mediaKey_123", 1000);

  assert.equal(deleted.type, "deleted-media");
  assert.equal(deleted.url, null);
  assert.deepEqual(restoreMessage(deleted, original, media, "mediaKey_123"), original);
});

test("album restore does not resurrect another deleted item", () => {
  const original = {
    type:"album",
    items:[
      { mediaKey:"mediaKey_A", type:"image", url:"https://example.com/a.jpg" },
      { mediaKey:"mediaKey_B", type:"image", url:"https://example.com/b.jpg" }
    ]
  };
  const deletedA = tombstoneMessage(original, original.items[0], "mediaKey_A", 1000);
  const deletedBoth = tombstoneMessage(deletedA, original.items[1], "mediaKey_B", 1001);
  const restoredA = restoreMessage(deletedBoth, original, original.items[0], "mediaKey_A");

  assert.equal(restoredA.items[0].url, "https://example.com/a.jpg");
  assert.equal(restoredA.items[1].deleted, true);
  assert.equal(restoredA.items[1].url, null);
});

test("legacy media finds its message by URL", () => {
  const messages = {
    keyA:{ type:"text", text:"hello" },
    keyB:{
      type:"album",
      items:[{ type:"image", url:"https://example.com/legacy.jpg" }]
    }
  };

  assert.equal(
    findMessageKeyForMedia(
      messages,
      { type:"image", url:"https://example.com/legacy.jpg" },
      "mediaKey_legacy"
    ),
    "keyB"
  );
});

test("download URLs resolve only for the expected bucket", () => {
  const url = "https://firebasestorage.googleapis.com/v0/b/memo-e366f.firebasestorage.app/o/memo_private_room%2Fa.jpg?alt=media&token=x";
  assert.equal(
    storagePathFromDownloadUrl(url, "memo-e366f.firebasestorage.app"),
    "memo_private_room/a.jpg"
  );
  assert.equal(storagePathFromDownloadUrl(url, "other.firebasestorage.app"), "");
});
