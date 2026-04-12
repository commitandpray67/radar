"""
excel_to_whatsapp.py
--------------------
Daily automation: capture a specific Excel range as an image and send it
to a WhatsApp contact or group.

Requirements
    pip install xlwings pillow pywhatkit schedule

    xlwings requires Microsoft Excel to be installed on the machine.
    If Excel is not available, set USE_XLWINGS = False to use the
    openpyxl + Pillow fallback renderer instead.

Scheduling
    Option A (recommended): add this script to Windows Task Scheduler.
    Option B: run `python excel_to_whatsapp.py --schedule` to use the
              built-in scheduler (keeps the process alive all day).
"""

import argparse
import logging
import os
import time
from datetime import datetime
from pathlib import Path

# ---------------------------------------------------------------------------
# Configuration — edit these values
# ---------------------------------------------------------------------------

EXCEL_FILE = r"C:\path\to\your\file.xlsx"   # absolute path to your workbook
SHEET_NAME = "Sheet1"                        # sheet containing the range
CELL_RANGE = "A1:H20"                        # range to capture

OUTPUT_DIR = Path(__file__).parent / "output"
OUTPUT_FILENAME = "daily_report_{date}.png"  # {date} is replaced automatically

# WhatsApp settings
# Set RECIPIENT_TYPE to "contact" or "group"
RECIPIENT_TYPE = "contact"
# For a contact use the international number WITHOUT the leading '+', e.g. "447911123456"
WHATSAPP_NUMBER = "447911123456"
# For a group use the group ID found in the invite link, e.g. "ABC123XYZ456"
WHATSAPP_GROUP_ID = ""

# Time to send (24-hour clock).  pywhatkit opens WhatsApp Web ~15 s before this.
SEND_HOUR = 9
SEND_MINUTE = 0

# Set to False to use the openpyxl + Pillow fallback (no Excel required)
USE_XLWINGS = True

# ---------------------------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)s  %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Step 1: Capture the Excel range as a PNG
# ---------------------------------------------------------------------------

def capture_range_xlwings(excel_file: str, sheet_name: str, cell_range: str,
                           output_path: Path) -> Path:
    """Use xlwings + Excel's CopyPicture for a pixel-perfect screenshot."""
    import xlwings as xw

    log.info("Opening %s with xlwings …", excel_file)
    app = xw.App(visible=False)
    try:
        wb = app.books.open(excel_file)
        sheet = wb.sheets[sheet_name]
        rng = sheet.range(cell_range)

        # Export the range as an image via the Pictures API
        output_path.parent.mkdir(parents=True, exist_ok=True)
        rng.to_png(str(output_path))
        log.info("Range saved to %s", output_path)
    finally:
        app.quit()

    return output_path


def capture_range_openpyxl(excel_file: str, sheet_name: str, cell_range: str,
                            output_path: Path) -> Path:
    """
    Fallback renderer using openpyxl + Pillow.
    Renders cell values as plain text — no cell formatting or colours.
    Suitable when Microsoft Excel is not installed.
    """
    import openpyxl
    from PIL import Image, ImageDraw, ImageFont

    log.info("Opening %s with openpyxl …", excel_file)
    wb = openpyxl.load_workbook(excel_file, data_only=True)
    ws = wb[sheet_name]

    rows = list(ws[cell_range])
    if not rows:
        raise ValueError(f"Range {cell_range!r} returned no data.")

    # Collect cell values
    data = [[str(cell.value if cell.value is not None else "") for cell in row]
            for row in rows]

    # Measure column widths
    col_widths = [max(len(row[c]) for row in data) for c in range(len(data[0]))]

    cell_w = 12   # pixels per character
    cell_h = 22   # row height in pixels
    padding = 6

    img_w = sum(w * cell_w + padding * 2 for w in col_widths) + padding
    img_h = len(data) * cell_h + padding * 2

    img = Image.new("RGB", (img_w, img_h), color=(255, 255, 255))
    draw = ImageDraw.Draw(img)

    try:
        font = ImageFont.truetype("arial.ttf", 11)
    except OSError:
        font = ImageFont.load_default()

    x_start = padding
    for row_idx, row in enumerate(data):
        y = padding + row_idx * cell_h
        x = x_start
        for col_idx, value in enumerate(row):
            draw.text((x, y), value, fill=(0, 0, 0), font=font)
            x += col_widths[col_idx] * cell_w + padding * 2

    output_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(str(output_path))
    log.info("Range saved to %s", output_path)
    return output_path


def capture_range(excel_file: str, sheet_name: str, cell_range: str,
                  output_path: Path) -> Path:
    if USE_XLWINGS:
        return capture_range_xlwings(excel_file, sheet_name, cell_range, output_path)
    return capture_range_openpyxl(excel_file, sheet_name, cell_range, output_path)


# ---------------------------------------------------------------------------
# Step 2: Send via WhatsApp
# ---------------------------------------------------------------------------

def send_whatsapp(image_path: Path, hour: int, minute: int) -> None:
    """Send the image via WhatsApp Web using pywhatkit."""
    import pywhatkit as pwk

    caption = f"Daily report – {datetime.now().strftime('%d %b %Y')}"
    image_str = str(image_path)

    log.info(
        "Scheduling WhatsApp send at %02d:%02d …", hour, minute
    )

    if RECIPIENT_TYPE == "group":
        if not WHATSAPP_GROUP_ID:
            raise ValueError("Set WHATSAPP_GROUP_ID for group messages.")
        pwk.sendwhats_image_togroup(
            WHATSAPP_GROUP_ID,
            image_str,
            caption,
            hour,
            minute,
            tab_close=True,
        )
    else:
        if not WHATSAPP_NUMBER:
            raise ValueError("Set WHATSAPP_NUMBER for contact messages.")
        pwk.sendwhats_image(
            f"+{WHATSAPP_NUMBER}",
            image_str,
            caption,
            hour,
            minute,
            tab_close=True,
        )

    log.info("Message handed off to pywhatkit.")


# ---------------------------------------------------------------------------
# Step 3: Orchestrate
# ---------------------------------------------------------------------------

def run_once() -> None:
    """Capture the range and send it now (using the configured SEND_HOUR/MINUTE)."""
    date_str = datetime.now().strftime("%Y-%m-%d")
    output_path = OUTPUT_DIR / OUTPUT_FILENAME.format(date=date_str)

    image_path = capture_range(EXCEL_FILE, SHEET_NAME, CELL_RANGE, output_path)
    send_whatsapp(image_path, SEND_HOUR, SEND_MINUTE)


def run_scheduled() -> None:
    """Keep the process alive and fire once per day at SEND_HOUR:SEND_MINUTE."""
    import schedule

    schedule.every().day.at(f"{SEND_HOUR:02d}:{SEND_MINUTE:02d}").do(run_once)
    log.info(
        "Scheduler started. Will run daily at %02d:%02d. Press Ctrl+C to stop.",
        SEND_HOUR,
        SEND_MINUTE,
    )
    while True:
        schedule.run_pending()
        time.sleep(30)


# ---------------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Capture an Excel range and send it to WhatsApp."
    )
    parser.add_argument(
        "--schedule",
        action="store_true",
        help="Keep running and send daily at the configured time.",
    )
    parser.add_argument(
        "--now",
        action="store_true",
        help="Run immediately (ignores SEND_HOUR / SEND_MINUTE for the wait).",
    )
    args = parser.parse_args()

    if args.now:
        now = datetime.now()
        SEND_HOUR = now.hour
        SEND_MINUTE = now.minute + 2   # pywhatkit needs at least 1-2 min ahead
        run_once()
    elif args.schedule:
        run_scheduled()
    else:
        run_once()
