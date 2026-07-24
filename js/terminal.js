/**
 * Serial Data Terminal & Raw Logging Console (串口终端与数据日志控制 - 3M波特率超防卡顿版)
 */
class SerialTerminal {
  constructor(outputElement) {
    this.output = outputElement;
    this.showHex = false;
    this.showTimestamp = true;
    this.autoScroll = true;
    this.filterKeyword = '';
    this.lines = [];
    this.maxLines = 500;

    // High-speed logging throttle buffer
    this.logQueue = [];
    this.startBatchTimer();
  }

  logRx(chunk) {
    this.logQueue.push({ data: chunk, type: 'rx' });
  }

  logTx(chunk) {
    this.logQueue.push({ data: chunk, type: 'tx' });
  }

  logSys(msg) {
    this.logQueue.push({ data: msg, type: 'sys' });
  }

  startBatchTimer() {
    // Flush terminal DOM at 10 FPS (100ms interval) to avoid locking browser UI thread at 3M baud rate
    setInterval(() => {
      this.flushQueue();
    }, 100);
  }

  flushQueue() {
    if (!this.output || this.logQueue.length === 0) return;

    // Process up to 50 queued items per batch to keep UI responsive
    const batch = this.logQueue.splice(0, 50);
    const fragment = document.createDocumentFragment();
    const nowStr = new Date().toLocaleTimeString() + '.' + String(Date.now() % 1000).padStart(3, '0');

    for (const item of batch) {
      let content = '';
      const data = item.data;
      const type = item.type;

      if (typeof data === 'string') {
        content = data;
      } else if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
        const bytes = (data instanceof ArrayBuffer) ? new Uint8Array(data) : data;
        if (this.showHex) {
          content = Array.from(bytes).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
        } else {
          content = new TextDecoder().decode(bytes);
        }
      }

      if (this.showHex && typeof data === 'string') {
        content = Array.from(new TextEncoder().encode(data)).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
      }

      const lines = content.split(/\r?\n/);

      for (const line of lines) {
        if (!line && type !== 'sys') continue;
        
        if (this.filterKeyword && !line.toLowerCase().includes(this.filterKeyword.toLowerCase())) {
          continue;
        }

        const lineDiv = document.createElement('div');
        lineDiv.className = `log-line log-${type}`;

        let html = '';
        if (this.showTimestamp) {
          html += `<span class="log-time">[${nowStr}]</span>`;
        }

        const prefix = type === 'rx' ? 'RX ◀ ' : (type === 'tx' ? 'TX ▶ ' : 'SYS ⚡ ');
        html += `<b>${prefix}</b>${this.escapeHtml(line)}`;

        lineDiv.innerHTML = html;
        fragment.appendChild(lineDiv);
        this.lines.push(lineDiv);
      }
    }

    this.output.appendChild(fragment);

    // Maintain max line count limit
    while (this.lines.length > this.maxLines) {
      const oldest = this.lines.shift();
      if (oldest && oldest.parentNode) {
        oldest.parentNode.removeChild(oldest);
      }
    }

    if (this.autoScroll) {
      this.output.scrollTop = this.output.scrollHeight;
    }
  }

  clear() {
    if (this.output) {
      this.output.innerHTML = '';
    }
    this.lines = [];
    this.logQueue = [];
  }

  escapeHtml(str) {
    return str.replace(/&/g, "&amp;")
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;")
              .replace(/"/g, "&quot;")
              .replace(/'/g, "&#039;");
  }

  exportCSV(channelsData) {
    let csvContent = 'data:text/csv;charset=utf-8,Timestamp';
    const chNames = Object.keys(channelsData);
    if (chNames.length === 0) {
      alert('暂无导出数据！');
      return;
    }

    chNames.forEach(name => {
      csvContent += `,${name}`;
    });
    csvContent += '\n';

    const sampleCount = channelsData[chNames[0]].data.length;
    for (let i = 0; i < sampleCount; i++) {
      const p0 = channelsData[chNames[0]].data[i];
      let line = `${p0 ? p0.t : ''}`;
      chNames.forEach(name => {
        const pt = channelsData[name].data[i];
        line += `,${pt ? pt.y : ''}`;
      });
      csvContent += line + '\n';
    }

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `vofa_data_export_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
}

window.SerialTerminal = SerialTerminal;
