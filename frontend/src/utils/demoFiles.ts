/**
 * Accepted demo upload file types.
 *
 * CS2 demos are `.dem`, but FACEIT ships them compressed — `.dem.zst`
 * (Zstandard, current) or `.dem.gz` (gzip, older). The backend decompresses
 * these automatically on upload, so we accept them here too.
 */

/** `accept` attribute for <input type="file"> pickers. */
export const DEMO_ACCEPT = '.dem,.zst,.gz';

const ACCEPTED_SUFFIXES = ['.dem', '.dem.zst', '.zst', '.dem.gz', '.gz'];

/** True if a filename is an accepted demo (raw or compressed). */
export function isAcceptedDemoFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  return ACCEPTED_SUFFIXES.some((s) => lower.endsWith(s));
}
