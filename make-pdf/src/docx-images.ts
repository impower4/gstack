/**
 * DOCX image guard. html-to-docx 1.8.0 sizes every data-URI <img> with its
 * own bundled copy of image-size 1.x, which the package.json override cannot
 * reach. That copy's detector sends a buffer to its ICNS parser exactly when
 * the bytes start with "icns", and the parser loops forever on a zero-length
 * entry (GHSA-w3rx-r6r6-pgpr). No other parser in the copy has a known flaw.
 *
 * guardDocxImages drops the <img> tags it can see that would size unsafe
 * bytes, then re-parses the result with the same html-to-vdom html-to-docx
 * uses and refuses the document if any <img> it would size is still unsafe,
 * so a tag the regex misreads fails closed instead of hanging.
 */
import HTMLToVDOM from "html-to-vdom";

/** html-to-docx's data-URI pattern, shared by all three of its sizeOf call sites. */
const DATA_URI = /^data:([A-Za-z-+\/]+);base64,(.+)$/;
const IMG_TAG = /<img\b[^>]*>/gi;
const SRC_ATTR = /(?:^|\s)src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

interface ImgNode { tagName?: string; properties?: { src?: unknown }; children?: ImgNode[] }

const toVdom = HTMLToVDOM({
  VNode: function (this: ImgNode, tagName: string, properties: ImgNode["properties"], children: ImgNode[]) {
    Object.assign(this, { tagName, properties, children });
  },
  VText: function () {},
});

function tryDecode(text: string): string | null {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

function isIcns(base64: string | null | undefined): boolean {
  return base64 != null && Buffer.from(base64, "base64").toString("ascii", 0, 4) === "icns";
}

/**
 * False when html-to-docx would hand ICNS bytes to its bundled sizer. Its two
 * paragraph paths match the raw src and URI-decode the payload; buildImage
 * URI-decodes the whole src, matches that, and sizes the payload as is.
 */
function sizesSafely(src: unknown): boolean {
  if (typeof src !== "string") return true;
  const raw = src.match(DATA_URI);
  if (raw && isIcns(tryDecode(raw[2]))) return false;
  return !isIcns(tryDecode(src)?.match(DATA_URI)?.[2]);
}

/** html-to-docx's minifyHTMLString, so the re-parse sees the string it parses. */
function minify(html: string): string {
  return html.replace(/\n/g, " ").replace(/\r/g, " ").replace(/[\t]+</g, "<").replace(/>[\t ]+</g, "><").replace(/>[\t ]+$/g, ">");
}

function* imgSources(nodes: ImgNode | ImgNode[]): Generator<unknown> {
  for (const node of Array.isArray(nodes) ? nodes : [nodes]) {
    if (node.tagName === "img") yield node.properties?.src;
    if (node.children) yield* imgSources(node.children);
  }
}

export function guardDocxImages(html: string, warn: (msg: string) => void): string {
  const guarded = html.replace(IMG_TAG, (tag) => {
    const src = tag.match(SRC_ATTR);
    if (sizesSafely(src?.[1] ?? src?.[2] ?? src?.[3])) return tag;
    warn("docx: dropped an ICNS image (html-to-docx's bundled image-size hangs on it)");
    return "";
  });
  for (const src of imgSources(toVdom(minify(guarded)))) {
    if (!sizesSafely(src)) {
      throw new Error("docx: an <img> tag hides an ICNS image, which html-to-docx's bundled image-size hangs on; convert or remove it");
    }
  }
  return guarded;
}
