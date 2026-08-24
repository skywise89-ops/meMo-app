"use strict";

const MAX_TRANSLATION_CHARACTERS = 5000;
const SUPPORTED_PAIRS = new Set(["ko:ja", "ja:ko"]);
const FALLBACK_TRANSLATION_PENDING = "pending";
const FALLBACK_TRANSLATION_COMPLETE = "complete";
const FALLBACK_TRANSLATION_FAILED = "failed";

function characterCount(value) {
  return Array.from(String(value || "")).length;
}

function parseTranslationRequest(data) {
  const text = typeof data?.text === "string" ? data.text.trim() : "";
  const sourceLanguageCode = String(data?.sourceLanguageCode || "").trim().toLowerCase();
  const targetLanguageCode = String(data?.targetLanguageCode || "").trim().toLowerCase();

  if (!text) {
    throw new Error("번역할 메시지가 없습니다.");
  }

  if (characterCount(text) > MAX_TRANSLATION_CHARACTERS) {
    throw new Error(`메시지는 ${MAX_TRANSLATION_CHARACTERS}자 이하만 번역할 수 있습니다.`);
  }

  if (!SUPPORTED_PAIRS.has(`${sourceLanguageCode}:${targetLanguageCode}`)) {
    throw new Error("한국어와 일본어 사이의 번역만 지원합니다.");
  }

  return { text, sourceLanguageCode, targetLanguageCode };
}

function translatedTextFromResponse(response) {
  const translatedText = response?.translations?.[0]?.translatedText;

  if (typeof translatedText !== "string" || !translatedText.trim()) {
    throw new Error("번역 결과가 비어 있습니다.");
  }

  return translatedText.trim();
}

function targetLanguageFor(sourceLanguageCode) {
  if (sourceLanguageCode === "ko") return "ja";
  if (sourceLanguageCode === "ja") return "ko";
  return "";
}

function isFallbackTranslationCandidate(message) {
  return Boolean(
    message &&
    message.type === "text" &&
    (message.uid === "Kevin" || message.uid === "Momo") &&
    message.translationStatus === FALLBACK_TRANSLATION_PENDING &&
    !message.translation &&
    typeof message.text === "string" &&
    message.text.trim() &&
    targetLanguageFor(message.lang)
  );
}

function completeFallbackTranslation(message, translation, translatedAt) {
  const translatedText = String(translation || "").trim();

  if (!isFallbackTranslationCandidate(message) || !translatedText) return undefined;

  return {
    ...message,
    translation:translatedText,
    translationStatus:FALLBACK_TRANSLATION_COMPLETE,
    translationSource:"server-fallback",
    translatedAt
  };
}

function failFallbackTranslation(message, failedAt) {
  if (!isFallbackTranslationCandidate(message)) return undefined;

  return {
    ...message,
    translationStatus:FALLBACK_TRANSLATION_FAILED,
    translationFailedAt:failedAt
  };
}

module.exports = {
  FALLBACK_TRANSLATION_COMPLETE,
  FALLBACK_TRANSLATION_FAILED,
  FALLBACK_TRANSLATION_PENDING,
  MAX_TRANSLATION_CHARACTERS,
  characterCount,
  completeFallbackTranslation,
  failFallbackTranslation,
  isFallbackTranslationCandidate,
  parseTranslationRequest,
  targetLanguageFor,
  translatedTextFromResponse
};
