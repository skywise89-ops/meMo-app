export const TODO_COUNTRIES = Object.freeze([
  Object.freeze({ value:"kr", label:"한국" }),
  Object.freeze({ value:"jp", label:"일본" })
]);
const countryValues = new Set(TODO_COUNTRIES.map(item => item.value));

export function todoCountry(todo) {
  return countryValues.has(todo?.country) ? todo.country : "kr";
}

export function partitionTodos(data, country = "kr") {
  const all = Object.entries(data || {})
    .filter(([,item]) => item && typeof item === "object")
    .map(([key,item]) => ({ ...item, key }));
  const counts = { kr:0, jp:0 };
  for (const item of all) counts[todoCountry(item)]++;
  const selected = all.filter(item => todoCountry(item) === country);
  const numericTime = value => Number.isFinite(Number(value)) ? Number(value) : 0;
  const newest = field => (a,b) => numericTime(b[field]) - numericTime(a[field]) || a.key.localeCompare(b.key);
  return {
    active:selected.filter(item => !item.isDone).sort(newest("createdAt")),
    done:selected.filter(item => item.isDone).sort(newest("completedAt")),
    total:selected.length,
    counts
  };
}

export function validateTodoText(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error("버킷 내용을 입력해주세요.");
  if (text.length > 500) throw new Error("버킷 내용은 500자 이내로 입력해주세요.");
  return text;
}

export function buildTodoEditPatch(todo, values, editorName, now = Date.now()) {
  if (!todo || typeof todo !== "object") throw new Error("이미 삭제된 항목입니다.");
  const text = validateTodoText(values?.text);
  const country = values?.country;
  if (!countryValues.has(country)) throw new Error("한국 또는 일본을 선택해주세요.");
  if (!Number.isFinite(now) || now < 0) throw new Error("수정 시간을 확인해주세요.");
  return { text, country, updatedAt:now, updatedBy:String(editorName || "") };
}

export function isTodoEditStale(base, current) {
  if (!base || !current) return true;
  return base.text !== current.text
    || todoCountry(base) !== todoCountry(current)
    || (base.updatedAt || null) !== (current.updatedAt || null);
}
