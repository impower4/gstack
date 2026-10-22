import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { readBriefsFile, runBriefsBatch, type BriefEntry } from "../src/variants";

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=";
const CLI = path.resolve(import.meta.dir, "../src/cli.ts");
const STUB = path.resolve(import.meta.dir, "fixtures/briefs-fetch-stub.ts");

type Call = { url: string; text: string };
type Reply = (call: Call, nth: number) => Response;

const image = (result = TINY_PNG_BASE64) =>
  Response.json({ output: [{ type: "image_generation_call", result }] });
const vision = (content: string) => Response.json({ choices: [{ message: { content } }] });

/** Routes image, check and screenshot-analysis requests to separate scripted replies. */
function stubFetch(routes: { image?: Reply; check?: Reply; analysis?: Reply }) {
  const calls: Array<Call & { kind: string }> = [];
  const counts: Record<string, number> = { image: 0, check: 0, analysis: 0 };
  const fetchFn = (async (input: any, init?: any) => {
    const url = String(input);
    const text = String(init?.body ?? "");
    const kind = url.endsWith("/v1/responses") ? "image"
      : text.includes("UI quality checker") ? "check" : "analysis";
    const call = { url, text, kind };
    calls.push(call);
    const reply = routes[kind as keyof typeof routes];
    const nth = counts[kind]++;
    if (reply) return reply(call, nth);
    return kind === "image" ? image() : kind === "check" ? vision("PASS") : vision("A dashboard with a header.");
  }) as typeof globalThis.fetch;
  return { fetchFn, calls };
}

let dir: string;
let savedHome: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "variants-briefs-"));
  savedHome = process.env.GSTACK_HOME;
  process.env.GSTACK_HOME = dir;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.GSTACK_HOME;
  else process.env.GSTACK_HOME = savedHome;
  fs.rmSync(dir, { recursive: true, force: true });
});

const batch = (entries: BriefEntry[], fetchFn: typeof globalThis.fetch, extra: { deadlineMs?: number; staggerMs?: number } = {}) =>
  runBriefsBatch(entries, { apiKey: "sk-test", outputDir: dir, size: "1024x1024", quality: "low", fetchFn, staggerMs: 0, ...extra });

function writeBriefs(value: unknown): string {
  const file = path.join(dir, "briefs.json");
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

describe("readBriefsFile", () => {
  test("accepts 1 to 7 entries with optional screenshots", () => {
    const shot = path.join(dir, "current.png");
    fs.writeFileSync(shot, Buffer.from(TINY_PNG_BASE64, "base64"));
    expect(readBriefsFile(writeBriefs([{ brief: "a" }, { brief: "b", screenshot: shot }])))
      .toEqual([{ brief: "a" }, { brief: "b", screenshot: shot }]);
  });

  test.each([
    ["not an array", { brief: "a" }, "JSON array of 1 to 7"],
    ["empty", [], "JSON array of 1 to 7"],
    ["too many", Array.from({ length: 8 }, () => ({ brief: "x" })), "JSON array of 1 to 7"],
    ["missing brief", [{ brief: "ok" }, { screenshot: "x.png" }], 'entry 1: field "brief"'],
    ["blank brief", [{ brief: "  " }], 'entry 0: field "brief"'],
    ["unknown field", [{ brief: "a", count: 3 }], 'entry 0: unknown field "count"'],
    ["unreadable screenshot", [{ brief: "a", screenshot: "/nonexistent/shot.png" }], 'entry 0: field "screenshot" is not a readable file'],
  ])("%s names the file, entry and field", (_label, value, message) => {
    const file = writeBriefs(value);
    expect(() => readBriefsFile(file)).toThrow(message);
    expect(() => readBriefsFile(file)).toThrow(file);
  });

  test("malformed JSON names the file", () => {
    const file = path.join(dir, "bad.json");
    fs.writeFileSync(file, "[{");
    expect(() => readBriefsFile(file)).toThrow(`--briefs-file ${file}`);
  });
});

describe("runBriefsBatch", () => {
  test("each variant sends its own brief and ends DONE with a passing check", async () => {
    const { fetchFn, calls } = stubFetch({});
    const results = await batch([{ brief: "CALM-DASHBOARD" }, { brief: "BOLD-DASHBOARD" }], fetchFn);
    expect(results.map(r => [r.variant, r.status, r.check?.status, r.operation])).toEqual([
      ["A", "done", "pass", "generate"], ["B", "done", "pass", "generate"],
    ]);
    const images = calls.filter(c => c.kind === "image");
    expect(images).toHaveLength(2);
    expect(images.filter(c => c.text.includes("CALM-DASHBOARD"))).toHaveLength(1);
    expect(images.filter(c => c.text.includes("BOLD-DASHBOARD"))).toHaveLength(1);
    expect(results.map(r => r.saved)).toEqual([[path.join(dir, "variant-A.png")], [path.join(dir, "variant-B.png")]]);
    expect(fs.statSync(path.join(dir, "variant-B.png")).size).toBeGreaterThan(0);
  });

  test("429 backs off and retries the same request", async () => {
    const { fetchFn, calls } = stubFetch({
      image: (_call, nth) => nth === 0 ? new Response("slow down", { status: 429, headers: { "Retry-After": "0" } }) : image(),
    });
    const [result] = await batch([{ brief: "one" }], fetchFn);
    expect(result!.status).toBe("done");
    expect(calls.filter(c => c.kind === "image")).toHaveLength(2);
  });

  test("exhausted 429 retries end RATE_LIMITED and retryable", async () => {
    const { fetchFn } = stubFetch({ image: () => new Response("slow down", { status: 429, headers: { "Retry-After": "0" } }) });
    const [result] = await batch([{ brief: "one" }], fetchFn);
    expect(result).toMatchObject({ status: "rate_limited", retryable: true, check: null, saved: [] });
  });

  test("an empty image is regenerated once", async () => {
    const { fetchFn, calls } = stubFetch({ image: (_call, nth) => nth === 0 ? image("=") : image() });
    const [result] = await batch([{ brief: "one" }], fetchFn);
    expect(result).toMatchObject({ status: "done", saved: [path.join(dir, "variant-A.png")] });
    expect(calls.filter(c => c.kind === "image")).toHaveLength(2);
  });

  test("a failed check regenerates once with the same brief, keeps both images, then rechecks the new one", async () => {
    const { fetchFn, calls } = stubFetch({ check: (_call, nth) => vision(nth === 0 ? "FAIL: header text is garbled" : "PASS") });
    const [result] = await batch([{ brief: "CHECK-ME" }], fetchFn);
    const second = path.join(dir, "variant-A-2.png");
    expect(result).toMatchObject({ status: "done", check: { status: "pass", issues: "" }, path: second });
    expect(result!.saved).toEqual([path.join(dir, "variant-A.png"), second]);
    const images = calls.filter(c => c.kind === "image");
    expect(images).toHaveLength(2);
    expect(images.every(c => c.text.includes("CHECK-ME"))).toBe(true);
    expect(calls.filter(c => c.kind === "check")).toHaveLength(2);
  });

  test("an unavailable check is reported as skipped, never as validated", async () => {
    const { fetchFn } = stubFetch({ check: () => new Response("down", { status: 503 }) });
    const [result] = await batch([{ brief: "one" }], fetchFn);
    expect(result).toMatchObject({ status: "done", check: { status: "skipped" } });
  });

  test("screenshot entries evolve, and a failed check repeats the evolve operation", async () => {
    const shot = path.join(dir, "current.png");
    fs.writeFileSync(shot, Buffer.from(TINY_PNG_BASE64, "base64"));
    const { fetchFn, calls } = stubFetch({ check: (_call, nth) => vision(nth === 0 ? "FAIL: cramped" : "PASS") });
    const [result] = await batch([{ brief: "EVOLVE-ME", screenshot: shot }], fetchFn);
    expect(result).toMatchObject({ operation: "evolve", status: "done", check: { status: "pass" } });
    expect(calls.map(c => c.kind)).toEqual(["analysis", "image", "check", "analysis", "image", "check"]);
    expect(calls.filter(c => c.kind === "image").every(c => c.text.includes("REQUESTED CHANGES") && c.text.includes("EVOLVE-ME"))).toBe(true);
  });

  test("a non-retryable API error fails only its own variant", async () => {
    const { fetchFn } = stubFetch({ image: call => call.text.includes("BROKEN") ? new Response("bad", { status: 400 }) : image() });
    const results = await batch([{ brief: "fine" }, { brief: "BROKEN" }], fetchFn);
    expect(results.map(r => [r.status, r.retryable])).toEqual([["done", false], ["failed", false]]);
  });

  test("the batch deadline stops new launches and in-flight requests; every variant is terminal", async () => {
    const { fetchFn, calls } = stubFetch({});
    const slow = (async (input: any, init?: any) => {
      if (String(input).endsWith("/v1/responses") && String(init?.body).includes("SLOW")) {
        return new Promise<Response>((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        });
      }
      return fetchFn(input, init);
    }) as typeof globalThis.fetch;
    const started = Date.now();
    const results = await batch([{ brief: "SLOW" }, { brief: "late" }], slow, { deadlineMs: 300, staggerMs: 5_000 });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(results.map(r => [r.status, r.retryable, r.error])).toEqual([
      ["failed", true, "Batch deadline reached"],
      ["failed", true, "Batch deadline reached before start"],
    ]);
    expect(calls).toHaveLength(0);
  });
});

describe("$D variants --briefs-file (CLI end to end with a stubbed fetch)", () => {
  const run = (args: string[], fail = "") => {
    const log = path.join(dir, "fetch.log");
    fs.writeFileSync(log, "");
    const result = spawnSync(process.execPath, ["--preload", STUB, CLI, "variants", ...args], {
      cwd: dir,
      env: { PATH: process.env.PATH!, HOME: dir, GSTACK_HOME: dir, OPENAI_API_KEY: "sk-test-stub", BRIEFS_STUB_LOG: log, BRIEFS_STUB_FAIL: fail },
      encoding: "utf-8",
      timeout: 60_000,
    });
    const calls = fs.readFileSync(log, "utf-8").split("\n").filter(Boolean);
    return { ...result, calls };
  };
  const out = () => path.join(dir, "out");

  test("all variants succeed: exit 0, JSON on stdout, status lines on stderr", () => {
    const file = writeBriefs([{ brief: "FIRST" }, { brief: "SECOND" }]);
    const r = run(["--briefs-file", file, "--output-dir", out(), "--count", "5"]);
    expect(r.status, r.stderr).toBe(0);
    const json = JSON.parse(r.stdout);
    expect(json).toMatchObject({ count: 2, succeeded: 2, failed: 0, validated: 2 });
    expect(json.variants.map((v: any) => [v.variant, v.status, v.error, v.retryable])).toEqual([["A", "done", null, false], ["B", "done", null, false]]);
    expect(r.stderr).toContain("--count is ignored");
    expect(r.stderr).toMatch(/VARIANT_A_DONE: /);
    expect(r.stderr).toMatch(/VARIANT_B_DONE: /);
    expect(fs.existsSync(path.join(out(), "variant-B.png"))).toBe(true);
  });

  test("some variants fail: exit 0 with each variant's status in the JSON", () => {
    const file = writeBriefs([{ brief: "FIRST" }, { brief: "BROKEN" }]);
    const r = run(["--briefs-file", file, "--output-dir", out()], "BROKEN");
    expect(r.status, r.stderr).toBe(0);
    const json = JSON.parse(r.stdout);
    expect(json).toMatchObject({ succeeded: 1, failed: 1, paths: [path.join(out(), "variant-A.png")] });
    expect(json.variants[1]).toMatchObject({ status: "failed", retryable: false, saved: [] });
    expect(r.stderr).toMatch(/VARIANT_B_FAILED: API error \(400\)/);
  });

  test("all variants fail: exit 2 with the failures in the JSON", () => {
    const file = writeBriefs([{ brief: "BROKEN" }]);
    const r = run(["--briefs-file", file, "--output-dir", out()], "BROKEN");
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout)).toMatchObject({ succeeded: 0, saved: [], failures: [{ file: path.join(out(), "variant-A.png") }] });
  });

  test("a second round into the same directory never overwrites: names bump and the JSON reports them", () => {
    const file = writeBriefs([{ brief: "FIRST" }]);
    expect(run(["--briefs-file", file, "--output-dir", out()]).status).toBe(0);
    const first = fs.readFileSync(path.join(out(), "variant-A.png"));
    const again = run(["--briefs-file", file, "--output-dir", out()]);
    expect(again.status, again.stderr).toBe(0);
    expect(JSON.parse(again.stdout).variants[0]).toMatchObject({ path: path.join(out(), "variant-A-2.png"), saved: [path.join(out(), "variant-A-2.png")] });
    expect(fs.readFileSync(path.join(out(), "variant-A.png"))).toEqual(first);
  });

  test("invalid input exits 1 before any billable call", () => {
    const file = writeBriefs([{ brief: "fine" }, { brief: "" }]);
    const invalid = run(["--briefs-file", file, "--output-dir", out()]);
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain('entry 1: field "brief"');
    expect(invalid.calls).toHaveLength(0);
    const conflict = run(["--briefs-file", writeBriefs([{ brief: "a" }]), "--brief", "also", "--output-dir", out()]);
    expect(conflict.status).toBe(1);
    expect(conflict.stderr).toContain("cannot be combined with --brief");
    expect(conflict.calls).toHaveLength(0);
  });
});
