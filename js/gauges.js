/**
 * Dynamic Gauges & Dial Meters Component (数显仪表盘与拟真指针仪表库)
 */
class GaugeManager {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this.gauges = {}; // channelName -> { canvas, ctx, title, min, max, value, color }
  }

  updateChannelValue(chName, value, color = '#00f3ff') {
    if (isNaN(value)) return;

    if (!this.gauges[chName]) {
      this.createGaugeCard(chName, color);
    }

    const gauge = this.gauges[chName];
    gauge.value = value;

    // Auto expand min/max limits
    if (value < gauge.min) gauge.min = Math.floor(value - 10);
    if (value > gauge.max) gauge.max = Math.ceil(value + 10);

    this.drawGauge(gauge);
  }

  createGaugeCard(chName, color) {
    if (!this.container) return;

    const card = document.createElement('div');
    card.className = 'gauge-card';
    card.id = `gauge-card-${chName}`;

    card.innerHTML = `
      <div class="gauge-title">${chName}</div>
      <div class="gauge-canvas-box">
        <canvas id="gauge-cvs-${chName}" width="140" height="140"></canvas>
      </div>
      <div class="gauge-value" id="gauge-val-${chName}">0.00</div>
    `;

    this.container.appendChild(card);

    const canvas = card.querySelector(`#gauge-cvs-${chName}`);
    const ctx = canvas.getContext('2d');

    this.gauges[chName] = {
      card,
      canvas,
      ctx,
      valDisplay: card.querySelector(`#gauge-val-${chName}`),
      chName,
      min: -10,
      max: 10,
      value: 0,
      color
    };
  }

  drawGauge(gauge) {
    const { ctx, canvas, value, min, max, color, valDisplay } = gauge;
    const w = canvas.width;
    const h = canvas.height;
    const cx = w / 2;
    const cy = h / 2;
    const radius = 55;

    ctx.clearRect(0, 0, w, h);

    // Update text readout
    if (valDisplay) {
      valDisplay.innerText = value.toFixed(2);
      valDisplay.style.color = color;
    }

    // 1. Background Arc (240 degrees angle)
    const startAngle = 0.75 * Math.PI;
    const endAngle = 2.25 * Math.PI;

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.lineWidth = 10;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(cx, cy, radius, startAngle, endAngle);
    ctx.stroke();

    // 2. Active Value Arc
    const norm = Math.max(0, Math.min(1, (value - min) / (max - min || 1)));
    const valueAngle = startAngle + norm * (endAngle - startAngle);

    ctx.strokeStyle = color;
    ctx.lineWidth = 10;
    ctx.shadowColor = color;
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, startAngle, valueAngle);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // 3. Pointer Needle
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(valueAngle + Math.PI / 2);

    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.moveTo(-3, 0);
    ctx.lineTo(3, 0);
    ctx.lineTo(0, -radius + 8);
    ctx.closePath();
    ctx.fill();

    ctx.restore();

    // Center Cap
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(cx, cy, 6, 0, Math.PI * 2);
    ctx.fill();
  }
}

window.GaugeManager = GaugeManager;
