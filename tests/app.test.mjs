import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ALBUM_ADMIN_EMAIL,
  AUDIO_RETENTION_MS,
  CHAT_ANCHOR_SIDE,
  CHAT_PAGE_SIZE,
  MAX_AUDIO_BYTES,
  MAX_AUDIO_DURATION_MS,
  MAX_VIDEO_BYTES,
  albumMonthKey,
  audioFileExtension,
  buildMediaKeyIndex,
  compareFirebasePushKeys,
  favoriteKeySet,
  filterAlbumMedia,
  formatAudioDuration,
  isAudioExpired,
  mediaKind,
  mergeMessageEntries,
  normalizedVideoFileName,
  normalizeSearchText,
  selectAudioMimeType,
  validateAudioRecording,
  validateMediaFile,
  videoContentType
} from "../app-core.js";

const root = new URL("../", import.meta.url);
const html = await readFile(new URL("index.html", root), "utf8");
const appCoreSource = await readFile(new URL("app-core.js", root), "utf8");
const worker = await readFile(new URL("firebase-messaging-sw.js", root), "utf8");
const databaseRules = await readFile(new URL("database.rules.json", root), "utf8");
const storageRules = await readFile(new URL("storage.rules", root), "utf8");
const functionsSource = await readFile(new URL("functions/index.js", root), "utf8");
const translationSource = await readFile(new URL("functions/translation.js", root), "utf8");

test("module script parses", async () => {
  const match = html.match(/<script type="module">([\s\S]*?)<\/script>/);
  assert.ok(match, "module script not found");

  const directory = await mkdtemp(join(tmpdir(), "memo-check-"));
  const scriptPath = join(directory, "app.mjs");

  try {
    await writeFile(scriptPath, match[1], "utf8");
    const result = spawnSync(process.execPath, ["--check", scriptPath], { encoding:"utf8" });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    await rm(directory, { recursive:true, force:true });
  }
});

test("service worker parses", () => {
  const result = spawnSync(process.execPath, ["--check", fileURLToPath(new URL("firebase-messaging-sw.js", root))], {
    encoding:"utf8"
  });
  assert.equal(result.status, 0, result.stderr);
});

test("app shell updates bypass stale GitHub Pages caches", () => {
  assert.match(html, /data-app-shell-version="4\.2\.4"/);
  assert.match(html, /from "\.\/app-core\.js\?v=4\.2\.4"/);
  assert.match(html, /firebase-messaging-sw\.js\?v=4\.2\.4/);
  assert.match(html, /updateViaCache:"none"/);
  assert.match(worker, /const APP_VERSION = '4\.2\.4'/);
  assert.match(worker, /e\.request\.mode === 'navigate'/);
  assert.match(worker, /url\.pathname\.endsWith\('\/app-core\.js'\)/);
  assert.match(worker, /fetch\(e\.request, \{ cache:'no-store' \}\)/);
  assert.match(html, /appVersionDisplay/);
  assert.match(appCoreSource, /shellVersion !== APP_VERSION/);
  assert.match(appCoreSource, /searchParams\.set\("memo-version", APP_VERSION\)/);
});

test("document ids are unique", () => {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  assert.deepEqual([...new Set(duplicates)], []);
});

test("required improvements remain wired", () => {
  assert.match(html, /SEARCH_PAGE_SIZE/);
  assert.match(html, /albumMonthFilter/);
  assert.match(html, /album-section-grid/);
  assert.match(html, /contextmenu/);
  assert.match(html, /validateMediaFile/);
  assert.match(html, /fcmReady/);
  assert.match(worker, /if \(payload\.notification\)/);
  assert.match(worker, /getNotifications\(\{ tag \}\)/);
});

test("official translation remains wired without the unofficial endpoint", () => {
  assert.match(html, /httpsCallable\(cloudFunctions, "translateText"/);
  assert.doesNotMatch(html, /translate_a\/single|client=gtx/);
  assert.match(html, /memo_show_translation_/);
  assert.match(html, /body\.hide-translations \.msg-translation/);
  assert.match(html, /messageSendQueue\.then/);
  assert.match(html, /timeout:6000/);
  assert.match(html, /clientTranslationRetryAt/);
  assert.match(html, /translationStatus/);
  assert.match(html, /번역 중…/);
  assert.match(html, /msg\?\.translation/);
  assert.match(html, /translation:msg\.translation \|\| null/);
  assert.match(functionsSource, /exports\.translateText = onCall/);
  assert.match(functionsSource, /exports\.fillMissingTranslation = onValueCreated/);
  assert.match(functionsSource, /region:"asia-southeast1"/);
  assert.match(translationSource, /translationStatus === FALLBACK_TRANSLATION_PENDING/);
  assert.match(functionsSource, /TranslationServiceClient/);
});

test("video upload limit is exactly 5 MiB", () => {
  assert.equal(MAX_VIDEO_BYTES, 5 * 1024 * 1024);
  assert.doesNotThrow(() => validateMediaFile({ name:"ok.mp4", type:"video/mp4", size:MAX_VIDEO_BYTES }));
  assert.throws(
    () => validateMediaFile({ name:"large.mp4", type:"video/mp4", size:MAX_VIDEO_BYTES + 1 }),
    /5MB 이하/
  );
  assert.equal(mediaKind({ name:"iphone.MOV", type:"" }), "video");
  assert.equal(mediaKind({ name:"photo.JPG", type:"" }), "image");
  assert.equal(videoContentType({ name:"iphone.MOV", type:"" }), "video/quicktime");
  assert.equal(videoContentType({ name:"clip", type:"video/mp4" }), "video/mp4");
  assert.equal(normalizedVideoFileName({ name:"clip", type:"video/quicktime" }), "clip.mov");
});

test("iOS video upload uses a stable blob and non-resumable request", () => {
  assert.match(html, /const bytes = await file\.arrayBuffer\(\)/);
  assert.match(html, /targetFile = new Blob\(\[bytes\]/);
  assert.match(html, /await uploadBytes\(storageRef, targetFile, metadata\)/);
  assert.match(html, /serverResponse:err\?\.serverResponse/);
  assert.match(html, /finally \{[\s\S]*?input\.value = "";/);
});

test("search normalization and album month grouping are deterministic", () => {
  assert.equal(normalizeSearchText("ＡBC 가나다"), "abc 가나다");
  assert.match(albumMonthKey(new Date(2026, 7, 2).getTime()), /^2026-08$/);
});

test("anchored chat pages merge in key order without duplicates", () => {
  assert.equal(CHAT_PAGE_SIZE, 30);
  assert.equal(CHAT_ANCHOR_SIDE, 30);

  const realPushKeys = [
    "-P0b7H6RW3XqdgRltK3M",
    "-P0b7LI5SSqclT-MmXAd",
    "-P0b7LNnTvSRSVFjjoKu",
    "-P0b7Nl5vJAoJHsHQnlp",
    "-P0b7P9qsV5Nf6uB47Dl",
    "-P0b7WunNkqCwGv2KlW-",
    "-P0b7aTEOLmgrV7zWF-_"
  ];

  assert.deepEqual([...realPushKeys].reverse().sort(compareFirebasePushKeys), realPushKeys);

  const merged = mergeMessageEntries(
    [
      { key:realPushKeys[4], msg:{ text:"old p" } },
      { key:realPushKeys[0], msg:{ text:"h" } },
      { key:realPushKeys[6], msg:{ text:"a" } }
    ],
    [
      { key:realPushKeys[2], msg:{ text:"l" } },
      { key:realPushKeys[4], msg:{ text:"new p" } },
      null
    ]
  );

  assert.deepEqual(
    merged.map(entry => entry.key),
    [realPushKeys[0], realPushKeys[2], realPushKeys[4], realPushKeys[6]]
  );
  assert.equal(merged[2].msg.text, "new p");
  assert.deepEqual(mergeMessageEntries(null, [{ key:"", msg:{} }]), []);
});

test("search and album source jump into the chat timeline", () => {
  assert.match(html, /button\.onclick = \(\) => window\.jumpToMessage\(key\)/);
  assert.match(html, /window\.jumpToMessage = async function/);
  assert.match(html, /endAt\(key\), limitToLast\(anchorLimit\)/);
  assert.match(html, /startAt\(key\), limitToFirst\(anchorLimit\)/);
  assert.match(html, /orderByKey\(\), limitToLast\(1\)/);
  assert.match(html, /hasMoreNewer = Boolean\(latestKey && windowNewestKey !== latestKey\)/);
  assert.match(html, /async function loadNewerMessages\(\)/);
  assert.match(html, /startAfter\(newestKey\)/);
  assert.match(html, /window\.returnToLatestMessages = async function/);
  assert.match(html, /message-jump-target/);
  assert.match(html, /window\.switchTab\("chat"\);[\s\S]*?window\.jumpToMessage\(item\.messageKey\)/);
  assert.doesNotMatch(html, /openSearchContext|searchContextList/);
  assert.doesNotMatch(html, /\[beforeEntries, afterEntries, cachedLatestEntries\(\)\]/);
});

test("voice message limits and expiration are deterministic", () => {
  assert.equal(ALBUM_ADMIN_EMAIL, "fromkevinjung@gmail.com");
  assert.equal(MAX_AUDIO_BYTES, 2 * 1024 * 1024);
  assert.equal(MAX_AUDIO_DURATION_MS, 60 * 1000);
  assert.equal(AUDIO_RETENTION_MS, 7 * 24 * 60 * 60 * 1000);

  const supported = new Set(["audio/mp4", "audio/webm;codecs=opus"]);
  assert.equal(selectAudioMimeType(type => supported.has(type)), "audio/mp4");
  assert.equal(audioFileExtension("audio/mp4;codecs=mp4a.40.2"), "m4a");
  assert.equal(audioFileExtension("audio/webm;codecs=opus"), "webm");
  assert.doesNotThrow(() => validateAudioRecording({ size:MAX_AUDIO_BYTES }, MAX_AUDIO_DURATION_MS));
  assert.throws(() => validateAudioRecording({ size:MAX_AUDIO_BYTES + 1 }, 1000), /2MB 이하/);
  assert.equal(isAudioExpired({ expiresAt:1000 }, 1000), true);
  assert.equal(isAudioExpired({ expiresAt:1001 }, 1000), false);
  assert.equal(formatAudioDuration(60_000), "1:00");
});

test("admin deletion and voice expiration are wired end to end", () => {
  assert.doesNotThrow(() => JSON.parse(databaseRules));
  assert.match(html, /httpsCallable\(cloudFunctions, "deleteAlbumMedia"\)/);
  assert.match(html, /httpsCallable\(cloudFunctions, "restoreAlbumMedia"\)/);
  assert.match(html, /httpsCallable\(cloudFunctions, "createVoiceMessage"\)/);
  assert.match(html, /new MediaRecorder\(voiceStream/);
  assert.match(html, /onChildChanged\(messagesRef/);
  assert.match(html, /el\.replaceWith\(replacement\)/);
  assert.match(storageRules, /request\.resource\.size <= 2 \* 1024 \* 1024/);
  assert.match(storageRules, /allow update, delete: if false/);
  assert.match(functionsSource, /exports\.purgeExpiredMedia = onSchedule/);
  assert.match(functionsSource, /schedule:"every 15 minutes"/);
});

test("favorite filtering is deterministic and per-account", () => {
  const august = new Date(2026, 7, 2).getTime();
  const july = new Date(2026, 6, 2).getTime();
  const items = [
    { key:"a", ts:august, type:"image", url:"https://x/a.jpg" },
    { key:"b", ts:august, type:"video", url:"https://x/b.mp4" },
    { key:"c", ts:july, type:"image", url:"https://x/c.jpg" }
  ];
  const favorites = favoriteKeySet({ a:1, c:2, d:null });

  assert.deepEqual([...favorites], ["a", "c"]);
  assert.deepEqual([...favoriteKeySet(null)], []);

  assert.deepEqual(
    filterAlbumMedia(items, { favoritesOnly:true, favorites }).map(item => item.key),
    ["a", "c"]
  );
  assert.deepEqual(
    filterAlbumMedia(items, { favoritesOnly:true, favorites, type:"image", month:albumMonthKey(august) })
      .map(item => item.key),
    ["a"]
  );
  assert.deepEqual(filterAlbumMedia(items, {}).map(item => item.key), ["a", "b", "c"]);
  assert.deepEqual(filterAlbumMedia(items, { favoritesOnly:true }).map(item => item.key), []);

  const index = buildMediaKeyIndex(items);
  assert.equal(index.get("https://x/b.mp4"), "b");
  assert.equal(index.get("https://x/none.jpg"), undefined);
  assert.equal(buildMediaKeyIndex(null).size, 0);
});

test("photo favorites are wired through album and lightbox", () => {
  const rules = JSON.parse(databaseRules);
  const favorites = rules.rules.memo_private_room.favorites.$name;

  assert.match(favorites[".read"], /\$name == 'Kevin'/);
  assert.match(favorites[".write"], /\$name == 'Momo'/);
  assert.equal(favorites.$mediaId[".validate"], "newData.isNumber()");

  assert.match(html, /id="albumFavoriteFilter"/);
  assert.match(html, /id="lbFavorite"/);
  assert.match(html, /window\.toggleAlbumFavoriteFilter = function/);
  assert.match(html, /window\.toggleLightboxFavorite = async function/);
  assert.match(html, /function listenFavorites\(\)/);
  assert.match(html, /listenFavorites\(\);/);
  assert.match(html, /\$\{ROOM_ID\}\/favorites\/\$\{me\.name\}/);
  assert.match(html, /favoritesOnly:albumFavoriteOnly/);
  assert.match(html, /album-fav-badge/);
  assert.match(html, /albumMediaKeyByUrl = buildMediaKeyIndex\(albumMedia\)/);
  assert.match(functionsSource, /updates\[`favorites\/\$\{owner\}\/\$\{mediaKey\}`\] = null/);
  assert.match(functionsSource, /trash\.favoritesBefore/);
});
