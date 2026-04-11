"""
Voice line extractor for CS2 demo files — pure Python, no native libraries.

Uses demoparser2.parse_voice() to extract raw voice packets from the demo.
Each packet contains Steam Voice framing around raw Opus frames.

The raw Opus frames are wrapped into minimal OGG Opus containers that the
browser can decode natively via Web Audio API (decodeAudioData).  No libopus
or any other native library is required on the server.

Steam Voice packet format (CS2)
--------------------------------
A packet is a sequence of zero or more sections followed by 0xFF:

    [uint8  section_type ]   11 or 21 = Opus audio frame
    [uint16 section_length]  payload length, little-endian
    [bytes  opus_frame   ]   raw Opus bitstream (NOT an OGG container)
    ... repeated ...
    [0xFF   end marker   ]

Some packets omit the framing and are just a raw Opus frame.

OGG Opus container (RFC 7845)
-------------------------------
Each clip is written as a valid OGG Opus file with:
  - Page 0 (BOS): OpusHead identification header
  - Page 1: OpusTags comment header
  - Pages 2..N: one raw Opus frame per page

Granule positions count 48 kHz PCM samples; each 20 ms frame = 960 samples.
pre_skip = 312 (standard minimal value).

The browser's Web Audio API decodes these files without any server-side
native libraries.
"""

from __future__ import annotations

import logging
import random
import struct
from pathlib import Path

logger = logging.getLogger(__name__)

# ── Steam Voice constants ─────────────────────────────────────────────────────

# Section types that carry Opus frames in Steam voice packets
_OPUS_SECTION_TYPES = frozenset({6, 11, 21, 22})

# Tick gap threshold between packets → starts a new clip (~2 s at 64 tick/s)
_CLIP_GAP_TICKS = 128


# ── OGG CRC-32/MPEG-2 ────────────────────────────────────────────────────────
# Polynomial 0x04C11DB7, initial value 0, unreflected, no final XOR.

def _make_crc_table() -> list[int]:
    table = []
    for i in range(256):
        crc = i << 24
        for _ in range(8):
            if crc & 0x80000000:
                crc = ((crc << 1) ^ 0x04C11DB7) & 0xFFFFFFFF
            else:
                crc = (crc << 1) & 0xFFFFFFFF
        table.append(crc)
    return table


_CRC_TABLE = _make_crc_table()


def _ogg_crc32(data: bytes) -> int:
    crc = 0
    for byte in data:
        crc = ((crc << 8) ^ _CRC_TABLE[((crc >> 24) ^ byte) & 0xFF]) & 0xFFFFFFFF
    return crc


# ── OGG page builder ──────────────────────────────────────────────────────────

def _packet_segments(payload: bytes) -> list[int]:
    """Compute the OGG lacing segment table for one packet."""
    segs: list[int] = []
    remaining = len(payload)
    while remaining >= 255:
        segs.append(255)
        remaining -= 255
    segs.append(remaining)          # final segment < 255 signals end-of-packet
    # If the last chunk happened to be exactly 255 bytes, append a 0-terminator
    # (this case is handled by the while condition above; remaining will be 0)
    return segs


def _build_ogg_page(
    payload: bytes,
    granule: int,
    serial: int,
    seq: int,
    flags: int = 0,
) -> bytes:
    """
    Build a single OGG page containing exactly one packet.

    flags: 0 = normal, 2 = BOS (beginning of stream), 4 = EOS (end of stream)
    """
    segs = _packet_segments(payload)

    # Fixed 27-byte header (CRC field zeroed for computation)
    header = struct.pack(
        "<4sBBqIIIB",
        b"OggS",
        0,           # stream structure version
        flags,       # header type flag
        granule,     # absolute granule position (int64 LE)
        serial,      # stream serial number
        seq,         # page sequence number
        0,           # checksum placeholder
        len(segs),   # number of page segments
    )
    header += bytes(segs)
    page = header + payload

    # Compute and splice in CRC
    crc = _ogg_crc32(page)
    return page[:22] + struct.pack("<I", crc) + page[26:]


# ── OGG Opus header packets ───────────────────────────────────────────────────

_PRE_SKIP = 312           # samples to discard at start (standard minimal value)
_OPUS_SAMPLE_RATE = 48000
_SAMPLES_PER_FRAME = 960  # 20 ms at 48 kHz


def _opus_head() -> bytes:
    return struct.pack(
        "<8sBBHIhB",
        b"OpusHead",
        1,                  # version
        1,                  # channel count (mono)
        _PRE_SKIP,          # pre-skip (uint16 LE)
        _OPUS_SAMPLE_RATE,  # input sample rate (uint32 LE, informational)
        0,                  # output gain (int16 LE)
        0,                  # channel mapping family (0 = RTP mono/stereo)
    )


def _opus_tags() -> bytes:
    vendor = b"cs2radar"
    return (
        struct.pack("<8sI", b"OpusTags", len(vendor))
        + vendor
        + struct.pack("<I", 0)   # zero user comment list entries
    )


# ── OGG Opus file assembler ───────────────────────────────────────────────────

def _build_ogg_opus(frames: list[bytes]) -> bytes:
    """
    Wrap a list of raw Opus frames into a minimal valid OGG Opus container.
    Returns the file as bytes, or b"" if frames is empty.
    """
    if not frames:
        return b""

    serial = random.randint(1, 0x7FFFFFFF)
    out = bytearray()

    # Page 0 — identification header (BOS)
    out += _build_ogg_page(_opus_head(), granule=0, serial=serial, seq=0, flags=2)

    # Page 1 — comment header
    out += _build_ogg_page(_opus_tags(), granule=0, serial=serial, seq=1, flags=0)

    # Audio pages — one frame per page
    granule = _PRE_SKIP
    for i, frame in enumerate(frames):
        granule += _SAMPLES_PER_FRAME
        is_last = i == len(frames) - 1
        out += _build_ogg_page(
            frame,
            granule=granule,
            serial=serial,
            seq=i + 2,
            flags=4 if is_last else 0,  # EOS flag on last page
        )

    return bytes(out)


# ── Steam Voice packet parser ─────────────────────────────────────────────────

def _extract_opus_frames(data: bytes) -> list[bytes]:
    """
    Extract raw Opus frames from one Steam Voice network packet.

    Tries Steam Voice section framing first.  If no valid framing is found,
    treats the entire payload as a single raw Opus frame.
    """
    if not data:
        return []

    frames: list[bytes] = []
    offset = 0
    found_framing = False

    while offset + 3 <= len(data):
        sec_type = data[offset]
        if sec_type == 0xFF:
            found_framing = True
            break
        sec_len = struct.unpack_from("<H", data, offset + 1)[0]
        offset += 3
        if sec_len == 0:
            found_framing = True
            break
        if offset + sec_len > len(data):
            break
        payload = data[offset: offset + sec_len]
        offset += sec_len
        if sec_type in _OPUS_SECTION_TYPES:
            frames.append(payload)
            found_framing = True

    if found_framing and frames:
        return frames

    # Fallback: treat entire packet as a single raw Opus frame
    return [data]


# ── Clip grouping ─────────────────────────────────────────────────────────────

def _group_into_clips(
    packets: list[dict],
    gap_ticks: int = _CLIP_GAP_TICKS,
) -> list[tuple[int, list[bytes]]]:
    """
    Group voice packets (sorted by tick) into contiguous clips.

    A new clip starts when the gap between consecutive packets exceeds
    gap_ticks.  Returns [(start_tick, [frame, ...]), ...].
    """
    if not packets:
        return []

    clips: list[tuple[int, list[bytes]]] = []
    clip_start = packets[0]["tick"]
    clip_frames: list[bytes] = []
    prev_tick = packets[0]["tick"]

    for pkt in packets:
        tick: int = pkt.get("tick", 0)
        raw: bytes = pkt.get("bytes") or b""

        if clip_frames and (tick - prev_tick) > gap_ticks:
            clips.append((clip_start, clip_frames))
            clip_start = tick
            clip_frames = []

        clip_frames.extend(_extract_opus_frames(raw))
        prev_tick = tick

    if clip_frames:
        clips.append((clip_start, clip_frames))

    return clips


# ── Public API ────────────────────────────────────────────────────────────────

def extract_voice_for_round(
    demo_path: str,
    round_start_tick: int,
    round_end_tick: int,
    tick_rate: float,  # noqa: ARG001 — kept for API compatibility
    output_dir: Path,
) -> dict[int, list[tuple[int, Path]]]:
    """
    Extract per-player voice clips (OGG Opus) for the given round tick range.

    Files are written to ``output_dir/{steamid}_{clip_index}.ogg``.
    Already-existing files are reused (cached); parse_voice() is still called
    to obtain the clip start-ticks.

    Returns
    -------
    dict mapping steamid → list of (start_tick, ogg_path).
    Empty dict means no voice data or all extraction failed.
    """
    output_dir.mkdir(parents=True, exist_ok=True)

    # Parse voice packets from the demo file
    try:
        from demoparser2 import DemoParser  # noqa: PLC0415
        parser = DemoParser(demo_path)
        all_packets: list[dict] = parser.parse_voice()
    except Exception as exc:
        logger.error("parse_voice() failed for %s: %s", demo_path, exc)
        return {}

    if not all_packets:
        logger.info("Demo %s has no voice data", demo_path)
        return {}

    logger.info("parse_voice() returned %d packets for %s", len(all_packets), demo_path)

    # Filter to this round's tick range and group by steamid
    by_player: dict[int, list[dict]] = {}
    for pkt in all_packets:
        tick: int = pkt.get("tick", -1)
        if tick < round_start_tick or tick > round_end_tick:
            continue
        steamid: int = pkt.get("steamid", 0)
        if steamid == 0:
            continue
        by_player.setdefault(steamid, []).append(pkt)

    if not by_player:
        logger.info(
            "No voice packets in tick range [%d, %d]",
            round_start_tick, round_end_tick,
        )
        return {}

    result: dict[int, list[tuple[int, Path]]] = {}

    for steamid, packets in by_player.items():
        sorted_pkts = sorted(packets, key=lambda p: p.get("tick", 0))
        clips = _group_into_clips(sorted_pkts)

        if not clips:
            continue

        player_clips: list[tuple[int, Path]] = []

        for clip_idx, (start_tick, frames) in enumerate(clips):
            out_path = output_dir / f"{steamid}_{clip_idx}.ogg"

            if out_path.exists():
                logger.debug("Voice cache hit: steamid=%d clip=%d", steamid, clip_idx)
                player_clips.append((start_tick, out_path))
                continue

            ogg_bytes = _build_ogg_opus(frames)
            if not ogg_bytes:
                logger.debug("Empty OGG for steamid=%d clip=%d", steamid, clip_idx)
                continue

            out_path.write_bytes(ogg_bytes)
            logger.info(
                "Voice extracted: steamid=%d  clip=%d  start_tick=%d  frames=%d  bytes=%d",
                steamid, clip_idx, start_tick, len(frames), len(ogg_bytes),
            )
            player_clips.append((start_tick, out_path))

        if player_clips:
            result[steamid] = player_clips

    return result
