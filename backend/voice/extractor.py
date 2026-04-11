"""
Voice line extractor for CS2 demo files.

Uses demoparser2.parse_voice() to extract raw voice packets, decodes them
with opuslib (libopus), and writes per-player WAV files for browser playback.

CS2 voice format
----------------
Each VoiceData.bytes entry is a single Steam Voice network packet.  In CS2
the codec is Opus.  The packet contains zero or more "sections" each of which
carries one raw Opus frame:

  [uint8  : section_type   ]   0x15 (21) = Opus,  0xFF = end-of-packet
  [uint16 : section_length ]   little-endian
  [bytes  : opus_frame     ]   raw Opus bitstream (NOT an OGG container)

Some packet variants omit the section header entirely and are just a raw Opus
frame.  We try both forms.

Opus parameters
  - encoder sample-rate: 22 050 Hz  (Steam voice default)
  - channels:             1 (mono)
  - frame duration:       20 ms  → 441 samples @ 22050 Hz
"""

from __future__ import annotations

import logging
import struct
import wave
from io import BytesIO
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# ── Audio constants ───────────────────────────────────────────────────────────
_SAMPLE_RATE   = 22050          # Hz — Steam voice Opus sample rate
_CHANNELS      = 1              # mono
_FRAME_MS      = 20             # ms per Opus frame (fixed by encoder)
_FRAME_SAMPLES = int(_SAMPLE_RATE * _FRAME_MS / 1000)   # 441 samples
_BYTES_PER_SAMPLE = 2           # 16-bit signed PCM

# Steam Voice section type that carries Opus frames
_OPUS_SECTION_TYPES = {0x15, 11, 21}


# ── Low-level packet decoder ─────────────────────────────────────────────────

def _decode_raw_opus_frame(data: bytes, decoder) -> Optional[bytes]:
    """Try to decode `data` as a raw Opus frame.  Returns PCM bytes or None."""
    try:
        # opuslib.Decoder.decode(data, frame_size) → bytes of 16-bit PCM
        pcm = decoder.decode(data, _FRAME_SAMPLES, decode_fec=False)
        return pcm if pcm else None
    except Exception:
        return None


def _decode_steam_voice_packet(data: bytes, decoder) -> Optional[bytes]:
    """
    Decode one Steam Voice packet to raw 16-bit PCM.

    Tries three strategies in order:
      1. Raw Opus frame (no header)
      2. Steam Voice section framing (type + length + frame)
      3. Skip first 1-4 bytes and retry as raw Opus

    Returns the first successful PCM payload, or None.
    """
    if not data:
        return None

    # Strategy 1 — raw Opus
    pcm = _decode_raw_opus_frame(data, decoder)
    if pcm:
        return pcm

    # Strategy 2 — Steam Voice section framing
    offset = 0
    while offset + 3 <= len(data):
        sec_type = data[offset]
        if sec_type == 0xFF:
            break  # end-of-packet marker
        sec_len = struct.unpack_from("<H", data, offset + 1)[0]
        offset += 3
        if sec_len == 0 or offset + sec_len > len(data):
            break
        payload = data[offset: offset + sec_len]
        offset += sec_len
        if sec_type in _OPUS_SECTION_TYPES:
            pcm = _decode_raw_opus_frame(payload, decoder)
            if pcm:
                return pcm

    # Strategy 3 — skip N-byte header then try raw Opus
    for skip in (1, 2, 3, 4, 5, 6, 7):
        if len(data) <= skip:
            break
        pcm = _decode_raw_opus_frame(data[skip:], decoder)
        if pcm:
            return pcm

    return None


# ── Per-player WAV builder ────────────────────────────────────────────────────

def _build_player_wav(
    packets: list[dict],
    round_start_tick: int,
    round_end_tick: int,
    tick_rate: float,
) -> Optional[bytes]:
    """
    Decode all voice packets for one player into a single WAV blob.

    The WAV covers [round_start_tick, round_end_tick].  Voice data is placed
    at the correct time offset; silence fills the gaps.

    Returns WAV bytes or None if nothing decoded successfully.
    """
    try:
        import opuslib  # noqa: PLC0415
    except ImportError:
        logger.warning("opuslib not installed — cannot decode CS2 voice")
        return None

    try:
        decoder = opuslib.Decoder(_SAMPLE_RATE, _CHANNELS)
    except Exception as exc:
        logger.warning("Cannot create Opus decoder: %s", exc)
        return None

    round_ticks = max(1, round_end_tick - round_start_tick)
    total_samples = int(round_ticks / tick_rate * _SAMPLE_RATE) + _FRAME_SAMPLES
    buf = bytearray(total_samples * _BYTES_PER_SAMPLE)  # initialised to silence (0)

    decoded_count = 0
    for pkt in sorted(packets, key=lambda p: p["tick"]):
        raw: bytes = pkt.get("bytes") or b""
        if not raw:
            continue

        pcm = _decode_steam_voice_packet(raw, decoder)
        if not pcm:
            continue

        tick_offset = pkt["tick"] - round_start_tick
        if tick_offset < 0:
            continue
        sample_offset = int(tick_offset / tick_rate * _SAMPLE_RATE)
        byte_offset = sample_offset * _BYTES_PER_SAMPLE

        if byte_offset >= len(buf):
            continue

        available = len(buf) - byte_offset
        write_len = min(len(pcm), available)
        buf[byte_offset: byte_offset + write_len] = pcm[:write_len]
        decoded_count += 1

    if decoded_count == 0:
        logger.debug("No Opus frames decoded for this player")
        return None

    # Encode PCM buffer as WAV
    wav_io = BytesIO()
    with wave.open(wav_io, "wb") as wf:
        wf.setnchannels(_CHANNELS)
        wf.setsampwidth(_BYTES_PER_SAMPLE)
        wf.setframerate(_SAMPLE_RATE)
        wf.writeframes(bytes(buf))

    return wav_io.getvalue()


# ── Public API ────────────────────────────────────────────────────────────────

def extract_voice_for_round(
    demo_path: str,
    round_start_tick: int,
    round_end_tick: int,
    tick_rate: float,
    output_dir: Path,
) -> dict[int, Path]:
    """
    Extract per-player voice WAV files for the given round tick range.

    Files are written to ``output_dir/{steamid}.wav``.  Already-existing files
    are reused (cached).

    Returns
    -------
    dict mapping steamid (int) → WAV path for players that had voice data.
    An empty dict means no voice data found or all decoding failed.
    """
    output_dir.mkdir(parents=True, exist_ok=True)

    # Parse voice packets from demo
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

    logger.info(
        "parse_voice() returned %d packets for %s",
        len(all_packets), demo_path,
    )

    # Filter to this round and group by steamid
    by_player: dict[int, list[dict]] = {}
    for pkt in all_packets:
        tick = pkt.get("tick", -1)
        if tick < round_start_tick or tick > round_end_tick:
            continue
        steamid = pkt.get("steamid", 0)
        if steamid == 0:
            continue
        by_player.setdefault(steamid, []).append(pkt)

    if not by_player:
        logger.info(
            "No voice packets in tick range [%d, %d]",
            round_start_tick, round_end_tick,
        )
        return {}

    result: dict[int, Path] = {}
    for steamid, packets in by_player.items():
        out_path = output_dir / f"{steamid}.wav"

        if out_path.exists():
            logger.debug("Voice cache hit for steamid %d", steamid)
            result[steamid] = out_path
            continue

        wav_bytes = _build_player_wav(
            packets, round_start_tick, round_end_tick, tick_rate,
        )
        if wav_bytes is None:
            logger.debug("Voice decode failed for steamid %d", steamid)
            continue

        out_path.write_bytes(wav_bytes)
        logger.info(
            "Voice extracted: steamid=%d  %d packets → %d bytes WAV",
            steamid, len(packets), len(wav_bytes),
        )
        result[steamid] = out_path

    return result
