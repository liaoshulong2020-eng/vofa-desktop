# VOFA+ Native Desktop Pro (伏特加上位机 - 高速 3M 波特率 / PyQtGraph C++ 硬件加速版)

高性能原生桌面版 **VOFA+ 上位机**，基于 **PyQt5 + PyQtGraph (C++ OpenGL 硬件加速) + PySerial** 打造，完美匹配官方原版 VOFA+ (`C:\Program Files\Gutega\VOFA+`) 的 C++ Qt 引擎架构。

---

## 🌟 核心特色 (Key Features)

1. **⚡ 3,000,000 bps 高速串口与 16 通道 JustFloat 协议**
   - 完美解算 `Float32` 数组 + `0x00 0x00 0x80 0x7F` 帧尾包标记。
   - 内置双重容错解算引擎（支持带尾包的 JustFloat / 纯 Raw Float32 裸流 / FireWater 文本协议）。

2. **🚀 PyQtGraph C++ 硬件加速与零死锁架构**
   - 彻底移除了 Python 层的 Paint 锁竞争与重绘开销。
   - 鼠标左键无缝拖拽平移、滚轮放缩、框选视窗由 **C++ 原生层硬件加速处理**，0 卡顿、0 闪退、0 掉帧！

3. **🎯 固定 Y 轴 BaseLine 防闪烁机制**
   - 默认采用 `[-5.0, 5.0]` 固定 Amplitude 基准，杂波（如 `704118783` 突异值）不会触发 60 FPS 动态 Auto-Scale 跳变闪烁。
   - 提供 **“🎯 适应 Y 轴”** 按钮支持一键单次自适应。

4. **📐 100% 满屏无缝滚轴对齐 (Full-Screen Viewport Alignment)**
   - X 轴视角精确匹配 `0..view_pts`，波形满屏无缝平滑滚动，绝无左右留白网格。

5. **🔒 一键释放 COM 端口独占锁**
   - 内置 **`🔒 释放 COM11 (关闭原版 VOFA+)`** 工具按钮，一键关闭抢占 COM11 端口的其他进程。

6. **⚡ 内置 1000 Pkt/s 闭环测试模拟器**
   - 支持无物理硬件连接下的正弦、余弦、方波、三角波高频推流测试。

---

## 🛠️ 安装与运行 (Installation & Usage)

### 环境依赖
- Python 3.8+
- PyQt5
- pyqtgraph >= 0.13
- pyserial
- numpy

### 一键运行
```cmd
cd /d D:\work\lsl\9.upper\1.code\33.vofa
python vofa_desktop.py
```

---

## 📁 目录结构 (Directory Structure)

- `vofa_desktop.py`: 主桌面上位机程序 (PyQtGraph C++ OpenGL 引擎)
- `vofa_desktop_stable_pyqtgraph.py`: 稳定版本备份文件
- `debug_com11_live.py`: 深度硬件串口诊断与 Raw Byte HEX 抓包工具
- `test_all_bauds.py`: 多波特率 (9600 - 3M) 自动检测扫频引擎
- `index.html` & `js/`: 辅助 Web Serial 基础模组

---

## 📄 License
MIT License - 欢迎自由二次开发与嵌入式工业调参应用！
