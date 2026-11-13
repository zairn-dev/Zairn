"""Collect one result block from the ESP32-S3 firmware (main/main.c).

Waits for the firmware's "ts-bench ready" line, sends 'g', echoes the
progress lines and saves the JSON printed between "=== TS-BEGIN" and
"=== TS-END".

Usage (ESP-IDF Python, which has pyserial):
    python run.py COM10 <dev|val|test> [timeout_s]
Writes ../build/esp32s3/result-<split>.json.
"""
import json
import pathlib
import sys
import time

import serial

SPLIT_ID = {'dev': 0, 'val': 1, 'test': 2}


def main():
    port, split = sys.argv[1], sys.argv[2]
    timeout = float(sys.argv[3]) if len(sys.argv) > 3 else 900.0
    out = pathlib.Path(__file__).resolve().parent.parent / 'build' / 'esp32s3' / f'result-{split}.json'
    s = serial.Serial()
    s.port, s.baudrate, s.timeout = port, 115200, 1
    s.dtr = s.rts = False  # opening the USB-Serial/JTAG port must not reset the chip
    s.open()
    deadline = time.time() + timeout
    buf, inside, lines, started = b'', False, [], False
    while time.time() < deadline:
        buf += s.read(4096)
        while b'\n' in buf:
            raw, buf = buf.split(b'\n', 1)
            text = raw.decode('utf-8', 'replace').rstrip('\r')
            if not started:
                if text.startswith('ts-bench ready'):
                    s.reset_input_buffer()
                    buf = b''
                    s.write(b'g')
                    s.flush()
                    started = True
                    print(text, file=sys.stderr, flush=True)
                    break
                continue
            if text == '=== TS-BEGIN':
                inside, lines = True, []
            elif text == '=== TS-END' and inside:
                result = json.loads(''.join(lines))
                if result['split'] != SPLIT_ID[split]:
                    raise SystemExit(f'board holds split {result["split"]}, expected {split}')
                out.write_text(json.dumps(result, indent=1), encoding='utf-8')
                print(f'wrote {out}')
                return
            elif inside:
                lines.append(text)
            elif text and not text.startswith('ts-bench ready'):
                print(text, file=sys.stderr, flush=True)
    raise SystemExit('timeout waiting for a result block')


if __name__ == '__main__':
    main()
