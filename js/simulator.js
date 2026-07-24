/**
 * Built-in Data Simulator Engine (虚拟信号发生器)
 * Generates high-fidelity signals (Sine, PID closed loop, 3D IMU Euler angles, Lorenz Chaos)
 * Supports FireWater (text) and JustFloat (binary Float32 + 0x00 0x00 0x80 0x7F tail)
 */
class DataSimulator {
  constructor(onDataCallback) {
    this.onData = onDataCallback;
    this.timer = null;
    this.isRunning = false;
    this.preset = 'standard'; // 'standard' | 'pid' | 'imu' | 'lorenz'
    this.protocolMode = 'firewater'; // 'firewater' | 'justfloat' | 'raw'
    this.frequency = 1.0; // Hz
    this.noiseLevel = 0.1;
    this.t = 0;

    // PID simulation state
    this.pid = {
      sp: 50.0,  // Setpoint
      pv: 0.0,   // Process Variable
      co: 0.0,   // Control Output
      errSum: 0,
      lastErr: 0,
      kp: 1.5,
      ki: 0.2,
      kd: 0.05
    };

    // Lorenz Attractor state
    this.lorenz = { x: 0.1, y: 0.0, z: 0.0, dt: 0.01 };
  }

  setPreset(preset) {
    this.preset = preset;
    this.t = 0;
    if (preset === 'pid') {
      this.pid.pv = 0;
      this.pid.errSum = 0;
    }
  }

  setProtocolMode(mode) {
    this.protocolMode = mode;
  }

  setFrequency(freq) {
    this.frequency = parseFloat(freq) || 1.0;
  }

  setNoiseLevel(noise) {
    this.noiseLevel = parseFloat(noise) || 0.0;
  }

  start(intervalMs = 20) { // 50 Hz default packet rate
    if (this.isRunning) return;
    this.isRunning = true;
    this.t = 0;

    this.timer = setInterval(() => {
      this.step();
    }, intervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isRunning = false;
  }

  step() {
    this.t += 0.02 * this.frequency;
    const noise = () => (Math.random() - 0.5) * 2 * this.noiseLevel;

    let values = []; // Numerical values array
    let textLabels = [];

    if (this.preset === 'standard') {
      // 5 Channels: Sine, Cosine, Triangle, Square, Noise
      const ch0 = Math.sin(this.t * Math.PI * 2) * 10 + noise();
      const ch1 = Math.cos(this.t * Math.PI * 1) * 5 + noise();
      const ch2 = (Math.abs((this.t % 2) - 1) * 10 - 5) + noise();
      const ch3 = (Math.sin(this.t * Math.PI * 2) > 0 ? 8 : -8) + noise();
      const ch4 = Math.sin(this.t * 5) * 3 + noise() * 2;

      values = [ch0, ch1, ch2, ch3, ch4];
      textLabels = ['Sine', 'Cos', 'Triangle', 'Square', 'Noise'];

    } else if (this.preset === 'pid') {
      const dt = 0.02;
      const targetSp = (Math.floor(this.t / 5) % 2 === 0) ? 80.0 : 20.0;
      this.pid.sp = targetSp;

      const err = this.pid.sp - this.pid.pv;
      this.pid.errSum += err * dt;
      const dErr = (err - this.pid.lastErr) / dt;
      this.pid.lastErr = err;

      this.pid.co = this.pid.kp * err + this.pid.ki * this.pid.errSum + this.pid.kd * dErr;
      this.pid.co = Math.max(0, Math.min(100, this.pid.co));
      this.pid.pv += (this.pid.co * 0.9 - this.pid.pv * 0.8) * dt + noise() * 0.5;

      values = [this.pid.sp, this.pid.pv, this.pid.co];
      textLabels = ['Setpoint', 'ProcessVar', 'ControlOut'];

    } else if (this.preset === 'imu') {
      const roll = Math.sin(this.t * 1.2) * 35 + noise() * 2;
      const pitch = Math.cos(this.t * 0.8) * 45 + noise() * 2;
      const yaw = (this.t * 20) % 360 - 180 + noise() * 2;
      const ax = Math.sin(this.t * 1.2) * 0.5;
      const ay = Math.cos(this.t * 0.8) * 0.5;
      const az = 9.81 + noise() * 0.1;

      values = [roll, pitch, yaw, ax, ay, az];
      textLabels = ['Roll', 'Pitch', 'Yaw', 'AccX', 'AccY', 'AccZ'];

    } else if (this.preset === 'lorenz') {
      const sigma = 10, rho = 28, beta = 8/3;
      const dx = sigma * (this.lorenz.y - this.lorenz.x);
      const dy = this.lorenz.x * (rho - this.lorenz.z) - this.lorenz.y;
      const dz = this.lorenz.x * this.lorenz.y - beta * this.lorenz.z;

      this.lorenz.x += dx * 0.005;
      this.lorenz.y += dy * 0.005;
      this.lorenz.z += dz * 0.005;

      values = [this.lorenz.x, this.lorenz.y, this.lorenz.z];
      textLabels = ['Lx', 'Ly', 'Lz'];
    }

    if (!this.onData) return;

    if (this.protocolMode === 'justfloat') {
      // Create Binary JustFloat buffer: N float32 numbers + 4 tail bytes [0x00, 0x00, 0x80, 0x7F]
      const buffer = new ArrayBuffer(values.length * 4 + 4);
      const view = new DataView(buffer);
      for (let i = 0; i < values.length; i++) {
        view.setFloat32(i * 4, values[i], true); // Little-endian
      }
      // Set Tail bytes
      const bytes = new Uint8Array(buffer);
      bytes[bytes.length - 4] = 0x00;
      bytes[bytes.length - 3] = 0x00;
      bytes[bytes.length - 2] = 0x80;
      bytes[bytes.length - 1] = 0x7F;

      this.onData(bytes);
    } else {
      // FireWater / Raw Text Format: "Label0:1.23,Label1:4.56...\n"
      let frameText = values.map((val, idx) => `${textLabels[idx]}:${val.toFixed(2)}`).join(',') + '\n';
      this.onData(frameText);
    }
  }
}

window.DataSimulator = DataSimulator;
