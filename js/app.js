/**
 * VOFA+ Web Application Main Controller (主逻辑调度中心)
 */
document.addEventListener('DOMContentLoaded', () => {
  // 1. DOM Elements
  const btnConnect = document.getElementById('btnConnect');
  const connectBtnText = document.getElementById('connectBtnText');
  const statusIndicator = document.getElementById('statusIndicator');
  const statusText = document.getElementById('statusText');
  const sourceSelect = document.getElementById('sourceSelect');
  const protocolSelect = document.getElementById('protocolSelect');
  const headerBaudGroup = document.getElementById('headerBaudGroup');
  const headerBaudInput = document.getElementById('headerBaudInput');
  const simPresetSelect = document.getElementById('simPresetSelect');
  const simFreqRange = document.getElementById('simFreqRange');
  const simFreqVal = document.getElementById('simFreqVal');
  const simNoiseRange = document.getElementById('simNoiseRange');
  const simNoiseVal = document.getElementById('simNoiseVal');

  // Stats Counters
  const fpsCounter = document.getElementById('fpsCounter');
  const dataRateCounter = document.getElementById('dataRateCounter');
  const totalPointsCounter = document.getElementById('totalPointsCounter');
  const lossCounter = document.getElementById('lossCounter');

  // Channel Manager List
  const channelList = document.getElementById('channelList');
  const channelSummaryTable = document.getElementById('channelSummaryTable');

  // Terminal & Command Elements
  const terminalOutput = document.getElementById('terminalOutput');
  const btnSendCmd = document.getElementById('btnSendCmd');
  const cmdInput = document.getElementById('cmdInput');
  const sendModeSelect = document.getElementById('sendModeSelect');
  const lineEndingSelect = document.getElementById('lineEndingSelect');
  const chkAutoSend = document.getElementById('chkAutoSend');
  const autoSendInterval = document.getElementById('autoSendInterval');
  const chkTerminalHex = document.getElementById('chkTerminalHex');
  const chkShowTimestamp = document.getElementById('chkShowTimestamp');
  const chkAutoScrollTerm = document.getElementById('chkAutoScrollTerm');
  const terminalFilter = document.getElementById('terminalFilter');
  const btnClearTerminal = document.getElementById('btnClearTerminal');

  // Oscilloscope Toolbar Actions
  const btnPause = document.getElementById('btnPause');
  const btnClear = document.getElementById('btnClear');
  const btnExport = document.getElementById('btnExport');
  const btnZoomIn = document.getElementById('btnZoomIn');
  const btnZoomOut = document.getElementById('btnZoomOut');
  const btnAutoFit = document.getElementById('btnAutoFit');
  const btnToggleGrid = document.getElementById('btnToggleGrid');
  const btnTogglePoints = document.getElementById('btnTogglePoints');
  const btnToggleCursor = document.getElementById('btnToggleCursor');
  const bufferSizeSelect = document.getElementById('bufferSizeSelect');

  // Modal Settings
  const settingsModal = document.getElementById('settingsModal');
  const btnOpenSettings = document.getElementById('btnOpenSettings');
  const btnCloseModal = document.getElementById('btnCloseModal');
  const btnSaveSettings = document.getElementById('btnSaveSettings');
  const baudRateInput = document.getElementById('baudRateInput');
  const baudPresetSelect = document.getElementById('baudPresetSelect');

  // 2. Instantiate Core Modules
  const decoder = new ProtocolDecoder();
  const terminal = new SerialTerminal(terminalOutput);

  // Initialize Oscilloscopes (Main & Mini)
  const scopeCanvas = document.getElementById('scopeCanvas');
  const tooltipElement = document.getElementById('cursorTooltip');
  const scope = new Oscilloscope(scopeCanvas, tooltipElement);

  const miniScopeCanvas = document.getElementById('miniScopeCanvas');
  let miniScope = null;
  if (miniScopeCanvas) {
    miniScope = new Oscilloscope(miniScopeCanvas, null);
  }

  // Initialize 3D IMU Visualizer
  const imuVisualizer = new IMU3DVisualizer('imu3dViewport');

  // Initialize FFT Analyzer
  const fftCanvas = document.getElementById('fftCanvas');
  const fft = new FFTAnalyzer(fftCanvas);

  // Initialize Gauge Manager
  const gaugeManager = new GaugeManager('gaugesGrid');
  const miniGaugeManager = new GaugeManager('miniGaugesContainer');

  // Rates & Data counters
  let isConnected = false;
  let packetCountAcc = 0;
  let packetsPerSec = 0;
  let autoSendTimer = null;

  // Sync default simulator protocol
  decoder.setMode(protocolSelect.value);

  // Initialize Connection Engine
  const connection = new ConnectionManager(
    // Data Callback
    (rawData) => {
      packetCountAcc++;
      terminal.logRx(rawData);

      // Decode Frames via Protocol Decoder
      const frames = decoder.decode(rawData);

      for (const frame of frames) {
        // Push frame to Oscilloscopes
        scope.pushFrame(frame);
        if (miniScope) miniScope.pushFrame(frame);

        // Process IMU Roll/Pitch/Yaw if available
        if (frame.channels['Roll'] !== undefined || frame.channels['CH0'] !== undefined) {
          const roll = frame.channels['Roll'] ?? frame.channels['CH0'];
          const pitch = frame.channels['Pitch'] ?? frame.channels['CH1'] ?? 0;
          const yaw = frame.channels['Yaw'] ?? frame.channels['CH2'] ?? 0;

          imuVisualizer.updateAttitude(roll, pitch, yaw);
          updateIMUHud(roll, pitch, yaw);
        }

        // Feed Channel Data to FFT & Gauges
        for (const [chName, val] of Object.entries(frame.channels)) {
          // Push to FFT target
          const targetFFTCh = document.getElementById('fftChannelSelect').value || Object.keys(frame.channels)[0];
          if (chName === targetFFTCh) {
            fft.pushSample(val);
          }

          // Update Gauges
          const chColor = scope.channels[chName] ? scope.channels[chName].color : '#00f3ff';
          gaugeManager.updateChannelValue(chName, val, chColor);
          miniGaugeManager.updateChannelValue(chName, val, chColor);
        }
      }
    },
    // Status Callback
    (status, msg) => {
      isConnected = status;
      if (status) {
        statusIndicator.querySelector('.status-dot').className = 'status-dot connected';
        statusText.innerText = '已连接';
        connectBtnText.innerText = '断开连接';
        btnConnect.className = 'btn btn-danger';
        terminal.logSys(msg);
      } else {
        statusIndicator.querySelector('.status-dot').className = 'status-dot disconnected';
        statusText.innerText = '未连接';
        updateConnectButtonLabel();
        btnConnect.className = 'btn btn-primary';
        terminal.logSys(msg);
      }
    }
  );

  // Helper to update button label based on source
  function updateConnectButtonLabel() {
    if (isConnected) return;
    const src = sourceSelect.value;
    if (src === 'serial') {
      connectBtnText.innerText = '🔌 选择 COM 端口并连接';
      headerBaudGroup.style.display = 'flex';
    } else if (src === 'websocket') {
      connectBtnText.innerText = '🌐 连接 WebSocket';
      headerBaudGroup.style.display = 'none';
    } else {
      connectBtnText.innerText = '⚡ 启动模拟器';
      headerBaudGroup.style.display = 'none';
    }
  }
  updateConnectButtonLabel();

  // Calculate Data Packets Per Second (Pkt/s) and throttle DOM sidebar updates to 10 FPS
  setInterval(() => {
    packetsPerSec = packetCountAcc;
    packetCountAcc = 0;
    dataRateCounter.innerText = `${packetsPerSec} Pkt/s`;
    fpsCounter.innerText = `${scope.fps} FPS`;
    totalPointsCounter.innerText = scope.totalPoints;

    // Refresh Sidebar Channels & Summary UI at smooth 10 FPS (100ms)
    updateChannelListUI();
    updateSummaryTableUI();
  }, 100);

  // 3. UI Event Handlers
  // Connect / Disconnect Toggle
  btnConnect.addEventListener('click', async () => {
    if (isConnected) {
      await connection.disconnect();
    } else {
      connection.setMode(sourceSelect.value);
      const baudVal = headerBaudInput.value || baudRateInput.value || '3000000';
      connection.setSerialConfig({ baudRate: baudVal });

      if (sourceSelect.value === 'serial') {
        terminal.logSys(`提示：正在打开浏览器 COM 串口选择框 (波特率: ${baudVal})。`);
        terminal.logSys(`💡 提示：列表中的 "USB Serial" 即为您的 COM11 (CH340)，直接选中 "USB Serial" 并点击“连接”即可！`);
      }
      connection.simulator.setProtocolMode(protocolSelect.value);
      await connection.connect();
    }
  });

  // Data Source Select
  sourceSelect.addEventListener('change', () => {
    connection.setMode(sourceSelect.value);
    const simSection = document.getElementById('simConfigSection');
    if (sourceSelect.value === 'simulator') {
      simSection.style.display = 'flex';
    } else {
      simSection.style.display = 'none';
    }
    updateConnectButtonLabel();
  });

  // Protocol Decoder Select
  protocolSelect.addEventListener('change', () => {
    const proto = protocolSelect.value;
    decoder.setMode(proto);
    connection.simulator.setProtocolMode(proto);
    terminal.logSys(`已切换解析协议: ${protocolSelect.options[protocolSelect.selectedIndex].text}`);
  });

  // Baud rate preset dropdown handler
  baudPresetSelect.addEventListener('change', () => {
    baudRateInput.value = baudPresetSelect.value;
    headerBaudInput.value = baudPresetSelect.value;
  });

  headerBaudInput.addEventListener('input', () => {
    baudRateInput.value = headerBaudInput.value;
  });

  baudRateInput.addEventListener('input', () => {
    headerBaudInput.value = baudRateInput.value;
  });

  // Simulator Settings
  simPresetSelect.addEventListener('change', () => {
    connection.simulator.setPreset(simPresetSelect.value);
  });
  simFreqRange.addEventListener('input', () => {
    simFreqVal.innerText = simFreqRange.value;
    connection.simulator.setFrequency(simFreqRange.value);
  });
  simNoiseRange.addEventListener('input', () => {
    simNoiseVal.innerText = simNoiseRange.value;
    connection.simulator.setNoiseLevel(simNoiseRange.value);
  });

  // View Tab Switcher
  const tabBtns = document.querySelectorAll('.tab-btn');
  const viewPanels = document.querySelectorAll('.view-panel');

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetTab = btn.getAttribute('data-tab');

      tabBtns.forEach(b => b.classList.remove('active'));
      viewPanels.forEach(p => p.classList.remove('active'));

      btn.classList.add('active');
      const targetPanel = document.getElementById(`panel-${targetTab}`);
      if (targetPanel) {
        targetPanel.classList.add('active');
        // Trigger resize event for canvas components inside panel
        setTimeout(() => {
          scope.resize();
          if (miniScope) miniScope.resize();
          imuVisualizer.onResize();
          fft.resize();
        }, 50);
      }
    });
  });

  // Dock Tab Switcher
  const dockTabBtns = document.querySelectorAll('.dock-tab-btn');
  const dockPanels = document.querySelectorAll('.dock-panel');

  dockTabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetDock = btn.getAttribute('data-dock');
      dockTabBtns.forEach(b => b.classList.remove('active'));
      dockPanels.forEach(p => p.classList.remove('active'));

      btn.classList.add('active');
      const p = document.getElementById(`dock-${targetDock}`);
      if (p) p.classList.add('active');
    });
  });

  // Dock Collapse Toggle
  const btnToggleDock = document.getElementById('btnToggleDock');
  const workspace = document.querySelector('.workspace');
  let dockCollapsed = false;

  btnToggleDock.addEventListener('click', () => {
    dockCollapsed = !dockCollapsed;
    if (dockCollapsed) {
      workspace.classList.add('dock-collapsed');
      btnToggleDock.innerHTML = '<i class="fa-solid fa-chevron-up"></i>';
    } else {
      workspace.classList.remove('dock-collapsed');
      btnToggleDock.innerHTML = '<i class="fa-solid fa-chevron-down"></i>';
    }
    setTimeout(() => scope.resize(), 300);
  });

  // Scope Controls
  btnPause.addEventListener('click', () => {
    scope.isPaused = !scope.isPaused;
    btnPause.classList.toggle('active', scope.isPaused);
    btnPause.querySelector('span').innerText = scope.isPaused ? '继续' : '暂停';
  });

  btnClear.addEventListener('click', () => {
    scope.clear();
    if (miniScope) miniScope.clear();
    terminal.clear();
  });

  btnExport.addEventListener('click', () => {
    terminal.exportCSV(scope.channels);
  });

  btnZoomIn.addEventListener('click', () => scope.zoomY *= 1.25);
  btnZoomOut.addEventListener('click', () => scope.zoomY /= 1.25);
  btnAutoFit.addEventListener('click', () => {
    scope.zoomY = 1.0;
    scope.updateYLimits();
  });

  btnToggleGrid.addEventListener('click', () => {
    scope.showGrid = !scope.showGrid;
    btnToggleGrid.classList.toggle('active', scope.showGrid);
  });

  btnTogglePoints.addEventListener('click', () => {
    scope.showPoints = !scope.showPoints;
    btnTogglePoints.classList.toggle('active', scope.showPoints);
  });

  btnToggleCursor.addEventListener('click', () => {
    scope.showCursor = !scope.showCursor;
    btnToggleCursor.classList.toggle('active', scope.showCursor);
  });

  bufferSizeSelect.addEventListener('change', () => {
    scope.bufferSize = parseInt(bufferSizeSelect.value);
  });

  // Modal Dialog Listeners
  btnOpenSettings.addEventListener('click', () => settingsModal.classList.add('active'));
  btnCloseModal.addEventListener('click', () => settingsModal.classList.remove('active'));
  btnSaveSettings.addEventListener('click', () => {
    settingsModal.classList.remove('active');
    const baudVal = baudRateInput.value || headerBaudInput.value;
    headerBaudInput.value = baudVal;
    terminal.logSys(`保存通信设置 (波特率: ${baudVal})`);
  });

  // Terminal & Command Output Controls
  chkTerminalHex.addEventListener('change', () => terminal.showHex = chkTerminalHex.checked);
  chkShowTimestamp.addEventListener('change', () => terminal.showTimestamp = chkShowTimestamp.checked);
  chkAutoScrollTerm.addEventListener('change', () => terminal.autoScroll = chkAutoScrollTerm.checked);
  terminalFilter.addEventListener('input', () => terminal.filterKeyword = terminalFilter.value);
  btnClearTerminal.addEventListener('click', () => terminal.clear());

  // Command Send Function
  const handleSend = async () => {
    let payload = cmdInput.value;
    if (!payload) return;

    const lineEnding = lineEndingSelect.value === 'rn' ? '\r\n' : (lineEndingSelect.value === 'n' ? '\n' : '');
    payload += lineEnding;

    await connection.send(payload);
    terminal.logTx(payload);
  };

  btnSendCmd.addEventListener('click', handleSend);
  cmdInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleSend();
  });

  // Auto Send Repeat Interval
  chkAutoSend.addEventListener('change', () => {
    if (chkAutoSend.checked) {
      const interval = parseInt(autoSendInterval.value) || 1000;
      autoSendTimer = setInterval(handleSend, interval);
      terminal.logSys(`启用自动重发指令 (${interval}ms)`);
    } else {
      if (autoSendTimer) clearInterval(autoSendTimer);
      terminal.logSys('已停止自动重发');
    }
  });

  // Macro Buttons
  const macroBtns = document.querySelectorAll('.btn-macro');
  macroBtns.forEach(btn => {
    btn.addEventListener('click', async () => {
      const cmd = btn.getAttribute('data-cmd');
      await connection.send(cmd);
      terminal.logTx(cmd);
    });
  });

  // PID Slider Controls
  const cmdSliders = document.querySelectorAll('.cmd-slider');
  cmdSliders.forEach(slider => {
    slider.addEventListener('input', async () => {
      const prefix = slider.getAttribute('data-prefix');
      const val = slider.value;
      
      if (prefix === 'SET_KP:') document.getElementById('valKp').innerText = val;
      if (prefix === 'SET_KI:') document.getElementById('valKi').innerText = val;
      if (prefix === 'SET_KD:') document.getElementById('valKd').innerText = val;

      const payload = `${prefix}${val}\r\n`;
      await connection.send(payload);
      terminal.logTx(payload);
    });
  });

  // 3D IMU Model Switcher & Reset
  const imuModelSelect = document.getElementById('imuModelSelect');
  const btnResetIMU = document.getElementById('btnResetIMU');

  if (imuModelSelect) {
    imuModelSelect.addEventListener('change', () => imuVisualizer.setModelType(imuModelSelect.value));
  }
  if (btnResetIMU) {
    btnResetIMU.addEventListener('click', () => imuVisualizer.resetView());
  }

  // 4. Helper UI Rendering Functions
  function updateChannelListUI() {
    const chNames = Object.keys(scope.channels);
    const fftSelect = document.getElementById('fftChannelSelect');

    // Populate FFT dropdown if changed
    if (fftSelect.children.length !== chNames.length) {
      fftSelect.innerHTML = '';
      chNames.forEach(name => {
        const opt = document.createElement('option');
        opt.value = name;
        opt.innerText = name;
        fftSelect.appendChild(opt);
      });
    }

    chNames.forEach(name => {
      const ch = scope.channels[name];
      let item = document.getElementById(`ch-item-${name}`);

      if (!item) {
        item = document.createElement('div');
        item.className = 'channel-item';
        item.id = `ch-item-${name}`;
        channelList.appendChild(item);
      }

      const recentPoint = ch.data.length > 0 ? ch.data[ch.data.length - 1].y : 0;

      item.innerHTML = `
        <div class="channel-main">
          <div class="channel-info">
            <span class="channel-color-badge" style="background-color:${ch.color}"></span>
            <span class="channel-name">${ch.name}</span>
          </div>
          <span class="channel-value">${recentPoint.toFixed(2)}</span>
        </div>
        <div class="channel-sub">
          <label><input type="checkbox" ${ch.visible ? 'checked' : ''} class="ch-vis-chk"> 显示</label>
          <span>Scale: ${ch.scale}x</span>
        </div>
      `;

      item.querySelector('.ch-vis-chk').addEventListener('change', (e) => {
        ch.visible = e.target.checked;
      });
    });
  }

  function updateSummaryTableUI() {
    if (!channelSummaryTable) return;
    let html = '';

    for (const [name, ch] of Object.entries(scope.channels)) {
      if (!ch.visible) continue;
      const stats = scope.getChannelStats(name);
      html += `
        <div class="summary-item">
          <span style="color:${ch.color};font-weight:bold;">■ ${name}:</span>
          <span>Min: ${stats.min.toFixed(2)}</span>
          <span>Max: ${stats.max.toFixed(2)}</span>
          <span>Vpp: ${stats.vpp.toFixed(2)}</span>
          <span>RMS: ${stats.rms.toFixed(2)}</span>
        </div>
      `;
    }
    channelSummaryTable.innerHTML = html;
  }

  function updateIMUHud(roll, pitch, yaw) {
    const hudRoll = document.getElementById('hudRoll');
    const hudPitch = document.getElementById('hudPitch');
    const hudYaw = document.getElementById('hudYaw');

    if (hudRoll) hudRoll.innerText = `${parseFloat(roll).toFixed(2)}°`;
    if (hudPitch) hudPitch.innerText = `${parseFloat(pitch).toFixed(2)}°`;
    if (hudYaw) hudYaw.innerText = `${parseFloat(yaw).toFixed(2)}°`;

    const barPitch = document.getElementById('barPitch');
    const barRoll = document.getElementById('barRoll');
    const barYaw = document.getElementById('barYaw');

    if (barPitch) barPitch.style.width = `${Math.min(100, Math.max(0, (parseFloat(pitch) + 90) / 1.8))}%`;
    if (barRoll) barRoll.style.width = `${Math.min(100, Math.max(0, (parseFloat(roll) + 180) / 3.6))}%`;
    if (barYaw) barYaw.style.width = `${Math.min(100, Math.max(0, (parseFloat(yaw) + 180) / 3.6))}%`;
  }
});
