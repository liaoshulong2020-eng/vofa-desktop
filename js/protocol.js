/**
 * VOFA+ Protocol Parser Engine (协议解析器 - 高性能对齐版)
 * Supports FireWater, JustFloat (Binary Float32), and Raw Text protocols
 */
class ProtocolDecoder {
  constructor() {
    this.mode = 'firewater'; // 'firewater' | 'justfloat' | 'raw'
    this.buffer = ''; // Text buffer for streaming
    this.byteBuffer = []; // Byte array for binary justfloat
    this.lastByteTime = Date.now();
  }

  setMode(mode) {
    this.mode = mode;
    this.buffer = '';
    this.byteBuffer = [];
  }

  /**
   * Process raw incoming string or ArrayBuffer/Uint8Array
   * @param {Uint8Array|string} chunk 
   * @returns {Array<{timestamp: number, channels: Object<string, number>}>} Parsed sample frames
   */
  decode(chunk) {
    if (!chunk) return [];

    if (this.mode === 'justfloat') {
      if (typeof chunk === 'string') {
        return this.decodeFireWater(chunk);
      }
      return this.decodeJustFloat(chunk);
    } else if (this.mode === 'firewater') {
      if (chunk instanceof Uint8Array || chunk instanceof ArrayBuffer) {
        const bytes = (chunk instanceof ArrayBuffer) ? new Uint8Array(chunk) : chunk;
        // Check if data is ascii text vs binary
        let isText = true;
        for (let i = 0; i < Math.min(bytes.length, 20); i++) {
          if (bytes[i] < 9 || (bytes[i] > 13 && bytes[i] < 32 && bytes[i] !== 0)) {
            isText = false;
            break;
          }
        }
        if (!isText) {
          return this.decodeJustFloat(chunk);
        }
      }
      return this.decodeFireWater(chunk);
    } else {
      return this.decodeRaw(chunk);
    }
  }

  /**
   * Decode FireWater Protocol:
   * Format 1: "ch0:12.3,ch1:45.6\n"
   * Format 2: "12.3,45.6,78.9\n"
   */
  decodeFireWater(chunk) {
    const text = (typeof chunk === 'string') ? chunk : new TextDecoder().decode(chunk);
    this.buffer += text;

    const frames = [];
    const lines = this.buffer.split(/[\r\n]+/);
    
    // Retain incomplete last line in buffer if no trailing newline yet
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const channels = {};
      const now = Date.now();

      if (trimmed.includes(':')) {
        const parts = trimmed.split(',');
        for (const part of parts) {
          const kv = part.split(':');
          if (kv.length === 2) {
            const name = kv[0].trim();
            const val = parseFloat(kv[1].trim());
            if (!isNaN(val) && isFinite(val) && Math.abs(val) < 1e9) {
              channels[name] = val;
            }
          }
        }
      } else {
        const numbers = trimmed.split(/[\s,]+/).map(v => parseFloat(v)).filter(v => !isNaN(v) && isFinite(v) && Math.abs(v) < 1e9);
        numbers.forEach((val, idx) => {
          channels[`CH${idx}`] = val;
        });
      }

      if (Object.keys(channels).length > 0) {
        frames.push({ timestamp: now, channels });
      }
    }

    // Protect buffer against infinite growth
    if (this.buffer.length > 4096) {
      this.buffer = '';
    }
    this.lastByteTime = Date.now();

    return frames;
  }

  /**
   * Decode JustFloat Protocol:
   * Array of float32 values (4 bytes each) ending with tail byte sequence: 0x00 0x00 0x80 0x7F
   * Strictly aligns to 4-byte boundaries to prevent corrupted exponents like e+25!
   */
  decodeJustFloat(chunk) {
    let bytes;
    if (chunk instanceof Uint8Array) {
      bytes = chunk;
    } else if (chunk instanceof ArrayBuffer) {
      bytes = new Uint8Array(chunk);
    } else {
      bytes = new TextEncoder().encode(chunk);
    }

    for (let i = 0; i < bytes.length; i++) {
      this.byteBuffer.push(bytes[i]);
    }

    const frames = [];

    // Find and process frames ending with tail 0x00 0x00 0x80 0x7F
    let tailIdx = this.findTailIndex();
    while (tailIdx !== -1) {
      const rawFrameBytes = this.byteBuffer.slice(0, tailIdx);
      this.byteBuffer = this.byteBuffer.slice(tailIdx + 4); // Remove tail

      // STRICT 4-BYTE ALIGNMENT FROM TAIL END
      const remainder = rawFrameBytes.length % 4;
      const frameBytes = remainder === 0 ? rawFrameBytes : rawFrameBytes.slice(remainder);

      if (frameBytes.length > 0) {
        const dataView = new DataView(new Uint8Array(frameBytes).buffer);
        const floatCount = frameBytes.length / 4;
        const channels = {};
        const now = Date.now();

        for (let f = 0; f < floatCount; f++) {
          const val = dataView.getFloat32(f * 4, true); // Little-endian float32
          // Filter out corrupted non-physical numbers
          if (!isNaN(val) && isFinite(val) && Math.abs(val) < 1e9) {
            channels[`CH${f}`] = val;
          }
        }

        if (Object.keys(channels).length > 0) {
          frames.push({ timestamp: now, channels });
        }
      }

      tailIdx = this.findTailIndex();
    }

    // Safety guard against un-terminated buffer overflow
    if (this.byteBuffer.length > 4096) {
      this.byteBuffer = this.byteBuffer.slice(-256);
    }
    this.lastByteTime = Date.now();

    return frames;
  }

  findTailIndex() {
    const buf = this.byteBuffer;
    for (let i = 0; i <= buf.length - 4; i++) {
      if (buf[i] === 0x00 && buf[i + 1] === 0x00 && buf[i + 2] === 0x80 && buf[i + 3] === 0x7F) {
        return i;
      }
    }
    return -1;
  }

  /**
   * Decode Raw Text protocol (Extract floating point numbers using regex)
   */
  decodeRaw(chunk) {
    const text = (typeof chunk === 'string') ? chunk : new TextDecoder().decode(chunk);
    this.buffer += text;

    const frames = [];
    const lines = this.buffer.split(/[\r\n]+/);
    this.buffer = lines.pop() || '';

    const numberRegex = /-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi;

    for (const line of lines) {
      const matches = line.match(numberRegex);
      if (matches && matches.length > 0) {
        const channels = {};
        const now = Date.now();
        matches.forEach((str, idx) => {
          const val = parseFloat(str);
          if (!isNaN(val) && isFinite(val) && Math.abs(val) < 1e9) {
            channels[`CH${idx}`] = val;
          }
        });
        if (Object.keys(channels).length > 0) {
          frames.push({ timestamp: now, channels });
        }
      }
    }

    return frames;
  }
}

window.ProtocolDecoder = ProtocolDecoder;
