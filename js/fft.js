/**
 * Real-Time FFT Spectrum Analyzer (基于 Canvas 的快速傅里叶变换频谱分析引擎)
 */
class FFTAnalyzer {
  constructor(canvasElement) {
    this.canvas = canvasElement;
    this.ctx = canvasElement.getContext('2d');
    this.sampleBuffer = [];
    this.fftSize = 256; // Must be power of 2
    this.targetChannel = null;

    this.resize();
    window.addEventListener('resize', () => this.resize());
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

  pushSample(value) {
    if (isNaN(value)) return;
    this.sampleBuffer.push(value);
    if (this.sampleBuffer.length > this.fftSize) {
      this.sampleBuffer.shift();
    }
  }

  renderLoop() {
    this.draw();
    requestAnimationFrame(() => this.renderLoop());
  }

  draw() {
    const w = this.width;
    const h = this.height;
    this.ctx.clearRect(0, 0, w, h);

    if (this.sampleBuffer.length < this.fftSize) {
      this.ctx.fillStyle = '#8492a6';
      this.ctx.font = '12px Inter';
      this.ctx.fillText(`正在收集 FFT 采样数据点 (${this.sampleBuffer.length}/${this.fftSize})...`, 20, 30);
      return;
    }

    // Compute FFT Magnitudes
    const spectrum = this.computeFFT(this.sampleBuffer);
    const numBins = spectrum.length;
    const barWidth = (w / numBins) * 0.9;

    // Draw Frequency Bars
    for (let i = 0; i < numBins; i++) {
      const mag = spectrum[i];
      const barHeight = Math.min(h * 0.85, mag * (h * 0.35));
      const x = i * (w / numBins);
      const y = h - barHeight;

      // Color Gradient from Cyan to Purple to Pink
      const gradient = this.ctx.createLinearGradient(0, h, 0, y);
      gradient.addColorStop(0, '#00f3ff');
      gradient.addColorStop(0.5, '#9d4edd');
      gradient.addColorStop(1, '#ff007f');

      this.ctx.fillStyle = gradient;
      this.ctx.fillRect(x, y, barWidth, barHeight);
    }

    // Draw Spectrum Peak Line
    this.ctx.strokeStyle = '#00ff87';
    this.ctx.lineWidth = 2;
    this.ctx.beginPath();
    for (let i = 0; i < numBins; i++) {
      const mag = spectrum[i];
      const barHeight = Math.min(h * 0.85, mag * (h * 0.35));
      const x = i * (w / numBins) + barWidth / 2;
      const y = h - barHeight;
      if (i === 0) this.ctx.moveTo(x, y);
      else this.ctx.lineTo(x, y);
    }
    this.ctx.stroke();

    // Draw Frequency Labels
    this.ctx.fillStyle = '#8492a6';
    this.ctx.font = '10px JetBrains Mono';
    this.ctx.fillText('0 Hz (DC)', 10, h - 6);
    this.ctx.fillText('Nyquist Peak', w - 80, h - 6);
  }

  /**
   * Cooley-Tukey Radix-2 FFT Implementation
   */
  computeFFT(realInput) {
    const N = realInput.length;
    const real = new Float32Array(realInput);
    const imag = new Float32Array(N);

    // Bit reversal permutation
    let j = 0;
    for (let i = 0; i < N - 1; i++) {
      if (i < j) {
        const tempR = real[i]; real[i] = real[j]; real[j] = tempR;
      }
      let k = N >> 1;
      while (k <= j) {
        j -= k;
        k >>= 1;
      }
      j += k;
    }

    // Compute FFT
    for (let len = 2; len <= N; len <<= 1) {
      const halfLen = len >> 1;
      const angle = (-2 * Math.PI) / len;
      const wStepR = Math.cos(angle);
      const wStepI = Math.sin(angle);

      for (let i = 0; i < N; i += len) {
        let wR = 1;
        let wI = 0;
        for (let k = 0; k < halfLen; k++) {
          const pos = i + k;
          const matchPos = pos + halfLen;

          const uR = real[pos];
          const uI = imag[pos];
          const vR = real[matchPos] * wR - imag[matchPos] * wI;
          const vI = real[matchPos] * wI + imag[matchPos] * wR;

          real[pos] = uR + vR;
          imag[pos] = uI + vI;
          real[matchPos] = uR - vR;
          imag[matchPos] = uI - vI;

          const nextWR = wR * wStepR - wI * wStepI;
          const nextWI = wR * wStepI + wI * wStepR;
          wR = nextWR;
          wI = nextWI;
        }
      }
    }

    // Magnitude calculation for first N/2 bins
    const magnitudes = new Float32Array(N / 2);
    for (let i = 0; i < N / 2; i++) {
      magnitudes[i] = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]) / N;
    }
    return magnitudes;
  }
}

window.FFTAnalyzer = FFTAnalyzer;
