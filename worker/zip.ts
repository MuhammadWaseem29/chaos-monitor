// Minimal remote ZIP reader built on HTTP Range requests: it reads the
// central directory from the end of the file and pulls single entries,
// so a program's archive never has to be downloaded in full.

export type ZipEntry = {
  name: string;
  method: number;
  crc: number;
  csize: number;
  usize: number;
  offset: number;
};

const TAIL = 65_557; // max EOCD comment (65535) + EOCD record (22)

const u16 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const u32 = (b: Uint8Array, o: number) => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;

async function range(url: string, spec: string) {
  const res = await fetch(url, { headers: { Range: `bytes=${spec}` } });
  if (res.status !== 206 && res.status !== 200) {
    throw new Error(`range ${spec} -> HTTP ${res.status}`);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  const cr = res.headers.get("content-range"); // bytes a-b/total
  const total = cr ? Number(cr.split("/")[1]) : buf.length;
  const start = cr ? Number(cr.split(" ")[1]!.split("-")[0]) : 0;
  return { buf, total, start, etag: res.headers.get("etag"), full: res.status === 200 };
}

export async function readCentralDirectory(url: string) {
  const tail = await range(url, `-${TAIL}`);
  const b = tail.buf;
  let eocd = -1;
  for (let i = b.length - 22; i >= 0; i--) {
    if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 0x05 && b[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip: end of central directory not found");
  const count = u16(b, eocd + 10);
  const cdSize = u32(b, eocd + 12);
  const cdOffset = u32(b, eocd + 16);
  if (cdOffset === 0xffffffff) throw new Error("zip64 not supported");

  let cd: Uint8Array;
  if (cdOffset >= tail.start) {
    cd = b.subarray(cdOffset - tail.start, cdOffset - tail.start + cdSize);
  } else {
    cd = (await range(url, `${cdOffset}-${cdOffset + cdSize - 1}`)).buf;
  }

  const entries: ZipEntry[] = [];
  const dec = new TextDecoder();
  let p = 0;
  for (let n = 0; n < count && p + 46 <= cd.length; n++) {
    if (u32(cd, p) !== 0x02014b50) break;
    const nameLen = u16(cd, p + 28);
    const extraLen = u16(cd, p + 30);
    const commentLen = u16(cd, p + 32);
    entries.push({
      method: u16(cd, p + 10),
      crc: u32(cd, p + 16),
      csize: u32(cd, p + 20),
      usize: u32(cd, p + 24),
      offset: u32(cd, p + 42),
      name: dec.decode(cd.subarray(p + 46, p + 46 + nameLen)),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { entries, etag: tail.etag, size: tail.total };
}

async function inflate(data: Uint8Array, method: number): Promise<Uint8Array> {
  if (method === 0) return data;
  if (method !== 8) throw new Error(`zip: unsupported compression method ${method}`);
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Downloads and inflates one entry; returns its text plus the archive ETag seen. */
export async function readEntry(url: string, e: ZipEntry) {
  const nameBytes = new TextEncoder().encode(e.name).length;
  let guess = 30 + nameBytes + 512 + e.csize;
  let r = await range(url, `${e.offset}-${e.offset + guess - 1}`);
  let b = r.buf;
  if (u32(b, 0) !== 0x04034b50) throw new Error("zip: bad local header (archive changed?)");
  const start = 30 + u16(b, 26) + u16(b, 28);
  if (start + e.csize > b.length) {
    guess = start + e.csize;
    r = await range(url, `${e.offset}-${e.offset + guess - 1}`);
    b = r.buf;
  }
  const raw = await inflate(b.subarray(start, start + e.csize), e.method);
  return { text: new TextDecoder().decode(raw), etag: r.etag };
}
