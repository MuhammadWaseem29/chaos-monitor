// Known hosts are stored as a sorted list of 53-bit hashes (8 bytes per host),
// base64 encoded in D1. This keeps storage ~10x smaller than raw host lists
// and makes "what is new?" a cheap binary search.

export function hostHash(s: string): number {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
    h2 ^= h2 >>> 15;
  }
  return (h1 >>> 0) * 2097152 + ((h2 >>> 0) & 0x1fffff);
}

type B64 = { toBase64?: () => string };
type B64Ctor = { fromBase64?: (s: string) => Uint8Array };

export function encodeHashes(sorted: Float64Array): string {
  const bytes = new Uint8Array(sorted.buffer, sorted.byteOffset, sorted.byteLength);
  const native = (bytes as unknown as B64).toBase64;
  if (typeof native === "function") return native.call(bytes);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]);
  }
  return btoa(s);
}

export function decodeHashes(b64: string): Float64Array {
  const from = (Uint8Array as unknown as B64Ctor).fromBase64;
  let bytes: Uint8Array;
  if (typeof from === "function") {
    bytes = from(b64);
  } else {
    const bin = atob(b64);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  }
  const aligned = bytes.byteOffset % 8 === 0 ? bytes : bytes.slice();
  return new Float64Array(aligned.buffer, aligned.byteOffset, Math.floor(aligned.byteLength / 8));
}

export function has(sorted: Float64Array, v: number): boolean {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const m = sorted[mid]!;
    if (m === v) return true;
    if (m < v) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}
