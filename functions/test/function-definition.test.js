"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const functions = require("../index");

test("client translation callable has bounded timeout", () => {
  const endpoint = functions.translateText.__endpoint;

  assert.equal(endpoint.platform, "gcfv2");
  assert.deepEqual(endpoint.region, ["asia-northeast3"]);
  assert.equal(endpoint.timeoutSeconds, 5);
  assert.equal(endpoint.maxInstances, 3);
});

test("fallback listens only to new messages in the production RTDB", () => {
  const endpoint = functions.fillMissingTranslation.__endpoint;

  assert.equal(endpoint.platform, "gcfv2");
  assert.deepEqual(endpoint.region, ["asia-southeast1"]);
  assert.equal(endpoint.eventTrigger.eventType, "google.firebase.database.ref.v1.created");
  assert.equal(endpoint.eventTrigger.eventFilters.instance, "memo-e366f-default-rtdb");
  assert.equal(endpoint.eventTrigger.eventFilterPathPatterns.ref, "memo_private_room/messages/{messageId}");
  assert.equal(endpoint.eventTrigger.retry, false);
  assert.equal(endpoint.timeoutSeconds, 30);
});
