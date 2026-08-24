"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  FALLBACK_TRANSLATION_COMPLETE,
  FALLBACK_TRANSLATION_FAILED,
  MAX_TRANSLATION_CHARACTERS,
  characterCount,
  completeFallbackTranslation,
  failFallbackTranslation,
  isFallbackTranslationCandidate,
  parseTranslationRequest,
  targetLanguageFor,
  translatedTextFromResponse
} = require("../translation");

test("translation accepts only Korean and Japanese pairs", () => {
  assert.deepEqual(
    parseTranslationRequest({
      text:" 안녕하세요 ",
      sourceLanguageCode:"KO",
      targetLanguageCode:"ja"
    }),
    {
      text:"안녕하세요",
      sourceLanguageCode:"ko",
      targetLanguageCode:"ja"
    }
  );

  assert.throws(
    () => parseTranslationRequest({ text:"hello", sourceLanguageCode:"en", targetLanguageCode:"ja" }),
    /한국어와 일본어/
  );
  assert.throws(
    () => parseTranslationRequest({ text:" ", sourceLanguageCode:"ko", targetLanguageCode:"ja" }),
    /메시지가 없습니다/
  );
});

test("translation character limit counts Unicode code points", () => {
  assert.equal(characterCount("🌸한日"), 3);
  assert.doesNotThrow(() => parseTranslationRequest({
    text:"가".repeat(MAX_TRANSLATION_CHARACTERS),
    sourceLanguageCode:"ko",
    targetLanguageCode:"ja"
  }));
  assert.throws(
    () => parseTranslationRequest({
      text:"가".repeat(MAX_TRANSLATION_CHARACTERS + 1),
      sourceLanguageCode:"ko",
      targetLanguageCode:"ja"
    }),
    /5000자 이하/
  );
});

test("translation response must contain text", () => {
  assert.equal(
    translatedTextFromResponse({ translations:[{ translatedText:" こんにちは " }] }),
    "こんにちは"
  );
  assert.throws(() => translatedTextFromResponse({ translations:[] }), /결과가 비어/);
});

test("fallback translates only new pending text messages", () => {
  const pending = {
    uid:"Kevin",
    type:"text",
    lang:"ko",
    text:"안녕하세요",
    translation:null,
    translationStatus:"pending"
  };

  assert.equal(targetLanguageFor("ko"), "ja");
  assert.equal(targetLanguageFor("ja"), "ko");
  assert.equal(targetLanguageFor("en"), "");
  assert.equal(isFallbackTranslationCandidate(pending), true);
  assert.equal(isFallbackTranslationCandidate({ ...pending, translationStatus:undefined }), false);
  assert.equal(isFallbackTranslationCandidate({ ...pending, translation:"こんにちは" }), false);
  assert.equal(isFallbackTranslationCandidate({ ...pending, type:"system", uid:"system" }), false);
});

test("fallback completion and failure preserve message fields", () => {
  const pending = {
    uid:"Momo",
    name:"Momo",
    type:"text",
    lang:"ja",
    text:"こんにちは",
    translation:null,
    translationStatus:"pending",
    ts:1000
  };

  assert.deepEqual(completeFallbackTranslation(pending, " 안녕하세요 ", 2000), {
    ...pending,
    translation:"안녕하세요",
    translationStatus:FALLBACK_TRANSLATION_COMPLETE,
    translationSource:"server-fallback",
    translatedAt:2000
  });
  assert.deepEqual(failFallbackTranslation(pending, 3000), {
    ...pending,
    translationStatus:FALLBACK_TRANSLATION_FAILED,
    translationFailedAt:3000
  });
  assert.equal(completeFallbackTranslation({ ...pending, translationStatus:"complete" }, "x", 1), undefined);
});
