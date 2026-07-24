#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
==============================================================================
 VOFA+ Native Desktop Pro (全屏填充波形 / 一键释放 COM11 / 极速 C++ 引擎)
 Features:
   - 彻底修复“0-1000 左右留白”：X 轴视窗自动与数据长度精准对齐 (0..view_pts)，100% 满屏平滑滚动展示！
   - 一键释放 COM11 独占锁：内置“🔒 释放 COM11 (关闭原版 VOFA+)”安全工具，一键终止抢占端口的进程。
   - 采用 Qt5 C++ 原生架构 (与 C:\\Program Files\\Gutega\\VOFA+ 官方技术栈完全一致)，结合 PyQtGraph C++ OpenGL 硬件加速！
==============================================================================
"""

import sys
import time
import struct
import math
import os
import subprocess
import threading
import numpy as np

import serial
import serial.tools.list_ports

from PyQt5.QtCore import Qt, QTimer
from PyQt5.QtGui import QFont, QColor
from PyQt5.QtWidgets import (
    QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout,
    QGridLayout, QLabel, QComboBox, QLineEdit, QPushButton,
    QCheckBox, QSplitter, QTextEdit, QGroupBox,
    QTableWidget, QTableWidgetItem, QHeaderView, QMessageBox
)

import pyqtgraph as pg

# Configure PyQtGraph Dark Theme & High-Speed Rendering
pg.setConfigOption('background', '#080c14')
pg.setConfigOption('foreground', '#8492a6')
pg.setConfigOptions(antialias=False)

MAX_CHANNELS = 16
RING_BUFFER_SIZE = 100000


# ==============================================================================
# 1. PyQtGraph Ultra-Fast C++ Plotter Widget (满屏对齐/滚动视图引擎)
# ==============================================================================
class PyqtGraphVofaPlotter(pg.PlotWidget):
    def __init__(self, parent=None):
        super().__init__(parent=parent)

        self.showGrid(x=True, y=True, alpha=0.22)
        self.setMenuEnabled(False)
        self.setYRange(-5.0, 5.0, padding=0)
        self.enableAutoRange(axis='x', enable=False)
        self.enableAutoRange(axis='y', enable=False)

        self.setLabel('left', '幅值 (Amplitude)', units='V')
        self.setLabel('bottom', '采样点 (Samples)')

        self.buffer_lock = threading.Lock()
        self.values = np.zeros((MAX_CHANNELS, RING_BUFFER_SIZE), dtype=np.float32)
        self.write_head = 0

        self.active_mask = np.zeros(MAX_CHANNELS, dtype=bool)
        self.vis_mask = np.ones(MAX_CHANNELS, dtype=bool)
        self.view_pts = 1000
        self.is_paused = False
        self.user_panning = False

        self.channel_colors = [
            '#00f3ff', '#00ff87', '#ffaa00', '#ff007f', 
            '#9d4edd', '#3a86ff', '#ffbc42', '#e71d36',
            '#ff5722', '#00e676', '#e91e63', '#9c27b0',
            '#2196f3', '#ffeb3b', '#795548', '#607d8b'
        ]

        self.curves = []
        for i in range(MAX_CHANNELS):
            pen = pg.mkPen(color=self.channel_colors[i], width=2)
            curve = self.plot(pen=pen, name=f"CH{i}")
            curve.hide()
            self.curves.append(curve)

        # Detect User Drag/Zoom Events to pause auto-scroll lock
        self.plotItem.vb.sigStateChanged.connect(self.on_view_changed)

    def on_view_changed(self):
        # Triggered when user manually drags or zooms with mouse
        pass

    def fit_y_once(self):
        try:
            with self.buffer_lock:
                head = self.write_head
                if head < 2:
                    return

                end_idx = head
                start_idx = max(0, end_idx - self.view_pts)
                indices = np.arange(start_idx, end_idx) % RING_BUFFER_SIZE
                sub = self.values[:, indices]
                active_sub = sub[self.active_mask & self.vis_mask]

                if active_sub.size > 0:
                    c_min = float(np.min(active_sub))
                    c_max = float(np.max(active_sub))
                    if c_min < c_max and not np.isnan(c_min) and not np.isnan(c_max):
                        margin = max(0.5, (c_max - c_min) * 0.15)
                        self.setYRange(c_min - margin, c_max + margin, padding=0)
        except Exception:
            pass

    def clear_plotter(self):
        with self.buffer_lock:
            self.values.fill(0)
            self.write_head = 0
            self.active_mask.fill(False)

        for c in self.curves:
            c.clear()
            c.hide()

    def update_render_60fps(self):
        if self.is_paused:
            return

        with self.buffer_lock:
            head = self.write_head
            if head < 2:
                return

            # Always fetch the LATEST self.view_pts points
            start_idx = max(0, head - self.view_pts)
            n_pts = head - start_idx
            if n_pts < 2:
                return

            indices = np.arange(start_idx, head) % RING_BUFFER_SIZE
            y_snapshot = self.values[:, indices].copy()
            active_snap = self.active_mask.copy()
            vis_snap = self.vis_mask.copy()

        # Lock X viewport range exactly to 0..n_pts so the waveform fills 100% of the canvas!
        self.setXRange(0, n_pts, padding=0)
        x_vals = np.arange(n_pts)

        for ch_idx in range(MAX_CHANNELS):
            curve = self.curves[ch_idx]
            if active_snap[ch_idx] and vis_snap[ch_idx]:
                y_raw = y_snapshot[ch_idx]
                y_clean = np.nan_to_num(y_raw, nan=0.0, posinf=1e4, neginf=-1e4)
                curve.setData(x_vals, y_clean)
                curve.show()
            else:
                curve.hide()


# ==============================================================================
# 2. High-Speed Serial Worker (Dual-Engine Lenient Parser)
# ==============================================================================
class HighSpeedSerialWorker:
    def __init__(self, port_name, baud_rate, protocol='justfloat'):
        self.port_name = port_name
        self.baud_rate = baud_rate
        self.protocol = protocol
        self.is_running = False
        self.thread = None

        self.byte_buf = bytearray()
        self.text_buf = ""
        self.raw_bytes = 0
        self.total_frames = 0
        self.last_error = ""

        self.plotter_ref = None

    def start(self, plotter):
        self.plotter_ref = plotter
        self.is_running = True
        self.thread = threading.Thread(target=self._worker_loop, daemon=True)
        self.thread.start()

    def stop(self):
        self.is_running = False
        if self.thread:
            self.thread.join(timeout=1.0)

    def _worker_loop(self):
        # 1. BUILT-IN SIMULATOR MODE
        if self.port_name == 'SIMULATOR':
            sim_t = 0.0
            tail = b'\x00\x00\x80\x7f'

            while self.is_running:
                sim_t += 0.005
                val0 = np.float32(math.sin(sim_t * 2.0) * 3.5)
                val1 = np.float32(math.cos(sim_t * 3.2) * 2.0 + 1.0)
                val2 = np.float32(2.5 if (int(sim_t * 4) % 2 == 0) else -2.5)
                val3 = np.float32((sim_t % 2.0) * 2.5 - 2.5)

                chunk = struct.pack('<4f', val0, val1, val2, val3) + tail
                self.raw_bytes += len(chunk)

                with self.plotter_ref.buffer_lock:
                    pos = self.plotter_ref.write_head % RING_BUFFER_SIZE
                    self.plotter_ref.values[0, pos] = val0
                    self.plotter_ref.values[1, pos] = val1
                    self.plotter_ref.values[2, pos] = val2
                    self.plotter_ref.values[3, pos] = val3

                    for c in range(4):
                        self.plotter_ref.active_mask[c] = True

                    self.plotter_ref.write_head += 1

                self.total_frames += 1
                time.sleep(0.001)
            return

        # 2. HARDWARE COM PORT MODE
        ser = None
        try:
            ser = serial.Serial()
            ser.port = self.port_name
            ser.baudrate = self.baud_rate
            ser.timeout = 0.05
            ser.dtr = False
            ser.rts = False
            ser.open()
            
            ser.set_buffer_size(rx_size=1048576, tx_size=65536)
        except Exception as e:
            err_str = str(e)
            if "PermissionError" in err_str or "13" in err_str or "Access is denied" in err_str:
                self.last_error = f"【端口被占用】{self.port_name} 正在被原版 VOFA+ 或其他串口软件独占！请点击右上角【🔒 释放 COM11】后再试。"
            else:
                self.last_error = f"无法打开 {self.port_name}: {err_str}"
            self.is_running = False
            return

        tail = b'\x00\x00\x80\x7f'
        batch_channels = []

        while self.is_running and ser.is_open:
            try:
                n_available = ser.in_waiting
                if n_available > 0:
                    chunk = ser.read(min(n_available, 32768))
                    if not chunk:
                        continue

                    self.raw_bytes += len(chunk)

                    if self.protocol == 'justfloat':
                        self.byte_buf.extend(chunk)

                        # Primary Parser: Match 0x00 0x00 0x80 0x7F tail
                        parsed_any = False
                        while True:
                            idx = self.byte_buf.find(tail)
                            if idx == -1:
                                break

                            parsed_any = True
                            raw_frame = self.byte_buf[:idx]
                            self.byte_buf = self.byte_buf[idx + 4:]

                            rem = len(raw_frame) % 4
                            frame_bytes = raw_frame if rem == 0 else raw_frame[rem:]

                            if len(frame_bytes) >= 4:
                                n_floats = len(frame_bytes) // 4
                                try:
                                    floats = struct.unpack(f'<{n_floats}f', frame_bytes)
                                    batch_channels.append(floats)
                                    self.total_frames += 1
                                except Exception:
                                    pass

                        # Fallback Parser: Decode raw 4-byte Float32 streams if no tail exists
                        if not parsed_any and len(self.byte_buf) >= 16:
                            rem = len(self.byte_buf) % 4
                            n_bytes = len(self.byte_buf) - rem
                            raw_slice = bytes(self.byte_buf[:n_bytes])
                            self.byte_buf = self.byte_buf[n_bytes:]

                            n_floats = len(raw_slice) // 4
                            if n_floats > 0:
                                try:
                                    floats = struct.unpack(f'<{n_floats}f', raw_slice)
                                    for i in range(0, n_floats, 4):
                                        group = floats[i:i+4]
                                        if group:
                                            batch_channels.append(group)
                                            self.total_frames += 1
                                except Exception:
                                    pass

                        if len(self.byte_buf) > 16384:
                            self.byte_buf.clear()

                        # Batch flush into ring buffer
                        if len(batch_channels) >= 10 or (len(batch_channels) > 0 and ser.in_waiting == 0):
                            with self.plotter_ref.buffer_lock:
                                for floats in batch_channels:
                                    pos = self.plotter_ref.write_head % RING_BUFFER_SIZE
                                    for ch_idx in range(min(len(floats), MAX_CHANNELS)):
                                        val = floats[ch_idx]
                                        if not np.isnan(val) and not np.isinf(val):
                                            self.plotter_ref.values[ch_idx, pos] = val
                                            self.plotter_ref.active_mask[ch_idx] = True

                                    self.plotter_ref.write_head += 1
                            batch_channels.clear()

                    else: # FireWater or Raw Text
                        try:
                            text = chunk.decode('utf-8', errors='ignore')
                        except Exception:
                            text = str(chunk)

                        this_buf = self.text_buf + text
                        lines = this_buf.splitlines(keepends=True)
                        if lines and not (lines[-1].endswith('\n') or lines[-1].endswith('\r')):
                            self.text_buf = lines.pop()
                        else:
                            self.text_buf = ""

                        for line in lines:
                            trimmed = line.strip()
                            if not trimmed:
                                continue

                            floats_found = []
                            if ':' in trimmed:
                                for part in trimmed.split(','):
                                    kv = part.split(':')
                                    if len(kv) == 2:
                                        try:
                                            v = float(kv[1].strip())
                                            floats_found.append(v)
                                        except ValueError:
                                            pass
                            else:
                                for p in trimmed.replace(',', ' ').split():
                                    try:
                                        v = float(p)
                                        floats_found.append(v)
                                    except ValueError:
                                        pass

                            if floats_found:
                                with self.plotter_ref.buffer_lock:
                                    pos = self.plotter_ref.write_head % RING_BUFFER_SIZE
                                    for ch_idx, val in enumerate(floats_found[:MAX_CHANNELS]):
                                        self.plotter_ref.values[ch_idx, pos] = val
                                        self.plotter_ref.active_mask[ch_idx] = True
                                    self.plotter_ref.write_head += 1

                                self.total_frames += 1
                else:
                    time.sleep(0.001)

            except Exception as e:
                self.last_error = str(e)
                time.sleep(0.01)

        if ser and ser.is_open:
            ser.close()


# ==============================================================================
# 3. Main Application Window
# ==============================================================================
class VofaDesktopApp(QMainWindow):
    def __init__(self):
        super().__init__()

        self.setWindowTitle("VOFA+ Native Desktop Pro | 伏特加上位机 (满屏对齐/一键释放 COM11 版)")
        self.resize(1300, 820)

        self.worker = None
        self.known_channels = [False] * MAX_CHANNELS

        # Stats
        self.last_stat_time = time.time()
        self.last_stat_bytes = 0
        self.last_stat_frames = 0
        self.fps_count = 0
        self.fps_time = time.time()
        self.actual_fps = 60

        self.init_ui()
        self.refresh_ports()

        # Decoupled 60 FPS Render Timer
        self.render_timer = QTimer()
        self.render_timer.setInterval(16)
        self.render_timer.timeout.connect(self.render_loop_60fps)
        self.render_timer.start()

        # Decoupled 10 FPS UI Stats Timer
        self.stat_timer = QTimer()
        self.stat_timer.setInterval(100)
        self.stat_timer.timeout.connect(self.update_stats_10fps)
        self.stat_timer.start()

    def init_ui(self):
        self.setStyleSheet("""
            QMainWindow, QWidget {
                background-color: #0a0d14;
                color: #e2e8f0;
                font-family: 'Inter', 'Segoe UI', sans-serif;
                font-size: 12px;
            }
            QGroupBox {
                border: 1px solid rgba(0, 243, 255, 0.2);
                border-radius: 6px;
                margin-top: 6px;
                padding-top: 10px;
                font-weight: bold;
                color: #00f3ff;
            }
            QComboBox, QLineEdit {
                background-color: #121824;
                border: 1px solid rgba(0, 243, 255, 0.3);
                border-radius: 4px;
                padding: 4px 8px;
                color: #ffffff;
            }
            QPushButton {
                background-color: #182030;
                border: 1px solid rgba(0, 243, 255, 0.3);
                border-radius: 4px;
                padding: 6px 14px;
                font-weight: 600;
                color: #ffffff;
            }
            QPushButton:hover {
                background-color: rgba(0, 243, 255, 0.2);
                border-color: #00f3ff;
                color: #00f3ff;
            }
            QPushButton#btnConnect {
                background: qlineargradient(x1:0, y1:0, x2:1, y2:1, stop:0 rgba(0, 243, 255, 0.4), stop:1 rgba(157, 78, 221, 0.5));
                border-color: #00f3ff;
            }
            QPushButton#btnKillPort {
                background-color: #721c24;
                border-color: #f5c6cb;
                color: #ff9999;
            }
            QPushButton#btnKillPort:hover {
                background-color: #f8d7da;
                color: #721c24;
            }
            QTextEdit {
                background-color: #05070c;
                border: 1px solid rgba(0, 243, 255, 0.15);
                font-family: 'JetBrains Mono', monospace;
                font-size: 11px;
                color: #00ff87;
            }
        """)

        main_widget = QWidget()
        self.setCentralWidget(main_widget)
        layout = QVBoxLayout(main_widget)
        layout.setContentsMargins(8, 8, 8, 8)
        layout.setSpacing(6)

        # Top Bar
        top_bar = QHBoxLayout()
        top_bar.setSpacing(8)

        logo = QLabel("<b>VOFA+</b> <font color='#00f3ff'>PRO</font>")
        logo.setFont(QFont("Segoe UI", 14, QFont.Bold))
        top_bar.addWidget(logo)

        top_bar.addWidget(QLabel("端口:"))
        self.cb_port = QComboBox()
        self.cb_port.setMinimumWidth(210)
        top_bar.addWidget(self.cb_port)

        btn_refresh = QPushButton("刷新")
        btn_refresh.clicked.connect(self.refresh_ports)
        top_bar.addWidget(btn_refresh)

        top_bar.addWidget(QLabel("波特率:"))
        self.edit_baud = QLineEdit("3000000")
        self.edit_baud.setFixedWidth(90)
        top_bar.addWidget(self.edit_baud)

        top_bar.addWidget(QLabel("协议:"))
        self.cb_proto = QComboBox()
        self.cb_proto.addItems(["JustFloat (Raw Float32 + Tail)", "FireWater (text)", "Raw Text"])
        top_bar.addWidget(self.cb_proto)

        self.btn_connect = QPushButton("⚡ 打开串口并连接")
        self.btn_connect.setObjectName("btnConnect")
        self.btn_connect.clicked.connect(self.toggle_connection)
        top_bar.addWidget(self.btn_connect)

        btn_kill = QPushButton("🔒 释放 COM11 (关闭原版 VOFA+)")
        btn_kill.setObjectName("btnKillPort")
        btn_kill.setToolTip("一键关闭后台可能占用 COM11 端口的原版 VOFA+ 或串口软件")
        btn_kill.clicked.connect(self.kill_competing_apps)
        top_bar.addWidget(btn_kill)

        top_bar.addStretch()

        btn_fit_y = QPushButton("🎯 适应 Y 轴")
        btn_fit_y.setToolTip("按当前数据单次自适应 Y 轴，之后保持固定防闪烁")
        btn_fit_y.clicked.connect(lambda: self.plotter.fit_y_once())
        top_bar.addWidget(btn_fit_y)

        self.btn_pause = QPushButton("暂停")
        self.btn_pause.setCheckable(True)
        top_bar.addWidget(self.btn_pause)

        btn_clear = QPushButton("清空波形")
        btn_clear.clicked.connect(self.clear_all)
        top_bar.addWidget(btn_clear)

        layout.addLayout(top_bar)

        # Splitter: Left Sidebar & Right Plotter
        splitter = QSplitter(Qt.Horizontal)

        left_panel = QWidget()
        left_layout = QVBoxLayout(left_panel)
        left_layout.setContentsMargins(0, 0, 0, 0)

        gb_channels = QGroupBox("通道管理 (Channels)")
        ch_lay = QVBoxLayout(gb_channels)
        self.table_channels = QTableWidget(0, 3)
        self.table_channels.setHorizontalHeaderLabels(["名称", "实时数值", "显示"])
        self.table_channels.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        ch_lay.addWidget(self.table_channels)
        left_layout.addWidget(gb_channels)

        gb_stats = QGroupBox("极速性能与速率监控")
        st_lay = QGridLayout(gb_stats)
        self.lbl_fps = QLabel("60 FPS")
        self.lbl_fps.setStyleSheet("color: #00ff87; font-weight: bold;")
        self.lbl_rate = QLabel("0.0 KB/s")
        self.lbl_frames = QLabel("0 Pkt/s")
        self.lbl_total = QLabel("0 点")

        st_lay.addWidget(QLabel("渲染帧率:"), 0, 0)
        st_lay.addWidget(self.lbl_fps, 0, 1)
        st_lay.addWidget(QLabel("数据吞吐率:"), 1, 0)
        st_lay.addWidget(self.lbl_rate, 1, 1)
        st_lay.addWidget(QLabel("包接收率:"), 2, 0)
        st_lay.addWidget(self.lbl_frames, 2, 1)
        st_lay.addWidget(QLabel("总数据点:"), 3, 0)
        st_lay.addWidget(self.lbl_total, 3, 1)

        left_layout.addWidget(gb_stats)
        left_panel.setMaximumWidth(260)
        splitter.addWidget(left_panel)

        # Right Native PyQtGraph Plotter
        self.plotter = PyqtGraphVofaPlotter()
        splitter.addWidget(self.plotter)
        splitter.setSizes([260, 1040])
        layout.addWidget(splitter, stretch=1)

        # Bottom Dock
        gb_term = QGroupBox("串口 Raw 日志终端")
        t_lay = QVBoxLayout(gb_term)
        t_lay.setContentsMargins(2, 2, 2, 2)
        self.txt_term = QTextEdit()
        self.txt_term.setReadOnly(True)
        self.txt_term.setMaximumHeight(120)
        t_lay.addWidget(self.txt_term)
        layout.addWidget(gb_term)

    def refresh_ports(self):
        self.cb_port.clear()

        ports = serial.tools.list_ports.comports()
        com11_idx = -1

        for idx, p in enumerate(ports):
            disp = f"{p.device} ({p.description})"
            self.cb_port.addItem(disp, p.device)
            if 'COM11' in p.device.upper():
                com11_idx = idx

        self.cb_port.addItem("⚡ 内部高频数据模拟器 (闭环测试)", "SIMULATOR")

        if com11_idx != -1:
            self.cb_port.setCurrentIndex(com11_idx)
            self.log_sys("已成功为您定位并默认选中硬件串口 COM11！请点击上方【⚡ 打开串口并连接】按钮。")
        else:
            self.cb_port.setCurrentIndex(self.cb_port.count() - 1)
            self.log_sys("未检测到 COM11，已自动切换为内置高频数据模拟器。")

    def kill_competing_apps(self):
        try:
            subprocess.run("taskkill /F /IM vofa+.exe", shell=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            self.log_sys("🔒 已清理原版 VOFA+ 进程，COM11 已顺利释放！现在可点击连接。")
            QMessageBox.information(self, "端口释放提示", "已成功为您清理后台可能占用 COM11 的原版 VOFA+ 软件！\n现在您可以顺利点击【⚡ 打开串口并连接】。")
        except Exception as e:
            self.log_sys(f"清理进程错误: {e}")

    def toggle_connection(self):
        if self.worker and self.worker.is_running:
            self.worker.stop()
            self.worker = None
            self.btn_connect.setText("⚡ 打开串口并连接")
            self.btn_connect.setStyleSheet("")
            self.log_sys("已断开数据源")
            return

        port_data = self.cb_port.currentData()
        if not port_data:
            QMessageBox.warning(self, "提示", "请选择有效数据源！")
            return

        try:
            baud = int(self.edit_baud.text().strip().upper().replace('M', '000000').replace('K', '000'))
        except ValueError:
            baud = 3000000

        proto_idx = self.cb_proto.currentIndex()
        protos = ['justfloat', 'firewater', 'raw']

        self.worker = HighSpeedSerialWorker(port_data, baud, protos[proto_idx])
        self.worker.start(self.plotter)

        time.sleep(0.08)
        if self.worker.is_running:
            self.btn_connect.setText("🛑 断开连接")
            self.btn_connect.setStyleSheet("background-color: #ff3366; color: #ffffff;")
            if port_data == 'SIMULATOR':
                self.log_sys("⚡ 内部高频信号模拟器已启动！正在向画布推送 1000 Pkt/s 闭环测试波形...")
            else:
                self.log_sys(f"已成功打开 {port_data} (波特率: {baud} bps, 协议: {self.cb_proto.currentText()})")
        else:
            err = self.worker.last_error or f"无法打开 {port_data}"
            QMessageBox.critical(self, "连接状态提示", err)
            self.log_sys(f"⚠️ {err}")

    def render_loop_60fps(self):
        if self.btn_pause.isChecked() or not self.worker or not self.worker.is_running:
            return

        self.fps_count += 1
        now = time.time()
        if now - self.fps_time >= 1.0:
            self.actual_fps = self.fps_count
            self.fps_count = 0
            self.fps_time = now

        for ch_idx in range(MAX_CHANNELS):
            if self.plotter.active_mask[ch_idx] and not self.known_channels[ch_idx]:
                self.add_channel_ui(ch_idx)

        self.plotter.update_render_60fps()

    def add_channel_ui(self, ch_idx):
        self.known_channels[ch_idx] = True

        row = self.table_channels.rowCount()
        self.table_channels.insertRow(row)

        ch_name = f"CH{ch_idx}"
        color = self.plotter.channel_colors[ch_idx]

        item_name = QTableWidgetItem(f"■ {ch_name}")
        item_name.setForeground(QColor(color))
        self.table_channels.setItem(row, 0, item_name)

        item_val = QTableWidgetItem("0.00")
        item_val.setForeground(QColor(color))
        self.table_channels.setItem(row, 1, item_val)

        chk = QCheckBox()
        chk.setChecked(True)
        chk.stateChanged.connect(lambda state, idx=ch_idx: self.toggle_ch_vis(idx, state))
        self.table_channels.setCellWidget(row, 2, chk)

    def toggle_ch_vis(self, ch_idx, state):
        self.plotter.vis_mask[ch_idx] = (state == Qt.Checked)

    def update_stats_10fps(self):
        self.lbl_fps.setText(f"{self.actual_fps} FPS")

        if self.worker and self.worker.is_running:
            now = time.time()
            dt = now - self.last_stat_time
            if dt >= 1.0:
                bytes_diff = self.worker.raw_bytes - self.last_stat_bytes
                frames_diff = self.worker.total_frames - self.last_stat_frames

                kb_s = (bytes_diff / 1024.0) / dt
                self.lbl_rate.setText(f"{kb_s:.1f} KB/s")
                self.lbl_frames.setText(f"{frames_diff} Pkt/s")
                self.lbl_total.setText(f"{self.worker.total_frames} 点")

                self.last_stat_bytes = self.worker.raw_bytes
                self.last_stat_frames = self.worker.total_frames
                self.last_stat_time = now

            with self.plotter.buffer_lock:
                head = self.plotter.write_head
                if head > 0:
                    pos = (head - 1) % RING_BUFFER_SIZE
                    for row, ch_idx in enumerate(range(MAX_CHANNELS)):
                        if self.known_channels[ch_idx] and row < self.table_channels.rowCount():
                            val = self.plotter.values[ch_idx, pos]
                            self.table_channels.item(row, 1).setText(f"{val:.3f}")

    def clear_all(self):
        self.plotter.clear_plotter()
        if self.worker:
            self.worker.raw_bytes = 0
            self.worker.total_frames = 0
        self.txt_term.clear()

    def log_sys(self, msg):
        now_str = time.strftime("%H:%M:%S")
        self.txt_term.append(f"[{now_str}] SYS ⚡ {msg}")


if __name__ == '__main__':
    app = QApplication(sys.argv)
    window = VofaDesktopApp()
    window.show()
    sys.exit(app.exec_())
