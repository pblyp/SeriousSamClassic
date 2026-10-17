'use strict';

// Reads the files of a .zip the player picks (their game folder, zipped). Only the
// archive's directory is read up front; each file is read from the archive and
// inflated (with the browser's DecompressionStream) when it is needed, so a large
// archive never has to fit in memory at once.

(() => {
  const EOCD_SIGNATURE = 0x06054b50;           // end of central directory
  const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
  const ZIP64_EOCD_SIGNATURE = 0x06064b50;
  const CENTRAL_SIGNATURE = 0x02014b50;
  const LOCAL_SIGNATURE = 0x04034b50;
  const STORED = 0, DEFLATED = 8;

  async function bytesAt(file, start, length) {
    return new DataView(await file.slice(start, start + length).arrayBuffer());
  }

  const u64 = (view, offset) => view.getUint32(offset, true) + view.getUint32(offset + 4, true) * 0x100000000;

  // where the central directory is, and how many entries it has
  async function findDirectory(file) {
    // the end record is at the end, after a comment of up to 64 KB
    const tailLength = Math.min(file.size, 22 + 65535);
    const tailStart = file.size - tailLength;
    const tail = await bytesAt(file, tailStart, tailLength);
    let eocd = -1;
    for (let i = tailLength - 22; i >= 0; i--) {
      if (tail.getUint32(i, true) === EOCD_SIGNATURE) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) {
      throw new Error('That file is not a .zip archive.');
    }
    let count = tail.getUint16(eocd + 10, true);
    let size = tail.getUint32(eocd + 12, true);
    let offset = tail.getUint32(eocd + 16, true);
    // archives over 4 GB (or with many files) keep the real values in a ZIP64 record
    if (eocd >= 20 && tail.getUint32(eocd - 20, true) === ZIP64_LOCATOR_SIGNATURE) {
      const zip64 = await bytesAt(file, u64(tail, eocd - 20 + 8), 56);
      if (zip64.getUint32(0, true) !== ZIP64_EOCD_SIGNATURE) {
        throw new Error('The .zip archive is damaged.');
      }
      count = u64(zip64, 32);
      size = u64(zip64, 40);
      offset = u64(zip64, 48);
    }
    return { count, size, offset };
  }

  // the sizes and offset of an entry, from its ZIP64 extra field where they didn't fit
  function applyZip64(entry, view, extraStart, extraLength) {
    for (let p = extraStart; p + 4 <= extraStart + extraLength;) {
      const id = view.getUint16(p, true);
      const length = view.getUint16(p + 2, true);
      if (id === 0x0001) {
        let q = p + 4;
        if (entry.size === 0xffffffff) { entry.size = u64(view, q); q += 8; }
        if (entry.compressedSize === 0xffffffff) { entry.compressedSize = u64(view, q); q += 8; }
        if (entry.localOffset === 0xffffffff) { entry.localOffset = u64(view, q); }
        return;
      }
      p += 4 + length;
    }
  }

  async function readEntry(file, entry) {
    // the file's data comes after its local header, whose name and extra field may
    // differ in length from the central directory's
    const header = await bytesAt(file, entry.localOffset, 30);
    if (header.getUint32(0, true) !== LOCAL_SIGNATURE) {
      throw new Error(`The .zip archive is damaged (at ${entry.path}).`);
    }
    const dataStart = entry.localOffset + 30 + header.getUint16(26, true) + header.getUint16(28, true);
    const data = file.slice(dataStart, dataStart + entry.compressedSize);
    if (entry.method === STORED) {
      return data.arrayBuffer();
    }
    const inflated = data.stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const buffer = await new Response(inflated).arrayBuffer();
    if (buffer.byteLength !== entry.size) {
      throw new Error(`The .zip archive is damaged (at ${entry.path}).`);
    }
    return buffer;
  }

  // the files in a .zip: [{ path, size, read() -> Promise<ArrayBuffer> }]
  async function list(file) {
    if (typeof DecompressionStream !== 'function') {
      throw new Error('This browser can\'t unpack .zip archives; please update it.');
    }
    const { count, size, offset } = await findDirectory(file);
    const directory = await bytesAt(file, offset, size);
    const utf8 = new TextDecoder('utf-8');
    const files = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > directory.byteLength || directory.getUint32(p, true) !== CENTRAL_SIGNATURE) {
        throw new Error('The .zip archive is damaged.');
      }
      const flags = directory.getUint16(p + 8, true);
      const nameLength = directory.getUint16(p + 28, true);
      const extraLength = directory.getUint16(p + 30, true);
      const commentLength = directory.getUint16(p + 32, true);
      // (names are UTF-8, or in old archives the DOS code page, which is the same for ASCII)
      const path = utf8.decode(new Uint8Array(directory.buffer, directory.byteOffset + p + 46, nameLength))
        .replace(/\\/g, '/');
      const entry = {
        path,
        method: directory.getUint16(p + 10, true),
        compressedSize: directory.getUint32(p + 20, true),
        size: directory.getUint32(p + 24, true),
        localOffset: directory.getUint32(p + 42, true),
      };
      applyZip64(entry, directory, p + 46 + nameLength, extraLength);
      p += 46 + nameLength + extraLength + commentLength;

      if (path.endsWith('/')) {
        continue;  // a folder
      }
      if (flags & 1) {
        throw new Error('The .zip archive is password protected.');
      }
      if (entry.method !== STORED && entry.method !== DEFLATED) {
        throw new Error('The .zip archive uses a compression the page can\'t unpack; zip it with the usual (deflate) compression.');
      }
      files.push({ path, size: entry.size, read: () => readEntry(file, entry) });
    }
    return files;
  }

  window.ZipReader = { list };
})();
