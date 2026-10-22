/**
 * Preloaded into the design CLI by variants-briefs.test.ts: replaces fetch so
 * `variants --briefs-file` runs end to end without network or billing.
 * BRIEFS_STUB_FAIL lists brief substrings whose image requests return 400.
 * Every call is appended to BRIEFS_STUB_LOG as one JSON line.
 */
import fs from "fs";

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=";
const failing = (process.env.BRIEFS_STUB_FAIL ?? "").split(",").filter(Boolean);

globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input);
  const body = String(init?.body ?? "");
  fs.appendFileSync(process.env.BRIEFS_STUB_LOG!, JSON.stringify({ url, body }) + "\n");
  if (url.endsWith("/v1/chat/completions")) {
    return Response.json({ choices: [{ message: { content: "PASS" } }] });
  }
  if (failing.some(token => body.includes(token))) return new Response("bad request", { status: 400 });
  return Response.json({ output: [{ type: "image_generation_call", result: TINY_PNG_BASE64 }] });
}) as typeof globalThis.fetch;
