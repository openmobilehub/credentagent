// script-json.ts — embed a value in an inline <script> without letting it end the script.
//
// `JSON.stringify` is a correct JS literal but NOT a safe one inside HTML: a string holding
// `</script>` closes the element early and whatever follows runs as markup (#330 — a crafted
// `?cart=` reached RETURN_URL on the consent pages this way). Escaping `<`, `>` and `&` as
// `\u00XX` keeps the literal's value identical while no HTML tokenizer can see a tag, and
// U+2028/U+2029 are escaped because older JS engines treat them as line terminators inside
// a string literal. Every `${…}` that drops a value into a ceremony page's <script> goes
// through here.

const UNSAFE = /[<>&\u2028\u2029]/g;

export function scriptJson(value: unknown): string {
  return (JSON.stringify(value) ?? "undefined").replace(UNSAFE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
