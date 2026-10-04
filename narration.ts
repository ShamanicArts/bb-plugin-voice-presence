const MIN_CHUNK = 48;
const MAX_CHUNK = 420;

export function sanitizeNarration(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " code omitted ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*+] |\d+[.)] )/gm, "")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function takeNarrationChunk(
  raw: string,
  force = false,
): { readonly chunk: string | null; readonly rest: string } {
  const text = sanitizeNarration(raw);
  if (text.length === 0) return { chunk: null, rest: "" };
  if (!force && text.length < MIN_CHUNK) return { chunk: null, rest: text };
  const ceiling = Math.min(text.length, MAX_CHUNK);
  const window = text.slice(0, ceiling);
  const sentenceMatches = [...window.matchAll(/[.!?](?=\s|$)/g)];
  const sentenceEnd = sentenceMatches.find((match) => (match.index ?? 0) + 1 >= MIN_CHUNK);
  let end = sentenceEnd === undefined ? -1 : (sentenceEnd.index ?? -1) + 1;
  if (end < 0 && (force || text.length >= MAX_CHUNK)) {
    const space = window.lastIndexOf(" ");
    end = space >= MIN_CHUNK ? space : ceiling;
  }
  if (end < 0) return { chunk: null, rest: text };
  return { chunk: text.slice(0, end).trim(), rest: text.slice(end).trim() };
}
