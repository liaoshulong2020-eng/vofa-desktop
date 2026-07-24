/**
 * High-Performance 60 FPS HTML5 Canvas Oscilloscope Engine (多通道高速动态示波器引擎)
 * Features:
 *  - VOFA+ Roll Mode (Latest data arrives at right edge X=W, flowing Left)
 *  - X-Axis Mouse Wheel Zooming (时间轴放缩)
 *  - X-Axis & Y-Axis Drag Panning (鼠标拖拽平移波形)
 *  - Real-time X-Axis Timebase Grid & Ticks (-10.0s ... 0.0s)
 */
class Oscilloscope {
  constructor(canvasElement, tooltipElement) {
    this.canvas = canvasElement;
    this.ctx = canvasElement.getContext('2d');
    this.tooltip = tooltipElement;

    // Channels Configuration
    this.channels = {}; // name -> { name, color, visible, scale, offset, data: [] }
    this.defaultColors = [
      '#00f3ff', '#00ff87', '#ffaa00', '#ff007f', 
      '#9d4edd', '#3a86ff', '#ffbc42', '#e71d36'
    ];
    this.colorIdx = 0;

    // View Options
    this.bufferSize = 20000; // max historical buffer depth
    this.viewPointCount = 1000; // current X axis time window (points)
    this.panPointOffset = 0; // 0 = live edge at right, >0 = panned back into history
    this.autoScroll = true;
    this.showGrid = true;
    this.showPoints = true;
    this.showCursor = false;
    this.isPaused = false;

    // Render Stats
    this.fps = 60;
    this.lastFrameTime = performance.now();
    this.frameCount = 0;
    this.totalPoints = 0;

    // Interactive Zoom / Pan State
    this.yMin = -10;
    this.yMax = 10;
    this.zoomY = 1.0;
    this.panY = 0.0;
    this.cursorX = null;
    this.cursorY = null;

    // Drag State
    this.isDragging = false;
    this.dragStartX = 0;
    this.dragStartY = 0;
    this.dragStartPanPoints = 0;
    this.dragStartPanY = 0;

    // Setup Canvas Resolution & Listeners
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.setupMouseEvents();

    // Start 60 FPS Render Loop
    this.renderLoop();
  }

  resize() {
    if (!this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.ctx.scale(dpr, dpr);
    this.width = rect.width;
    this.height = rect.height;
  }

  addChannel(name, color = null) {
    if (this.channels[name]) return this.channels[name];

    const chColor = color || this.defaultColors[this.colorIdx % this.defaultColors.length];
    this.colorIdx++;

    this.channels[name] = {
      name,
      color: chColor,
      visible: true,
      scale: 1.0,
      offset: 0.0,
      data: [] // { t, y }
    };
    return this.channels[name];
  }

  pushFrame(frame) {
    if (this.isPaused) return;

    const timestamp = frame.timestamp || Date.now();
    this.totalPoints++;

    for (const [chName, val] of Object.entries(frame.channels)) {
      if (!this.channels[chName]) {
        this.addChannel(chName);
      }
      const ch = this.channels[chName];
      ch.data.push({ t: timestamp, y: val });

      // Maintain Historical Buffer Limit
      if (ch.data.length > this.bufferSize) {
        ch.data.shift();
      }
    }

    // Auto-update Y limits when auto fit enabled
    if (this.panPointOffset === 0) {
      this.updateYLimits();
    }
  }

  updateYLimits() {
    let minVal = Infinity;
    let maxVal = -Infinity;

    for (const ch of Object.values(this.channels)) {
      if (!ch.visible || ch.data.length === 0) continue;
      const recent = ch.data.slice(-this.viewPointCount);
      for (const p of recent) {
        if (p.y < minVal) minVal = p.y;
        if (p.y > maxVal) maxVal = p.y;
      }
    }

    if (minVal !== Infinity && maxVal !== -Infinity) {
      if (minVal === maxVal) {
        minVal -= 1;
        maxVal += 1;
      }
      const margin = (maxVal - minVal) * 0.15;
      this.yMin = minVal - margin;
      this.yMax = maxVal + margin;
    }
  }

  clear() {
    for (const ch of Object.values(this.channels)) {
      ch.data = [];
    }
    this.totalPoints = 0;
    this.panPointOffset = 0;
    this.panY = 0;
  }

  setupMouseEvents() {
    // 1. Mouse Move & Drag
    this.canvas.addEventListener('mousemove', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      this.cursorX = x;
      this.cursorY = y;

      if (this.isDragging) {
        const deltaX = x - this.dragStartX;
        const deltaY = y - this.dragStartY;

        // X Drag: Convert pixel offset to points
        const stepX = this.width / (this.viewPointCount - 1);
        const pointDelta = Math.round(deltaX / stepX);
        this.panPointOffset = Math.max(0, this.dragStartPanPoints + pointDelta);

        // Y Drag: Convert pixel offset to value shift (Natural drag: drag down moves waveform down)
        const yRange = (this.yMax - this.yMin) / this.zoomY;
        const valDelta = (deltaY / this.height) * yRange;
        this.panY = this.dragStartPanY - valDelta;
      } else if (this.showCursor && this.tooltip) {
        this.updateCursorTooltip();
      }
    });

    // 2. Mouse Down (Start Dragging)
    this.canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0) { // Left click
        this.isDragging = true;
        const rect = this.canvas.getBoundingClientRect();
        this.dragStartX = e.clientX - rect.left;
        this.dragStartY = e.clientY - rect.top;
        this.dragStartPanPoints = this.panPointOffset;
        this.dragStartPanY = this.panY;
        this.canvas.style.cursor = 'grabbing';
      }
    });

    // 3. Mouse Up & Leave
    const endDrag = (e) => {
      // Check if clicked on floating "Resume Live" button (Top-Right)
      if (this.panPointOffset > 0 && e) {
        const rect = this.canvas.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const clickY = e.clientY - rect.top;
        if (clickX >= this.width - 140 && clickX <= this.width - 10 && clickY >= 10 && clickY <= 36) {
          this.panPointOffset = 0;
          this.panY = 0;
        }
      }

      this.isDragging = false;
      this.canvas.style.cursor = 'crosshair';
    };

    this.canvas.addEventListener('mouseup', endDrag);
    this.canvas.addEventListener('mouseleave', () => {
      this.isDragging = false;
      this.cursorX = null;
      this.cursorY = null;
      this.canvas.style.cursor = 'default';
      if (this.tooltip) this.tooltip.style.display = 'none';
    });

    // 4. Mouse Wheel Zoom (Default: X-axis time zoom, Shift+Wheel: Y-axis zoom)
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      
      if (e.shiftKey) {
        // Y-axis Zoom
        if (e.deltaY < 0) {
          this.zoomY *= 1.15;
        } else {
          this.zoomY /= 1.15;
        }
      } else {
        // X-axis Time Base Zoom
        if (e.deltaY < 0) {
          // Zoom In X (fewer points in view window -> detailed view)
          this.viewPointCount = Math.max(20, Math.round(this.viewPointCount * 0.82));
        } else {
          // Zoom Out X (more points in view window -> macro view)
          this.viewPointCount = Math.min(this.bufferSize, Math.round(this.viewPointCount * 1.22));
        }
      }
    });
  }

  updateCursorTooltip() {
    if (this.cursorX === null) return;
    const w = this.width;
    const stepX = w / (this.viewPointCount - 1);

    let textHtml = `<div style="font-weight:700;color:#00f3ff;margin-bottom:4px;">游标测量:</div>`;
    let foundAny = false;

    for (const ch of Object.values(this.channels)) {
      if (!ch.visible || ch.data.length === 0) continue;

      const endIdx = ch.data.length - 1 - this.panPointOffset;
      const startIdx = Math.max(0, endIdx - this.viewPointCount + 1);
      const slice = ch.data.slice(startIdx, Math.max(1, endIdx + 1));
      const count = slice.length;

      const distFromRight = w - this.cursorX;
      const k = Math.round(distFromRight / stepX);
      const index = count - 1 - k;

      if (index >= 0 && index < count) {
        const point = slice[index];
        textHtml += `<div><span style="color:${ch.color}">■</span> ${ch.name}: <b style="color:#fff">${point.y.toFixed(3)}</b></div>`;
        foundAny = true;
      }
    }

    if (foundAny) {
      this.tooltip.innerHTML = textHtml;
      this.tooltip.style.left = `${this.cursorX + 15}px`;
      this.tooltip.style.top = `${this.cursorY + 15}px`;
      this.tooltip.style.display = 'block';
    } else {
      this.tooltip.style.display = 'none';
    }
  }

  renderLoop() {
    const now = performance.now();
    this.frameCount++;
    if (now - this.lastFrameTime >= 1000) {
      this.fps = this.frameCount;
      this.frameCount = 0;
      this.lastFrameTime = now;
    }

    this.draw();
    requestAnimationFrame(() => this.renderLoop());
  }

  draw() {
    const w = this.width;
    const h = this.height;

    this.ctx.clearRect(0, 0, w, h);

    // Background Grid & X-Axis Timebase Ticks
    if (this.showGrid) {
      this.drawGrid(w, h);
    }

    // Zero Axis line
    const zeroY = this.valToY(0);
    this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
    this.ctx.setLineDash([4, 4]);
    this.ctx.beginPath();
    this.ctx.moveTo(0, zeroY);
    this.ctx.lineTo(w, zeroY);
    this.ctx.stroke();
    this.ctx.setLineDash([]);

    // Draw Channel Waveforms in VOFA+ ROLL MODE
    for (const ch of Object.values(this.channels)) {
      if (!ch.visible || ch.data.length < 2) continue;

      // Slice historical data considering panPointOffset
      const endIdx = ch.data.length - 1 - this.panPointOffset;
      if (endIdx < 0) continue;
      const startIdx = Math.max(0, endIdx - this.viewPointCount + 1);
      const slice = ch.data.slice(startIdx, endIdx + 1);
      const count = slice.length;

      const stepX = w / (this.viewPointCount - 1);
      const lastIdx = count - 1;

      this.ctx.strokeStyle = ch.color;
      this.ctx.lineWidth = 2;
      this.ctx.shadowColor = ch.color;
      this.ctx.shadowBlur = 4;
      this.ctx.beginPath();

      for (let i = 0; i < count; i++) {
        // Roll mode: distance from the newest rendered point
        const distFromNewest = lastIdx - i;
        const x = w - distFromNewest * stepX;
        const y = this.valToY(slice[i].y * ch.scale + ch.offset);

        if (i === 0) {
          this.ctx.moveTo(x, y);
        } else {
          this.ctx.lineTo(x, y);
        }
      }
      this.ctx.stroke();
      this.ctx.shadowBlur = 0;

      // Draw Sample Points
      if (this.showPoints && count < 200) {
        this.ctx.fillStyle = ch.color;
        for (let i = 0; i < count; i++) {
          const distFromNewest = lastIdx - i;
          const x = w - distFromNewest * stepX;
          const y = this.valToY(slice[i].y * ch.scale + ch.offset);
          this.ctx.beginPath();
          this.ctx.arc(x, y, 3, 0, Math.PI * 2);
          this.ctx.fill();
        }
      }
    }

    // Draw Cursor Line
    if (this.showCursor && this.cursorX !== null) {
      this.ctx.strokeStyle = 'rgba(0, 243, 255, 0.7)';
      this.ctx.lineWidth = 1;
      this.ctx.setLineDash([2, 2]);
      
      this.ctx.beginPath();
      this.ctx.moveTo(this.cursorX, 0);
      this.ctx.lineTo(this.cursorX, h);
      this.ctx.stroke();

      this.ctx.beginPath();
      this.ctx.moveTo(0, this.cursorY);
      this.ctx.lineTo(w, this.cursorY);
      this.ctx.stroke();

      this.ctx.setLineDash([]);
    }

    // Draw Resume Live Floating Button when panned back
    if (this.panPointOffset > 0) {
      this.drawResumeLiveButton(w);
    }

    // Draw Timebase Scale Badge
    this.drawTimebaseBadge(w, h);
  }

  drawGrid(w, h) {
    this.ctx.strokeStyle = 'rgba(0, 243, 255, 0.08)';
    this.ctx.lineWidth = 1;
    this.ctx.fillStyle = 'rgba(132, 146, 166, 0.6)';
    this.ctx.font = '10px JetBrains Mono';

    // 1. Vertical Lines & X-Axis Timebase Labels (Right to Left: 0.00s, -1.00s ...)
    const xGridCount = 10;

    // Estimate time per point assuming ~50Hz sampling (20ms/point)
    const samplePeriodSec = 0.02; 
    const totalSpanSec = this.viewPointCount * samplePeriodSec;

    for (let i = 0; i <= xGridCount; i++) {
      const x = (w / xGridCount) * i;
      this.ctx.beginPath();
      this.ctx.moveTo(x, 0);
      this.ctx.lineTo(x, h);
      this.ctx.stroke();

      // Relative Time Offset in Seconds from Right Edge
      const relativeTime = -((w - x) / w) * totalSpanSec;
      const label = (relativeTime === 0 ? '0.0s' : `${relativeTime.toFixed(1)}s`);
      
      // Align X axis text
      const textWidth = this.ctx.measureText(label).width;
      const labelX = (i === xGridCount) ? x - textWidth - 6 : (i === 0 ? x + 6 : x - textWidth / 2);
      this.ctx.fillText(label, labelX, h - 8);
    }

    // 2. Horizontal Lines & Y-Axis Amplitude Labels
    const yGridCount = 8;
    for (let i = 0; i <= yGridCount; i++) {
      const y = (h / yGridCount) * i;
      this.ctx.beginPath();
      this.ctx.moveTo(0, y);
      this.ctx.lineTo(w, y);
      this.ctx.stroke();

      const val = this.yToVal(y);
      this.ctx.fillText(val.toFixed(2), 6, y - 4);
    }
  }

  drawResumeLiveButton(w) {
    const btnWidth = 130;
    const btnHeight = 26;
    const x = w - btnWidth - 12;
    const y = 10;

    this.ctx.fillStyle = 'rgba(0, 243, 255, 0.2)';
    this.ctx.strokeStyle = '#00f3ff';
    this.ctx.lineWidth = 1;
    this.ctx.beginPath();
    this.ctx.roundRect(x, y, btnWidth, btnHeight, 4);
    this.ctx.fill();
    this.ctx.stroke();

    this.ctx.fillStyle = '#00f3ff';
    this.ctx.font = '11px Inter, sans-serif';
    this.ctx.fillText('▶ 恢复实时跟随', x + 16, y + 17);
  }

  drawTimebaseBadge(w, h) {
    const text = `X轴视角: ${this.viewPointCount} 点 | 滚轮放缩X轴 | 按住Shift放缩Y轴 | 拖拽平移`;
    this.ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
    this.ctx.fillRect(w / 2 - 180, 4, 360, 20);
    this.ctx.fillStyle = 'rgba(0, 243, 255, 0.8)';
    this.ctx.font = '10px Inter, sans-serif';
    this.ctx.textAlign = 'center';
    this.ctx.fillText(text, w / 2, 18);
    this.ctx.textAlign = 'left';
  }

  valToY(val) {
    const range = (this.yMax - this.yMin) / this.zoomY;
    const norm = (val - this.yMin + this.panY) / range;
    return this.height - norm * this.height;
  }

  yToVal(y) {
    const range = (this.yMax - this.yMin) / this.zoomY;
    const norm = (this.height - y) / this.height;
    return (this.yMin - this.panY) + norm * range;
  }

  getChannelStats(chName) {
    const ch = this.channels[chName];
    if (!ch || ch.data.length === 0) return { min: 0, max: 0, avg: 0, rms: 0, vpp: 0 };

    const recent = ch.data.slice(-this.viewPointCount);
    let min = Infinity, max = -Infinity, sum = 0, sumSq = 0;

    for (const p of recent) {
      if (p.y < min) min = p.y;
      if (p.y > max) max = p.y;
      sum += p.y;
      sumSq += p.y * p.y;
    }

    const count = recent.length;
    const avg = sum / count;
    const rms = Math.sqrt(sumSq / count);
    const vpp = max - min;

    return { min, max, avg, rms, vpp };
  }
}

window.Oscilloscope = Oscilloscope;
