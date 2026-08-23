"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  MAX_TRANSLATION_CHARACTERS,
  characterCount,
  parseTranslationRequest,
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
