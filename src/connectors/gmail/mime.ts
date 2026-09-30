import { createHash } from "node:crypto";

export type MimeInput = {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  textBody?: string;
  htmlBody?: string;
  messageId: string;
  date?: Date;
};

const CRLF = "\r\n";
const isAscii = (s: string) => /^[\x20-\x7e]*$/.test(s);

/** RFC 2047 encoded-word, split so each word stays under 75 chars. */
export function encodeHeaderText(text: string): string {
  if (isAscii(text)) return text;
  const words: string[] = [];
  let chunk = "";
  for (const ch of text) {
    if (Buffer.byteLength(chunk + ch) > 40) {
      words.push(chunk);
      chunk = "";
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w).toString("base64")}?=`).join(" ");
}

const b64lines = (s: string) =>
  (
    Buffer.from(s, "utf8")
      .toString("base64")
      .match(/.{1,76}/g) ?? []
  ).join(CRLF);

function assertNoCrlf(label: string, v: string) {
  if (/[\r\n\u0000]/.test(v)) throw new Error(`Invalid ${label}`);
}

/** Builds an RFC 5322 message. Every header value is checked so input can never inject a header. */
export function buildMime(i: MimeInput): string {
  for (const [k, v] of Object.entries({ from: i.from, subject: i.subject, messageId: i.messageId }))
    assertNoCrlf(k, v);
  for (const a of [...i.to, ...i.cc, ...i.bcc]) assertNoCrlf("recipient", a);
  const headers = [
    `From: ${i.from}`,
    `To: ${i.to.join(", ")}`,
    ...(i.cc.length ? [`Cc: ${i.cc.join(", ")}`] : []),
    ...(i.bcc.length ? [`Bcc: ${i.bcc.join(", ")}`] : []),
    `Subject: ${encodeHeaderText(i.subject)}`,
    `Date: ${(i.date ?? new Date()).toUTCString()}`,
    `Message-ID: <${i.messageId}>`,
    "MIME-Version: 1.0",
  ];
  const text = i.textBody?.trim() ? i.textBody : undefined;
  const html = i.htmlBody?.trim() ? i.htmlBody : undefined;
  const part = (type: string, body: string) =>
    [
      `Content-Type: ${type}; charset="UTF-8"`,
      "Content-Transfer-Encoding: base64",
      "",
      b64lines(body),
    ].join(CRLF);
  if (text && html) {
    const boundary = `=_aai_${createHash("sha256").update(i.messageId).digest("hex").slice(0, 24)}`;
    return [
      ...headers,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      part("text/plain", text),
      `--${boundary}`,
      part("text/html", html),
      `--${boundary}--`,
      "",
    ].join(CRLF);
  }
  return [...headers, part(html ? "text/html" : "text/plain", (html ?? text) as string), ""].join(
    CRLF,
  );
}

/** Message-ID derived from the approval's idempotency key, in the sender's own domain. */
export const messageIdFor = (idempotencyKey: string, from: string) =>
  `aai-${idempotencyKey}@${from.slice(from.lastIndexOf("@") + 1)}`;
