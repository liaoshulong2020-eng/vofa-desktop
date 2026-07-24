/**
 * Direct COM11 Serial Monitor & Diagnostics Script
 */
const { SerialPort } = require('serialport');

const portName = 'COM11';
const baudRate = 3000000;

console.log(`[Diagnostic] Attempting to open ${portName} at ${baudRate} bps...`);

try {
  const port = new SerialPort({
    path: portName,
    baudRate: baudRate,
    autoOpen: true
  });

  port.on('open', () => {
    console.log(`[Success] ${portName} opened successfully at ${baudRate} bps! Waiting for raw data...`);
  });

  let bytesReceived = 0;

  port.on('data', (chunk) => {
    bytesReceived += chunk.length;
    const hex = Array.from(chunk).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
    let ascii = '';
    try {
      ascii = new TextDecoder().decode(chunk);
    } catch (e) {}

    console.log(`[RX ${chunk.length} bytes | Total: ${bytesReceived}]:`);
    console.log(`  HEX:   ${hex}`);
    console.log(`  ASCII: ${JSON.stringify(ascii)}`);
  });

  port.on('error', (err) => {
    console.error(`[Error] ${portName} error:`, err.message);
  });

  setTimeout(() => {
    if (bytesReceived === 0) {
      console.log(`[Warning] No data received after 5 seconds on ${portName} at ${baudRate} bps.`);
    }
  }, 5000);

} catch (err) {
  console.error(`[Exception] Failed to open ${portName}:`, err.message);
}
