/**
 * Client-side demo decompression by magic bytes.
 *
 * gzip (`.dem.gz`, the common FACEIT format) uses the browser-native
 * DecompressionStream — zero deps. Raw `.dem` (PBDEMS2 / HL2DEMO) passes
 * through. zstd/bz2 need a WASM lib and are deferred to Phase 2 — we throw a
 * clear message rather than feeding the parser garbage.
 */

export async function decompressDemo(input: Uint8Array): Promise<Uint8Array> {
  // gzip: 1f 8b
  if (input[0] === 0x1f && input[1] === 0x8b) {
    const ds = new DecompressionStream('gzip');
    const stream = new Blob([input as BlobPart]).stream().pipeThrough(ds);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }
  // bzip2: 'BZh'
  if (input[0] === 0x42 && input[1] === 0x5a && input[2] === 0x68) {
    throw new Error('.dem.bz2 demos are not supported yet in the web build.');
  }
  // zstd: 28 b5 2f fd
  if (input[0] === 0x28 && input[1] === 0xb5 && input[2] === 0x2f && input[3] === 0xfd) {
    throw new Error('.dem.zst demos are not supported yet in the web build.');
  }
  return input; // raw .dem
}
