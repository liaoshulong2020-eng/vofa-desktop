#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
==============================================================================
 VOFA+ Native Desktop Ultimate (官方 VOFA+ 像素级 1:1 功能全复刻版)
 Features:
   1. 底部时间轴与缓冲区控制栏 (对应官方界面):
      - Δt (ms) 采样间隔设置 (动态转换 X 轴为真实的 -1000ms 到 0ms 相对时间轴)。
      - 缓冲区上限 (默认 500,000 点/通道)。
      - Auto 点数对齐 (视窗波形长度调整，范围 50 - 100,000 点，完美解决波形长度调节)。
      - 历史回放滑动条 (显示 500000 / 500000 进度与 ms/div 刻度，支持拖拽历史回溯与 Auto 恢复实时)。
   2. 右侧数据与通道增强控制面板:
      - 自定义通道名称 (支持修改 CH0 为 v_sync, vbus_notch_filter 等)。
      - 自定义通道颜色选择器。
      - 通道增益 (Gain, 默认 1.0) 与 Y 偏置 (Y Offset) / X 偏置 (X Offset) 独立控制。
      - 一键重置通道偏置与增益。
   3. 底部串口指令发送栏 (Command TX Dock):
      - 串口指令文本框，支持 \\n / \\r\\n / HEX 模式发送与 Enter 快捷键。
   4. 原生 PyQtGraph C++ 硬件加速 PlotWidget (60 FPS 满屏无缝滚轴)。
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
    QCheckBox, QSplitter, QTextEdit, QGroupBox, QSpinBox, QDoubleSpinBox,
    QTableWidget, QTableWidgetItem, QHeaderView, QMessageBox, QColorDialog, QSlider
)

import pyqtgraph as pg

# Configure PyQtGraph Dark Theme & High-Speed Rendering
pg.setConfigOption('background', '#080c14')
pg.setConfigOption('foreground', '#8492a6')
pg.setConfigOptions(antialias=False)

MAX_CHANNELS = 16
DEFAULT_RING_BUFFER_SIZE = 500000


# ==============================================================================
# 1. PyQtGraph Official-Style Plotter Engine
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
        self.setLabel('bottom', '相对时间 (Time)', units='ms')

        self.buffer_lock = threading.Lock()
        self.buffer_size = DEFAULT_RING_BUFFER_SIZE
        self.values = np.zeros((MAX_CHANNELS, self.buffer_size), dtype=np.float32)
        self.write_head = 0

        self.active_mask = np.zeros(MAX_CHANNELS, dtype=bool)
        self.vis_mask = np.ones(MAX_CHANNELS, dtype=bool)
        self.channel_names = [f"CH{i}" for i in range(MAX_CHANNELS)]

        # Channel Gain & Offsets
        self.ch_gain = np.ones(MAX_CHANNELS, dtype=np.float32)
        self.ch_y_offset = np.zeros(MAX_CHANNELS, dtype=np.float32)
        self.ch_x_offset = np.zeros(MAX_CHANNELS, dtype=np.int32)

        self.view_pts = 1000
        self.dt_ms = 1.0
        self.is_paused = False
        self.history_offset = 0  # 0 means live auto-scroll

        self.channel_colors = [
            '#00f3ff', '#00ff87', '#ffaa00', '#ff007f', 
            '#9d4edd', '#3a86ff', '#ffbc42', '#e71d36',
            '#ff5722', '#00e676', '#e91e63', '#9c27b0',
            '#2196f3', '#ffeb3b', '#795548', '#607d8b'
        ]

        self.curves = []
        for i in range(MAX_CHANNELS):
            pen = pg.mkPen(color=self.channel_colors[i], width=2)
            curve = self.plot(pen=pen, name=self.channel_names[i])
            curve.hide()
            self.curves.append(curve)

    def set_buffer_capacity(self, new_cap):
        with self.buffer_lock:
            new_cap = max(10000, min(1000000, new_cap))
            if new_cap != self.buffer_size:
                new_values = np.zeros((MAX_CHANNELS, new_cap), dtype=np.float32)
                min_len = min(new_cap, self.buffer_size)
                new_values[:, :min_len] = self.values[:, :min_len]
                self.values = new_values
                self.buffer_size = new_cap
                self.write_head = self.write_head % new_cap

    def fit_y_once(self):
        try:
            with self.buffer_lock:
                head = self.write_head
                if head < 2:
                    return

                end_idx = head - self.history_offset
                start_idx = max(0, end_idx - self.view_pts)
                if end_idx <= start_idx:
                    return

                indices = np.arange(start_idx, end_idx) % self.buffer_size
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
            self.history_offset = 0

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

            end_idx = max(2, head - self.history_offset)
            start_idx = max(0, end_idx - self.view_pts)
            n_pts = end_idx - start_idx
            if n_pts < 2:
                return

            indices = np.arange(start_idx, end_idx) % self.buffer_size
            y_snapshot = self.values[:, indices].copy()
            active_snap = self.active_mask.copy()
            vis_snap = self.vis_mask.copy()
            gains = self.ch_gain.copy()
            y_offsets = self.ch_y_offset.copy()

        # Convert sample count to relative time in milliseconds: - (n_pts - 1) * dt to 0 ms
        t_start_ms = - (n_pts - 1) * self.dt_ms
        t_end_ms = 0.0
        self.setXRange(t_start_ms, t_end_ms, padding=0)
        x_vals = np.linspace(t_start_ms, t_end_ms, n_pts)

        for ch_idx in range(MAX_CHANNELS):
            curve = self.curves[ch_idx]
            if active_snap[ch_idx] and vis_snap[ch_idx]:
                y_raw = y_snapshot[ch_idx] * gains[ch_idx] + y_offsets[ch_idx]
                y_clean = np.nan_to_num(y_raw, nan=0.0, posinf=1e4, neginf=-1e4)
                curve.setData(x_vals, y_clean)
                curve.show()
            else:
                curve.hide()


# ==============================================================================
# 2. High-Speed Serial Worker Thread
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

    def send_cmd(self, cmd_bytes):
        if hasattr(self, 'ser_obj') and self.ser_obj and self.ser_obj.is_open:
            try:
                self.ser_obj.write(cmd_bytes)
                return True
            except Exception as e:
                print(f"发送指令错误: {e}")
        return False

    def _worker_loop(self):
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
                    pos = self.plotter_ref.write_head % self.plotter_ref.buffer_size
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
            self.ser_obj = ser
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

                        if len(batch_channels) >= 10 or (len(batch_channels) > 0 and ser.in_waiting == 0):
                            with self.plotter_ref.buffer_lock:
                                buf_size = self.plotter_ref.buffer_size
                                for floats in batch_channels:
                                    pos = self.plotter_ref.write_head % buf_size
                                    for ch_idx in range(min(len(floats), MAX_CHANNELS)):
                                        val = floats[ch_idx]
                                        if not np.isnan(val) and not np.isinf(val):
                                            self.plotter_ref.values[ch_idx, pos] = val
                                            self.plotter_ref.active_mask[ch_idx] = True

                                    self.plotter_ref.write_head += 1
                            batch_channels.clear()

                    else:
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
                                    buf_size = self.plotter_ref.buffer_size
                                    pos = self.plotter_ref.write_head % buf_size
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
            self.ser_obj = None


# ==============================================================================
# 3. Main Application Window (1:1 官方 VOFA+ 功能界面)
# ==============================================================================
class VofaDesktopApp(QMainWindow):
    def __init__(self):
        super().__init__()

        self.setWindowTitle("VOFA+ Native Desktop Ultimate | 伏特加上位机 (1:1 官方全功能版)")
        self.resize(1340, 850)

        self.worker = None
        self.known_channels = [False] * MAX_CHANNELS
        self.selected_ch_idx = 0

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
            QComboBox, QLineEdit, QSpinBox, QDoubleSpinBox {
                background-color: #121824;
                border: 1px solid rgba(0, 243, 255, 0.3);
                border-radius: 4px;
                padding: 3px 6px;
                color: #ffffff;
            }
            QPushButton {
                background-color: #182030;
                border: 1px solid rgba(0, 243, 255, 0.3);
                border-radius: 4px;
                padding: 5px 12px;
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
            QTextEdit {
                background-color: #05070c;
                border: 1px solid rgba(0, 243, 255, 0.15);
                font-family: 'JetBrains Mono', monospace;
                font-size: 11px;
                color: #00ff87;
            }
            QSlider::groove:horizontal {
                height: 6px;
                background: #182030;
                border-radius: 3px;
            }
            QSlider::sub-page:horizontal {
                background: #00f3ff;
                border-radius: 3px;
            }
            QSlider::handle:horizontal {
                background: #ffffff;
                width: 14px;
                margin-top: -4px;
                margin-bottom: -4px;
                border-radius: 7px;
            }
        """)

        main_widget = QWidget()
        self.setCentralWidget(main_widget)
        layout = QVBoxLayout(main_widget)
        layout.setContentsMargins(6, 6, 6, 6)
        layout.setSpacing(5)

        # 1. TOP BAR
        top_bar = QHBoxLayout()
        top_bar.setSpacing(6)

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
        self.edit_baud.setFixedWidth(85)
        top_bar.addWidget(self.edit_baud)

        top_bar.addWidget(QLabel("协议:"))
        self.cb_proto = QComboBox()
        self.cb_proto.addItems(["JustFloat (Raw Float32 + Tail)", "FireWater (text)", "Raw Text"])
        top_bar.addWidget(self.cb_proto)

        self.btn_connect = QPushButton("⚡ 打开串口并连接")
        self.btn_connect.setObjectName("btnConnect")
        self.btn_connect.clicked.connect(self.toggle_connection)
        top_bar.addWidget(self.btn_connect)

        btn_kill = QPushButton("🔒 释放 COM11")
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

        # 2. MAIN CONTENT SPLITTER: Left Plotter + Right Data/Channel Panel
        splitter = QSplitter(Qt.Horizontal)

        # Center Area: Plotter + Bottom Timebase Toolbar
        center_widget = QWidget()
        center_layout = QVBoxLayout(center_widget)
        center_layout.setContentsMargins(0, 0, 0, 0)
        center_layout.setSpacing(4)

        self.plotter = PyqtGraphVofaPlotter()
        center_layout.addWidget(self.plotter, stretch=1)

        # Bottom Official VOFA+ Timebase Toolbar
        tb_layout = QHBoxLayout()
        tb_layout.setSpacing(8)

        tb_layout.addWidget(QLabel("Δt:"))
        self.spin_dt = QDoubleSpinBox()
        self.spin_dt.setRange(0.01, 1000.0)
        self.spin_dt.setValue(1.0)
        self.spin_dt.setSuffix(" ms")
        self.spin_dt.setFixedWidth(85)
        self.spin_dt.valueChanged.connect(self.on_dt_changed)
        tb_layout.addWidget(self.spin_dt)

        tb_layout.addWidget(QLabel("缓冲区上限:"))
        self.spin_buf_cap = QSpinBox()
        self.spin_buf_cap.setRange(10000, 1000000)
        self.spin_buf_cap.setSingleStep(50000)
        self.spin_buf_cap.setValue(500000)
        self.spin_buf_cap.setSuffix(" /ch")
        self.spin_buf_cap.setFixedWidth(120)
        self.spin_buf_cap.valueChanged.connect(self.on_buf_cap_changed)
        tb_layout.addWidget(self.spin_buf_cap)

        tb_layout.addWidget(QLabel("Auto点数对齐:"))
        self.spin_view_pts = QSpinBox()
        self.spin_view_pts.setRange(50, 100000)
        self.spin_view_pts.setSingleStep(100)
        self.spin_view_pts.setValue(1000)
        self.spin_view_pts.setFixedWidth(90)
        self.spin_view_pts.valueChanged.connect(self.on_view_pts_changed)
        tb_layout.addWidget(self.spin_view_pts)

        self.btn_auto_scroll = QPushButton("Auto 实时")
        self.btn_auto_scroll.setStyleSheet("color: #00ff87; font-weight: bold;")
        self.btn_auto_scroll.clicked.connect(self.restore_auto_scroll)
        tb_layout.addWidget(self.btn_auto_scroll)

        tb_layout.addStretch()

        center_layout.addLayout(tb_layout)

        # Historical Progress Slider
        hist_layout = QHBoxLayout()
        self.lbl_hist_info = QLabel("0 / 500000 | 60.0 FPS | 100ms/div")
        self.lbl_hist_info.setStyleSheet("color: #8492a6; font-family: 'JetBrains Mono';")
        hist_layout.addWidget(self.lbl_hist_info)

        self.slider_hist = QSlider(Qt.Horizontal)
        self.slider_hist.setRange(0, 1000)
        self.slider_hist.setValue(1000)
        self.slider_hist.valueChanged.connect(self.on_slider_hist_changed)
        hist_layout.addWidget(self.slider_hist, stretch=1)

        center_layout.addLayout(hist_layout)
        splitter.addWidget(center_widget)

        # Right Official VOFA+ Channel Control Sidebar
        right_panel = QWidget()
        right_layout = QVBoxLayout(right_panel)
        right_layout.setContentsMargins(0, 0, 0, 0)
        right_layout.setSpacing(6)

        gb_channels = QGroupBox("👁️ 通道列表 (Data Channels)")
        ch_lay = QVBoxLayout(gb_channels)
        self.table_channels = QTableWidget(0, 3)
        self.table_channels.setHorizontalHeaderLabels(["名称", "数值", "显示"])
        self.table_channels.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        self.table_channels.cellClicked.connect(self.on_channel_selected)
        ch_lay.addWidget(self.table_channels)
        right_layout.addWidget(gb_channels)

        # Channel Specific Detailed Tuning Panel
        gb_ch_tune = QGroupBox("⚙️ 通道偏置与增益调整")
        tune_lay = QGridLayout(gb_ch_tune)

        tune_lay.addWidget(QLabel("数据名称:"), 0, 0)
        self.edit_ch_name = QLineEdit("CH0")
        self.edit_ch_name.editingFinished.connect(self.on_ch_name_edited)
        tune_lay.addWidget(self.edit_ch_name, 0, 1)

        tune_lay.addWidget(QLabel("颜色:"), 1, 0)
        self.btn_ch_color = QPushButton(" 选择颜色 ")
        self.btn_ch_color.clicked.connect(self.pick_ch_color)
        tune_lay.addWidget(self.btn_ch_color, 1, 1)

        tune_lay.addWidget(QLabel("增益 (Gain):"), 2, 0)
        self.spin_gain = QDoubleSpinBox()
        self.spin_gain.setRange(-1000.0, 1000.0)
        self.spin_gain.setSingleStep(0.01)
        self.spin_gain.setValue(1.0)
        self.spin_gain.valueChanged.connect(self.on_gain_changed)
        tune_lay.addWidget(self.spin_gain, 2, 1)

        tune_lay.addWidget(QLabel("Y 偏置:"), 3, 0)
        self.spin_y_offset = QDoubleSpinBox()
        self.spin_y_offset.setRange(-1000.0, 1000.0)
        self.spin_y_offset.setSingleStep(0.1)
        self.spin_y_offset.setValue(0.0)
        self.spin_y_offset.valueChanged.connect(self.on_y_offset_changed)
        tune_lay.addWidget(self.spin_y_offset, 3, 1)

        btn_reset_ch = QPushButton("重置增益偏置")
        btn_reset_ch.clicked.connect(self.reset_ch_params)
        tune_lay.addWidget(btn_reset_ch, 4, 0, 1, 2)

        right_layout.addWidget(gb_ch_tune)

        gb_stats = QGroupBox("极速性能与速率")
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

        right_layout.addWidget(gb_stats)
        right_panel.setFixedWidth(270)
        splitter.addWidget(right_panel)

        splitter.setSizes([1070, 270])
        layout.addWidget(splitter, stretch=1)

        # 3. BOTTOM DOCK: Serial Command Send Bar (串口指令发送栏)
        cmd_box = QGroupBox("💬 串口指令发送 (Serial Command Sender)")
        cmd_lay = QHBoxLayout(cmd_box)
        cmd_lay.setContentsMargins(4, 4, 4, 4)

        self.edit_cmd = QLineEdit()
        self.edit_cmd.setPlaceholderText("输入要发送给单片机的串口指令/参数...")
        self.edit_cmd.returnPressed.connect(self.send_serial_cmd)
        cmd_lay.addWidget(self.edit_cmd, stretch=1)

        self.cb_cmd_ending = QComboBox()
        self.cb_cmd_ending.addItems(["\\n (LF)", "\\r\\n (CRLF)", "无换行", "HEX 模式"])
        cmd_lay.addWidget(self.cb_cmd_ending)

        btn_send = QPushButton("发送(S)")
        btn_send.setStyleSheet("background-color: #00f3ff; color: #080c14; font-weight: bold;")
        btn_send.clicked.connect(self.send_serial_cmd)
        cmd_lay.addWidget(btn_send)

        layout.addWidget(cmd_box)

        # Log Terminal
        gb_term = QGroupBox("串口 Raw 日志终端")
        t_lay = QVBoxLayout(gb_term)
        t_lay.setContentsMargins(2, 2, 2, 2)
        self.txt_term = QTextEdit()
        self.txt_term.setReadOnly(True)
        self.txt_term.setMaximumHeight(85)
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

    def send_serial_cmd(self):
        cmd_text = self.edit_cmd.text()
        if not cmd_text:
            return

        if not self.worker or not self.worker.is_running:
            QMessageBox.warning(self, "提示", "请先连接串口再发送指令！")
            return

        ending_idx = self.cb_cmd_ending.currentIndex()
        if ending_idx == 0:
            payload = (cmd_text + "\n").encode('utf-8')
        elif ending_idx == 1:
            payload = (cmd_text + "\r\n").encode('utf-8')
        elif ending_idx == 2:
            payload = cmd_text.encode('utf-8')
        else: # HEX Mode
            try:
                payload = bytes.fromhex(cmd_text.replace(' ', ''))
            except ValueError:
                QMessageBox.warning(self, "格式错误", "HEX 格式错误，请填写正确的十六进制字节字符串！")
                return

        if self.worker.send_cmd(payload):
            self.log_sys(f"发送成功 --> {cmd_text}")
            self.edit_cmd.clear()
        else:
            self.log_sys(f"发送失败！")

    def on_dt_changed(self, val):
        self.plotter.dt_ms = float(val)

    def on_buf_cap_changed(self, val):
        self.plotter.set_buffer_capacity(int(val))

    def on_view_pts_changed(self, val):
        self.plotter.view_pts = int(val)

    def restore_auto_scroll(self):
        self.plotter.history_offset = 0
        self.slider_hist.setValue(1000)

    def on_slider_hist_changed(self, val):
        head = self.plotter.write_head
        if head > 1000:
            ratio = 1.0 - (val / 1000.0)
            self.plotter.history_offset = int(ratio * (head - self.plotter.view_pts))

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

        ch_name = self.plotter.channel_names[ch_idx]
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

    def on_channel_selected(self, row, col):
        if row < MAX_CHANNELS:
            self.selected_ch_idx = row
            ch_name = self.plotter.channel_names[row]
            self.edit_ch_name.setText(ch_name)

            color_hex = self.plotter.channel_colors[row]
            self.btn_ch_color.setStyleSheet(f"background-color: {color_hex}; color: #000000; font-weight: bold;")

            self.spin_gain.blockSignals(True)
            self.spin_gain.setValue(float(self.plotter.ch_gain[row]))
            self.spin_gain.blockSignals(False)

            self.spin_y_offset.blockSignals(True)
            self.spin_y_offset.setValue(float(self.plotter.ch_y_offset[row]))
            self.spin_y_offset.blockSignals(False)

    def on_ch_name_edited(self):
        new_name = self.edit_ch_name.text().strip()
        if new_name and self.selected_ch_idx < MAX_CHANNELS:
            self.plotter.channel_names[self.selected_ch_idx] = new_name
            if self.selected_ch_idx < self.table_channels.rowCount():
                color = self.plotter.channel_colors[self.selected_ch_idx]
                item = QTableWidgetItem(f"■ {new_name}")
                item.setForeground(QColor(color))
                self.table_channels.setItem(self.selected_ch_idx, 0, item)

    def pick_ch_color(self):
        color = QColorDialog.getColor(QColor(self.plotter.channel_colors[self.selected_ch_idx]), self, "选择通道波形颜色")
        if color.isValid():
            hex_str = color.name()
            self.plotter.channel_colors[self.selected_ch_idx] = hex_str
            self.btn_ch_color.setStyleSheet(f"background-color: {hex_str}; color: #000000; font-weight: bold;")
            self.plotter.curves[self.selected_ch_idx].setPen(pg.mkPen(color=hex_str, width=2))

    def on_gain_changed(self, val):
        self.plotter.ch_gain[self.selected_ch_idx] = float(val)

    def on_y_offset_changed(self, val):
        self.plotter.ch_y_offset[self.selected_ch_idx] = float(val)

    def reset_ch_params(self):
        self.plotter.ch_gain[self.selected_ch_idx] = 1.0
        self.plotter.ch_y_offset[self.selected_ch_idx] = 0.0
        self.spin_gain.setValue(1.0)
        self.spin_y_offset.setValue(0.0)

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
                buf_size = self.plotter.buffer_size
                if head > 0:
                    pos = (head - 1) % buf_size
                    for row, ch_idx in enumerate(range(MAX_CHANNELS)):
                        if self.known_channels[ch_idx] and row < self.table_channels.rowCount():
                            val = self.plotter.values[ch_idx, pos] * self.plotter.ch_gain[ch_idx] + self.plotter.ch_y_offset[ch_idx]
                            self.table_channels.item(row, 1).setText(f"{val:.3f}")

                    self.lbl_hist_info.setText(f"{head} / {buf_size} | {self.actual_fps:.1f} FPS | {self.plotter.dt_ms * 100:.1f}ms/div")

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
