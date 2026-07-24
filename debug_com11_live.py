#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
==============================================================================
 VOFA+ Deep Hardware & Serial Diagnostic Debugger (GBK Safe Console Output)
 ==============================================================================
"""

import sys
import time
import struct
import numpy as np
import serial
import serial.tools.list_ports

def run_deep_diagnostics():
    print("=" * 70, flush=True)
    print(" [VOFA+ Deep Hardware Diagnostic Report]", flush=True)
    print("=" * 70, flush=True)

    # Step 1: Enumerating Serial Ports
    print("\n[Step 1] Enumerating system serial ports...", flush=True)
    ports = serial.tools.list_ports.comports()
    if not ports:
        print("  [WARN] No serial ports found in system!", flush=True)
        return

    found_com11 = False
    for p in ports:
        print(f"  --> Port: {p.device} | Desc: {p.description} | HWID: {p.hwid}", flush=True)
        if 'COM11' in p.device.upper():
            found_com11 = True

    if not found_com11:
        print("  [WARN] COM11 not found in list!", flush=True)
    else:
        print("  [OK] Successfully located COM11 (CH340)!", flush=True)

    # Step 2: Testing COM11 Exclusive Access & Line Modes
    target_port = 'COM11' if found_com11 else ports[0].device
    print(f"\n[Step 2] Testing exclusive access to {target_port} (3000000 bps)...", flush=True)

    dtr_rts_modes = [
        (False, False, "DTR=OFF, RTS=OFF (Standard Mode)"),
        (True, False,  "DTR=ON,  RTS=OFF (DTR Asserted)"),
        (False, True,  "DTR=OFF, RTS=ON  (RTS Asserted)"),
        (True, True,   "DTR=ON,  RTS=ON  (DTR & RTS Asserted)")
    ]

    opened_ser = None
    for dtr, rts, desc in dtr_rts_modes:
        print(f"\n  Testing configuration: {desc}...", flush=True)
        try:
            ser = serial.Serial()
            ser.port = target_port
            ser.baudrate = 3000000
            ser.timeout = 0.5
            ser.dtr = dtr
            ser.rts = rts
            ser.open()
            print(f"  [SUCCESS] Successfully opened {target_port} ({desc})!", flush=True)
            opened_ser = ser
            break
        except serial.SerialException as e:
            err_msg = str(e)
            if "PermissionError" in err_msg or "13" in err_msg or "Access is denied" in err_msg:
                print(f"  [FAIL - PORT LOCKED] {target_port} is LOCKED by another process: {err_msg}", flush=True)
                print("     --> CAUTION: Official VOFA+ or Chrome or another serial assistant is locking COM11!", flush=True)
            else:
                print(f"  [FAIL] Failed to open {target_port}: {err_msg}", flush=True)

    if not opened_ser:
        print("\n[STOP] Cannot proceed with capture because port opening failed.", flush=True)
        return

    # Step 3: Raw Byte Capture & JustFloat Frame Decoding Test
    print(f"\n[Step 3] Capturing raw bytes on {target_port} for 3 seconds...", flush=True)
    rx_bytes = bytearray()
    start_time = time.time()
    packet_chunks = 0

    while time.time() - start_time < 3.0:
        try:
            if opened_ser.in_waiting > 0:
                chunk = opened_ser.read(opened_ser.in_waiting)
                if chunk:
                    rx_bytes.extend(chunk)
                    packet_chunks += 1
            else:
                time.sleep(0.005)
        except Exception as e:
            print(f"  [ERROR] Serial read error: {e}", flush=True)
            break

    opened_ser.close()
    print(f"  [OK] Capture finished! Total bytes received: {len(rx_bytes)} (across {packet_chunks} chunks)", flush=True)

    if len(rx_bytes) == 0:
        print("  [WARN] Port opened successfully, BUT 0 BYTES received from hardware!", flush=True)
        print("     --> Check: 1. Is MCU board powered & running? 2. Are TX/RX lines reversed? 3. Is baud rate really 3000000?", flush=True)
        return

    # Step 4: Hex Sample & JustFloat Decode Test
    print("\n[Step 4] Raw Bytes HEX Sample (First 64 bytes):", flush=True)
    sample_hex = rx_bytes[:64].hex(' ').upper()
    print(f"  HEX: {sample_hex}", flush=True)

    # JustFloat Tail Verification (0x00 0x00 0x80 0x7F)
    tail = b'\x00\x00\x80\x7f'
    tail_count = rx_bytes.count(tail)
    print(f"\n[Step 5] JustFloat Tail Marker (00 00 80 7F) Count: Found {tail_count} tail markers", flush=True)

    if tail_count > 0:
        idx = rx_bytes.find(tail)
        frame_bytes = rx_bytes[:idx]
        rem = len(frame_bytes) % 4
        clean_bytes = frame_bytes if rem == 0 else frame_bytes[rem:]
        num_floats = len(clean_bytes) // 4
        if num_floats > 0:
            try:
                floats = struct.unpack(f'<{num_floats}f', clean_bytes)
                print("  [SUCCESS] Decoded Float32 channel values from first frame:", flush=True)
                for i, v in enumerate(floats):
                    print(f"    --> CH{i}: {v:.6f}", flush=True)
            except Exception as e:
                print(f"  [WARN] Float32 decode error: {e}", flush=True)
    else:
        print("  [INFO] No JustFloat 00 00 80 7F tail found. Attempting ASCII FireWater text decode...", flush=True)
        try:
            txt_sample = rx_bytes[:200].decode('utf-8', errors='ignore')
            print(f"  ASCII Text: {txt_sample}", flush=True)
        except Exception:
            pass

    print("=" * 70, flush=True)
    print(" [Diagnostic Finished]", flush=True)
    print("=" * 70, flush=True)

if __name__ == '__main__':
    run_deep_diagnostics()
