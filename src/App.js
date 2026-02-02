import { useState, useRef, useCallback, useEffect } from 'react';
import './App.css';

// BLE Service and Characteristic UUIDs
const BLE_SERVICE_UUID = 0xFFE0;
const BLE_CHARACTERISTIC_UUID = 0xFFE1;

function App() {
  // BLE State
  const [isConnected, setIsConnected] = useState(false);
  const [deviceName, setDeviceName] = useState('');
  const [logs, setLogs] = useState([]);
  const [inputMessage, setInputMessage] = useState('');
  
  // Accelerometer State
  const [operatingSystem, setOperatingSystem] = useState('');
  const [accelEnabled, setAccelEnabled] = useState(false);
  const [servoAngle, setServoAngle] = useState(90);
  
  // Motor State
  const [motorSpeed, setMotorSpeed] = useState(0);
  
  // Refs for BLE
  const deviceCacheRef = useRef(null);
  const characteristicCacheRef = useRef(null);
  const intervalRef = useRef(null);
  const readBufferRef = useRef('');
  
  // Refs for current values (to avoid stale closures in interval)
  const servoAngleRef = useRef(90);
  const motorSpeedRef = useRef(0);

  // Detect OS on mount
  useEffect(() => {
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
      setOperatingSystem('iOS');
    } else if (window.DeviceMotionEvent !== undefined) {
      setOperatingSystem('Android');
    } else {
      setOperatingSystem('other');
    }
  }, []);

  // Keep refs in sync with state
  useEffect(() => {
    servoAngleRef.current = servoAngle;
  }, [servoAngle]);

  useEffect(() => {
    motorSpeedRef.current = motorSpeed;
  }, [motorSpeed]);

  // Logging function
  const log = useCallback((message, type = '') => {
    setLogs(prev => [...prev, { message, type, id: Date.now() + Math.random() }]);
  }, []);

  // Write to BLE characteristic
  const writeToCharacteristic = useCallback((characteristic, data) => {
    characteristic.writeValue(new TextEncoder().encode(data));
  }, []);

  // Send data via BLE
  const send = useCallback((data, logging = true) => {
    data = String(data);
    
    if (!data || !characteristicCacheRef.current) {
      return;
    }
    
    data += '\n';
    
    if (data.length > 20) {
      const chunks = data.match(/(.|[\r\n]){1,20}/g);
      
      writeToCharacteristic(characteristicCacheRef.current, chunks[0]);
      
      for (let i = 1; i < chunks.length; i++) {
        setTimeout(() => {
          writeToCharacteristic(characteristicCacheRef.current, chunks[i]);
        }, i * 100);
      }
    } else {
      writeToCharacteristic(characteristicCacheRef.current, data);
    }
    
    if (logging) {
      log(data, 'out');
    }
  }, [writeToCharacteristic, log]);

  // Send BLE info periodically
  const sendingBLEinfo = useCallback(() => {
    send(servoAngleRef.current + ";" + motorSpeedRef.current, true);
  }, [send]);

  // Handle received data
  const receive = useCallback((data) => {
    log(data, 'in');
  }, [log]);

  // Handle characteristic value changed
  const handleCharacteristicValueChanged = useCallback((event) => {
    const value = new TextDecoder().decode(event.target.value);
    
    for (const c of value) {
      if (c === '\n') {
        const data = readBufferRef.current.trim();
        readBufferRef.current = '';
        
        if (data) {
          receive(data);
        }
      } else {
        readBufferRef.current += c;
      }
    }
  }, [receive]);

  // Start notifications
  const startNotifications = useCallback((characteristic) => {
    log('Starting notifications...');
    
    return characteristic.startNotifications().then(() => {
      log('Notifications started');
      characteristic.addEventListener('characteristicvaluechanged', handleCharacteristicValueChanged);
    });
  }, [log, handleCharacteristicValueChanged]);

  // Connect to device and cache characteristic
  const connectDeviceAndCacheCharacteristic = useCallback((device) => {
    if (device.gatt.connected && characteristicCacheRef.current) {
      return Promise.resolve(characteristicCacheRef.current);
    }
    
    log('Connecting to GATT server...');
    
    return device.gatt.connect()
      .then(server => {
        log('GATT server connected, getting service...');
        return server.getPrimaryService(BLE_SERVICE_UUID);
      })
      .then(service => {
        log('Service found, getting characteristic...');
        return service.getCharacteristic(BLE_CHARACTERISTIC_UUID);
      })
      .then(characteristic => {
        log('Characteristic found');
        characteristicCacheRef.current = characteristic;
        return characteristicCacheRef.current;
      });
  }, [log]);

  // Handle disconnection
  const handleDisconnection = useCallback((event) => {
    const device = event.target;
    
    log('"' + device.name + '" bluetooth device disconnected, trying to reconnect...');
    
    connectDeviceAndCacheCharacteristic(device)
      .then(characteristic => startNotifications(characteristic))
      .catch(error => log(error.toString()));
  }, [log, connectDeviceAndCacheCharacteristic, startNotifications]);

  // Request Bluetooth device
  const requestBluetoothDevice = useCallback(() => {
    log('Requesting bluetooth device...');
    
    return navigator.bluetooth.requestDevice({
      filters: [{ services: [BLE_SERVICE_UUID] }],
    }).then(device => {
      log('"' + device.name + '" bluetooth device selected');
      deviceCacheRef.current = device;
      setDeviceName(device.name);
      
      deviceCacheRef.current.addEventListener('gattserverdisconnected', handleDisconnection);
      
      return deviceCacheRef.current;
    });
  }, [log, handleDisconnection]);

  // Connect to BLE device
  const connect = useCallback(() => {
    return (deviceCacheRef.current ? Promise.resolve(deviceCacheRef.current) : requestBluetoothDevice())
      .then(device => connectDeviceAndCacheCharacteristic(device))
      .then(characteristic => startNotifications(characteristic))
      .then(() => {
        setIsConnected(true);
        intervalRef.current = setInterval(sendingBLEinfo, 100);
      })
      .catch(error => log(error.toString()));
  }, [requestBluetoothDevice, connectDeviceAndCacheCharacteristic, startNotifications, sendingBLEinfo, log]);

  // Disconnect from BLE device
  const disconnect = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    
    if (deviceCacheRef.current) {
      log('Disconnecting from "' + deviceCacheRef.current.name + '" bluetooth device...');
      deviceCacheRef.current.removeEventListener('gattserverdisconnected', handleDisconnection);
      
      if (deviceCacheRef.current.gatt.connected) {
        deviceCacheRef.current.gatt.disconnect();
        log('"' + deviceCacheRef.current.name + '" bluetooth device disconnected');
      } else {
        log('"' + deviceCacheRef.current.name + '" bluetooth device is already disconnected');
      }
    }
    
    if (characteristicCacheRef.current) {
      characteristicCacheRef.current.removeEventListener('characteristicvaluechanged', handleCharacteristicValueChanged);
      characteristicCacheRef.current = null;
    }
    
    deviceCacheRef.current = null;
    setIsConnected(false);
    setDeviceName('');
  }, [log, handleDisconnection, handleCharacteristicValueChanged]);

  // Handle device orientation for servo control
  const handleDeviceOrientation = useCallback((event) => {
    const gamma = event.gamma; // Left-right tilt (-90 to 90)
    
    // Map gamma (-90 to 90) to servo angle (0 to 180)
    let angle = Math.round(gamma + 90);
    angle = Math.max(0, Math.min(180, angle));
    
    setServoAngle(angle);
  }, []);

  // Get accelerometer permissions and start
  const getAccel = useCallback(() => {
    if (operatingSystem === 'iOS') {
      DeviceMotionEvent.requestPermission().then(response => {
        if (response === 'granted') {
          setAccelEnabled(true);
          window.addEventListener('deviceorientation', handleDeviceOrientation);
        }
      });
    } else if (operatingSystem === 'Android') {
      setAccelEnabled(true);
      window.addEventListener('deviceorientation', handleDeviceOrientation);
    }
  }, [operatingSystem, handleDeviceOrientation]);

  // Handle form submit
  const handleSendSubmit = (e) => {
    e.preventDefault();
    send(inputMessage);
    setInputMessage('');
  };

  // Get accelerometer button text
  const getAccelButtonText = () => {
    if (operatingSystem === 'iOS') {
      return 'Get Accelerometer Permissions (iOS: use Bluefy)';
    } else if (operatingSystem === 'Android') {
      return 'Use Accelerometer (Android: use Google Chrome)';
    } else {
      return 'Use Accelerometer (Not supported on your device)';
    }
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, []);

  return (
    <div className="App">
      <header className="App-header">
        <h1>🏎️ Kart Controller</h1>
        <p className="subtitle">BLE Remote Control with Accelerometer</p>
      </header>

      <main className="App-main">
        {/* Connection Section */}
        <section className="section connection-section">
          <h2>Bluetooth Connection</h2>
          <div className="button-group">
            <button 
              className="btn btn-connect" 
              onClick={connect}
              disabled={isConnected}
            >
              Connect
            </button>
            <button 
              className="btn btn-disconnect" 
              onClick={disconnect}
              disabled={!isConnected}
            >
              Disconnect
            </button>
          </div>
          <div className="connection-status">
            <span className={`status-indicator ${isConnected ? 'connected' : ''}`}></span>
            {isConnected ? `Connected to ${deviceName}` : 'Device not connected'}
          </div>
        </section>

        {/* Accelerometer Section */}
        <section className="section accelerometer-section">
          <h2>Accelerometer Control</h2>
          <button 
            className="btn btn-accel"
            onClick={getAccel}
            disabled={operatingSystem === 'other' || accelEnabled}
          >
            {accelEnabled ? '✓ Accelerometer Active' : getAccelButtonText()}
          </button>
          
          <div className="instructions">
            <p>📱 iOS: Use <strong>Bluefy</strong> browser</p>
            <p>🤖 Android: Use <strong>Google Chrome</strong></p>
          </div>
        </section>

        {/* Speedometer / Servo Angle Display */}
        <section className="section speedometer-section">
          <h2>Servo Angle</h2>
          <div id="logo">
            <div className="speedometer">
              <div className="speed-marks">
                <span className="mark mark-0">0°</span>
                <span className="mark mark-90">90°</span>
                <span className="mark mark-180">180°</span>
              </div>
            </div>
            <div 
              className="needle" 
              style={{ 
                transform: `rotate(${servoAngle - 90}deg)`,
                background: accelEnabled ? '#ff4444' : '#999999'
              }}
            ></div>
          </div>
          <p className="angle-display">Angle: <strong>{servoAngle}°</strong></p>
        </section>

        {/* Motor Speed Control */}
        <section className="section motor-section">
          <h2>Motor Speed</h2>
          <div className="motor-control">
            <input 
              type="range" 
              min="0" 
              max="255" 
              value={motorSpeed}
              onChange={(e) => setMotorSpeed(parseInt(e.target.value))}
              className="speed-slider"
            />
            <p className="speed-display">Speed: <strong>{motorSpeed}</strong> / 255</p>
          </div>
          <div className="speed-buttons">
            <button className="btn btn-speed" onClick={() => setMotorSpeed(0)}>Stop</button>
            <button className="btn btn-speed" onClick={() => setMotorSpeed(64)}>25%</button>
            <button className="btn btn-speed" onClick={() => setMotorSpeed(128)}>50%</button>
            <button className="btn btn-speed" onClick={() => setMotorSpeed(192)}>75%</button>
            <button className="btn btn-speed" onClick={() => setMotorSpeed(255)}>100%</button>
          </div>
        </section>

        {/* Terminal Section */}
        <section className="section terminal-section">
          <h2>Terminal</h2>
          <div id="terminal">
            {logs.map(log => (
              <div key={log.id} className={log.type}>
                {log.message}
              </div>
            ))}
          </div>
          
          <form id="send-form" onSubmit={handleSendSubmit}>
            <input 
              type="text"
              id="input"
              value={inputMessage}
              onChange={(e) => setInputMessage(e.target.value)}
              placeholder="Type a message..."
            />
            <button type="submit" className="btn btn-send">Send</button>
          </form>
        </section>
      </main>

      <footer className="App-footer">
        <p>Tilt your phone left/right to control the servo • Slide to control motor speed</p>
      </footer>
    </div>
  );
}

export default App;
