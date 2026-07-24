/**
 * Communication Engine Manager (Web Serial API & WebSocket & Simulator Connection)
 */
class ConnectionManager {
  constructor(onDataCallback, onStatusCallback) {
    this.onData = onDataCallback;
    this.onStatus = onStatusCallback;
    this.mode = 'simulator'; // 'simulator' | 'serial' | 'websocket'
    
    // Web Serial state
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.keepReading = false;
    this.baudRate = 115200;
    this.dataBits = 8;
    this.stopBits = 1;
    this.parity = 'none';

    // WebSocket state
    this.ws = null;
    this.wsUrl = 'ws://localhost:8080';

    // Simulator
    this.simulator = new DataSimulator((data) => {
      if (this.mode === 'simulator' && this.onData) {
        this.onData(data);
      }
    });
  }

  setMode(mode) {
    this.mode = mode;
  }

  setSerialConfig(config) {
    this.baudRate = parseInt(config.baudRate) || 115200;
    this.dataBits = parseInt(config.dataBits) || 8;
    this.stopBits = parseInt(config.stopBits) || 1;
    this.parity = config.parity || 'none';
  }

  setWsUrl(url) {
    this.wsUrl = url;
  }

  async connect() {
    if (this.mode === 'simulator') {
      this.simulator.start();
      if (this.onStatus) this.onStatus(true, '已连接至内置数据模拟器');
      return true;
    } 
    
    if (this.mode === 'websocket') {
      try {
        this.ws = new WebSocket(this.wsUrl);
        this.ws.onopen = () => {
          if (this.onStatus) this.onStatus(true, `已连接至 WebSocket (${this.wsUrl})`);
        };
        this.ws.onmessage = (event) => {
          if (this.onData) this.onData(event.data);
        };
        this.ws.onerror = (err) => {
          if (this.onStatus) this.onStatus(false, `WebSocket 错误: ${err.message || '连接断开'}`);
        };
        this.ws.onclose = () => {
          if (this.onStatus) this.onStatus(false, 'WebSocket 连接已关闭');
        };
        return true;
      } catch (err) {
        if (this.onStatus) this.onStatus(false, `WebSocket 连接失败: ${err.message}`);
        return false;
      }
    }

    if (this.mode === 'serial') {
      if (!('serial' in navigator)) {
        alert('当前浏览器不支持 Web Serial API！请使用 Chrome 89+ 或 Edge 浏览器。');
        if (this.onStatus) this.onStatus(false, '浏览器不支持 Web Serial API');
        return false;
      }

      try {
        this.port = await navigator.serial.requestPort();
        await this.port.open({
          baudRate: this.baudRate,
          dataBits: this.dataBits,
          stopBits: this.stopBits,
          parity: this.parity
        });

        this.keepReading = true;
        this.readSerialLoop();

        if (this.onStatus) this.onStatus(true, `串口已连接 (${this.baudRate} bps)`);
        return true;
      } catch (err) {
        let msg = err.message || '';
        if (msg.includes('already open') || msg.includes('Failed to open')) {
          msg = `串口占用冲突：COM 串口已被其他程序（如桌面版 VOFA+ / 串口调试助手）打开占用！请先关闭桌面版 VOFA+ 或在其他软件中断开串口后重试。`;
        } else {
          msg = `串口连接失败/取消: ${msg}`;
        }
        if (this.onStatus) this.onStatus(false, msg);
        return false;
      }
    }

    return false;
  }

  async disconnect() {
    if (this.mode === 'simulator') {
      this.simulator.stop();
      if (this.onStatus) this.onStatus(false, '已断开模拟器');
    } else if (this.mode === 'websocket') {
      if (this.ws) {
        this.ws.close();
        this.ws = null;
      }
      if (this.onStatus) this.onStatus(false, '已断开 WebSocket');
    } else if (this.mode === 'serial') {
      this.keepReading = false;
      if (this.reader) {
        try {
          await this.reader.cancel();
        } catch (e) {}
      }
      if (this.port) {
        try {
          await this.port.close();
        } catch (e) {}
        this.port = null;
      }
      if (this.onStatus) this.onStatus(false, '已断开硬件串口');
    }
  }

  async readSerialLoop() {
    while (this.port && this.port.readable && this.keepReading) {
      this.reader = this.port.readable.getReader();
      try {
        while (true) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value && this.onData) {
            this.onData(value);
          }
        }
      } catch (error) {
        console.error('Serial read error:', error);
      } finally {
        this.reader.releaseLock();
      }
    }
  }

  async send(data) {
    if (this.mode === 'simulator') {
      console.log('[Simulator TX]:', data);
      return true;
    }
    if (this.mode === 'websocket') {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(data);
        return true;
      }
      return false;
    }
    if (this.mode === 'serial') {
      if (this.port && this.port.writable) {
        const writer = this.port.writable.getWriter();
        let payload;
        if (typeof data === 'string') {
          payload = new TextEncoder().encode(data);
        } else {
          payload = data;
        }
        await writer.write(payload);
        writer.releaseLock();
        return true;
      }
      return false;
    }
    return false;
  }
}

window.ConnectionManager = ConnectionManager;
