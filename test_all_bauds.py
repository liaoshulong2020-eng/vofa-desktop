#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
==============================================================================
 Multi-Baud Rate Auto-Detection Engine for COM11
 Tests 115200, 921600, 2000000, 3000000, 500000, 460800, 9600
 ==============================================================================
"""

import sys
import time
import struct
import serial

def test_bauds():
    port = 'COM11'
    bauds = [3000000, 2000000, 1500000, 921600, 460800, 230400, 115200, 57600, 9600]
    tail = b'\x00\x00\x80\x7f'

    print(f"=== Multi-Baud Rate Scanner for {port} ===", flush=True)

    for b in bauds:
        try:
            ser = serial.Serial()
            ser.port = port
            ser.baudrate = b
            ser.timeout = 0.2
            ser.dtr = False
            ser.rts = False
            ser.open()

            rx = bytearray()
            t0 = time.time()
            while time.time() - t0 < 0.4:
                if ser.in_waiting > 0:
                    rx.extend(ser.read(ser.in_waiting))
                else:
                    time.sleep(0.005)
            ser.close()

            has_tail = rx.count(tail) > 0
            has_non_zero = any(x != 0 for x in rx)
            sample_hex = rx[:24].hex(' ').upper() if rx else "NO DATA"

            print(f"Baud: {b:8d} | Received: {len(rx):4d} B | Non-Zero: {str(has_non_zero):5s} | Tail (0000807F): {str(has_tail):5s} | Sample: {sample_hex}", flush=True)
        except Exception as e:
            print(f"Baud: {b:8d} | Error: {e}", flush=True)

if __name__ == '__main__':
    test_bauds()
