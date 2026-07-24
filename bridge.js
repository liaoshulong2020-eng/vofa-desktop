/**
 * Local Node.js Serial to WebSocket Bridge (可选的本地串口 WebSocket 桥接服务)
 * Allows selecting explicit COM port names like COM11 and forwarding 3M baud rate data to Web VOFA+
 * 
 * Usage:
 *   node bridge.js COM11 3000000
 */
const { SerialPort } = require('serialport');
const { WebSocketServer } = require('ws');

const portName = process.argv[2] || 'COM11';
const baudRate = parseInt(process.argv[3]) || 3000000;
const wsPort = 8080;

console.log(`====================================================`);
console.log(` VOFA+ Web 本地串口 ↔ WebSocket 桥接服务`);
console.log(` 目标串口: ${portName}`);
console.log(` 波特率:   ${baudRate} bps`);
console.log(` WebSocket服务端口: ws://localhost:${wsPort}`);
console.log(`====================================================`);

// List all available COM ports
SerialPort.list().then(ports => {
  console.log('\n当前系统已检测到的所有 COM 串口列表:');
  ports.forEach(p => {
    console.log(`  - ${p.path} \t(${p.friendlyName || p.manufacturer || 'USB Serial'})`);
  });
  console.log('\n');

  startBridge();
}).catch(err => {
  console.error('无法枚举串口:', err);
  startBridge();
});

function startBridge() {
  const wss = new WebSocketServer({ port: wsPort });
  let serial = null;

  try {
    serial = new SerialPort({
      path: portName,
      baudRate: baudRate,
      autoOpen: true
    });

    serial.on('open', () => {
      console.log(`[成功] 串口 ${portName} 已打开 (${baudRate} bps)`);
    });

    serial.on('data', (chunk) => {
      wss.clients.forEach(client => {
        if (client.readyState === 1) { // OPEN
          client.send(chunk);
        }
      });
    });

    serial.on('error', (err) => {
      console.error(`[串口错误]: ${err.message}`);
    });
  } catch (e) {
    console.error(`无法打开串口 ${portName}:`, e.message);
  }

  wss.on('connection', (ws) => {
    console.log('[WebSocket] 网页客户端已连接');
    
    ws.on('message', (msg) => {
      if (serial && serial.isOpen) {
        serial.write(msg);
      }
    });

    ws.on('close', () => {
      console.log('[WebSocket] 网页客户端已断开');
    });
  });
}
