import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

function between(start, end) {
  const startIndex = html.indexOf(start);
  const endIndex = html.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `missing start marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing end marker: ${end}`);
  return html.slice(startIndex, endIndex);
}

test("room disposal owns subscriptions, DOM handlers, timers and private reset", () => {
  const helpers = between("function isCurrentRoomSession", "const CHECK_SINGLE");
  assert.match(html, /const roomCleanupTasks = new Set\(\)/);
  assert.match(helpers, /target\.removeEventListener\(type, handler, options\)/);
  assert.match(helpers, /activeRoomSession \+= 1/);
  assert.match(helpers, /cleanupTasks\.reverse\(\)\.forEach/);
  assert.match(helpers, /clearTimeout\(initialLoadTimer\)/);
  assert.match(helpers, /seenKeys\.clear\(\)/);
  assert.match(helpers, /window\._loadedMessages = \{\}/);
  assert.match(helpers, /window\.clearPrivatePerformanceState\?\.\(\)/);
});

test("room listeners return unsubscribe functions and keep bounded initial/history reads", () => {
  const room = between("function enterRoom()", "async function initStickerPanel()");
  assert.match(room, /limitToLast\(50\)/);
  assert.match(room, /limitToLast\(20\)/);
  assert.match(room, /registerRoomCleanup\(sessionId, onChildAdded/);
  assert.match(room, /registerRoomCleanup\(sessionId, onChildChanged/);
  assert.match(room, /registerRoomCleanup\(sessionId, onChildRemoved/);
  assert.match(room, /addRoomEventListener\(sessionId, document, "visibilitychange"/);
  assert.doesNotMatch(room, /onRoomVisibilityChange[\s\S]*?disposeRoom\(/);

  assert.match(html, /function listenFavorites\(\)\s*\{[\s\S]*?return onValue\(/);
  assert.match(html, /function listenTrash\([^)]*\)\s*\{[\s\S]*?return onValue\(/);
  assert.match(html, /function listenTodos\([^)]*\)\s*\{[\s\S]*?return onValue\(/);
  assert.match(html, /function listenSignaling\([^)]*\)\s*\{[\s\S]*?return onValue\(/);
  assert.match(html, /function listenArchive\([^)]*\)\s*\{[\s\S]*?return onValue\(/);
});

test("stale callbacks and history responses are session guarded", () => {
  const room = between("function enterRoom()", "async function initStickerPanel()");
  assert.match(room, /if \(!isCurrentRoomSession\(sessionId, userId\)\) return;/);
  assert.match(room, /const snapshot = await get\(olderQuery\);\s*if \(!isCurrentRoomSession\(sessionId, userId\)\) return;/);
  assert.match(room, /if \(activeRoomSession === sessionId\) \{\s*loadingOlder = false;/);
  assert.match(room, /window\.invalidateSearchPageCache\?\.\(key\)/);
});

test("logout disposes before sign-out and preserves explicit offline presence", () => {
  const logout = between("window.doLogout = async function()", "let searchMatches");
  assert.ok(logout.indexOf("disposeRoom();") < logout.indexOf("await signOut(auth)"));
  assert.match(logout, /presence\/\$\{roomMe\.name\}/);
  assert.match(logout, /online:false/);
});
