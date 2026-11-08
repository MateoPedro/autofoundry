// A lead's links are only ever absolute http(s) URLs; javascript:, data: and bare hosts come back null.
export function webUrl(raw: string | null | undefined): string | null {
  const url = raw ? URL.parse(raw) : null;
  return url?.protocol === "http:" || url?.protocol === "https:" ? url.href : null;
}
