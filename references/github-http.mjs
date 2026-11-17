// gh --include prefixes the raw body with the HTTP status and headers, including on failure.
export function parseHttp(text) {
  const status = /^HTTP\/\S+ (\d{3})/.exec(text ?? "");
  if (!status) return { status: null, headers: {}, body: text };
  const blank = /\r?\n\r?\n/.exec(text);
  const headers = {};
  for (const line of (blank ? text.slice(0, blank.index) : text).split(/\r?\n/).slice(1)) {
    const at = line.indexOf(":");
    if (at > 0) headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }
  return { status: Number(status[1]), headers, body: blank ? text.slice(blank.index + blank[0].length) : "" };
}

// Retry-After is delay seconds or an HTTP date; an unreadable one waits a minute.
export function retryAt(header, now) {
  header = String(header ?? "").trim();
  if (/^[0-9]+$/.test(header)) return now + Number(header) * 1000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? date : now + 60_000;
}
