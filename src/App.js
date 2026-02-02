import { useState, useRef, useCallback, useEffect } from 'react';
import './App.css';

// BLE Service and Characteristic UUIDs
const BLE_SERVICE_UUID = 0xFFA0;
const BLE_CHARACTERISTIC_UUID = 0xFFE1;

function App() {
  // BLE State
  const [isConnected, setIsConnected] = useState(false);
  const [logs, setLogs] = useState([]);
  
  // Servo & Motor State (steering: -90 to +90, center is 0)
  const [steering, setSteering] = useState(0);
  const [motorSpeed, setMotorSpeed] = useState(0);
  
  // Refs for BLE
  const deviceCacheRef = useRef(null);
  const characteristicCacheRef = useRef(null);
  const intervalRef = useRef(null);
  const readBufferRef = useRef('');
  
  // Refs for current values
  const steeringRef = useRef(0);
  const motorSpeedRef = useRef(0);
  
  // Refs for steering
  const steeringIntervalRef = useRef(null);
  const steeringDirectionRef = useRef(null);
  const lastSteeringTimeRef = useRef(0);

  useEffect(() => {
    steeringRef.current = steering;
  }, [steering]);

  useEffect(() => {
    motorSpeedRef.current = motorSpeed;
  }, [motorSpeed]);

  const log = useCallback((message, type = '') => {
    setLogs(prev => [...prev, { message, type, id: Date.now() + Math.random() }].slice(-20));
  }, []);

  const writeToCharacteristic = useCallback((characteristic, data) => {
    characteristic.writeValue(new TextEncoder().encode(data));
  }, []);

  const send = useCallback((data, logging = true) => {
    data = String(data);
    if (!data || !characteristicCacheRef.current) return;
    
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
    
    if (logging) log(data, 'out');
  }, [writeToCharacteristic, log]);

  // Convert steering (-90 to +90) to servo angle (0 to 180) for BLE
  const sendingBLEinfo = useCallback(() => {
    // Map: -90 -> 0°, 0 -> 90°, +90 -> 180°
    const servoAngle = steeringRef.current + 90;
    send(servoAngle + ";" + motorSpeedRef.current, false);
  }, [send]);

  const receive = useCallback((data) => {
    log(data, 'in');
  }, [log]);

  const handleCharacteristicValueChanged = useCallback((event) => {
    const value = new TextDecoder().decode(event.target.value);
    for (const c of value) {
      if (c === '\n') {
        const data = readBufferRef.current.trim();
        readBufferRef.current = '';
        if (data) receive(data);
      } else {
        readBufferRef.current += c;
      }
    }
  }, [receive]);

  const startNotifications = useCallback((characteristic) => {
    log('Starting notifications...');
    return characteristic.startNotifications().then(() => {
      log('Notifications started');
      characteristic.addEventListener('characteristicvaluechanged', handleCharacteristicValueChanged);
    });
  }, [log, handleCharacteristicValueChanged]);

  const connectDeviceAndCacheCharacteristic = useCallback((device) => {
    if (device.gatt.connected && characteristicCacheRef.current) {
      return Promise.resolve(characteristicCacheRef.current);
    }
    log('Connecting...');
    return device.gatt.connect()
      .then(server => server.getPrimaryService(BLE_SERVICE_UUID))
      .then(service => service.getCharacteristic(BLE_CHARACTERISTIC_UUID))
      .then(characteristic => {
        log('Connected!');
        characteristicCacheRef.current = characteristic;
        return characteristicCacheRef.current;
      });
  }, [log]);

  const handleDisconnection = useCallback((event) => {
    log('⚠️ Connection lost!');
    
    // SAFETY: Immediately reset UI to safe state when connection lost
    setSteering(0);
    setMotorSpeed(0);
    log('⚠️ Safety: Wheels straight, speed 0');
    
    // Try to reconnect
    log('Reconnecting...');
    connectDeviceAndCacheCharacteristic(event.target)
      .then(characteristic => startNotifications(characteristic))
      .catch(error => {
        log(error.toString());
        setIsConnected(false);
      });
  }, [log, connectDeviceAndCacheCharacteristic, startNotifications]);

  const requestBluetoothDevice = useCallback(() => {
    log('Searching...');
    return navigator.bluetooth.requestDevice({
      filters: [{ services: [BLE_SERVICE_UUID] }],
    }).then(device => {
      log('Found: ' + device.name);
      deviceCacheRef.current = device;
      deviceCacheRef.current.addEventListener('gattserverdisconnected', handleDisconnection);
      return deviceCacheRef.current;
    });
  }, [log, handleDisconnection]);

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

  // SAFETY: Reset to safe state (wheels straight, speed 0)
  const resetToSafeState = useCallback(() => {
    setSteering(0);
    setMotorSpeed(0);
    log('⚠️ Safety: Reset to safe state');
  }, [log]);

  const disconnect = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    
    // SAFETY: Try to send safe state before disconnecting
    if (characteristicCacheRef.current && deviceCacheRef.current?.gatt?.connected) {
      try {
        // Send steering=90 (center) and speed=0
        const safeData = '90;0\n';
        characteristicCacheRef.current.writeValue(new TextEncoder().encode(safeData));
        log('⚠️ Sent safe state before disconnect');
      } catch (e) {
        // Ignore errors, we're disconnecting anyway
      }
    }
    
    if (deviceCacheRef.current) {
      log('Disconnecting...');
      deviceCacheRef.current.removeEventListener('gattserverdisconnected', handleDisconnection);
      if (deviceCacheRef.current.gatt.connected) {
        deviceCacheRef.current.gatt.disconnect();
        log('Disconnected');
      }
    }
    if (characteristicCacheRef.current) {
      characteristicCacheRef.current.removeEventListener('characteristicvaluechanged', handleCharacteristicValueChanged);
      characteristicCacheRef.current = null;
    }
    deviceCacheRef.current = null;
    setIsConnected(false);
    
    // SAFETY: Reset UI to safe state
    resetToSafeState();
  }, [log, handleDisconnection, handleCharacteristicValueChanged, resetToSafeState]);

  // STEERING: -90 to +90, smooth animation
  const animateSteering = useCallback((timestamp) => {
    if (!steeringDirectionRef.current) return;
    
    // Control speed: move ~150 degrees per second
    const elapsed = timestamp - lastSteeringTimeRef.current;
    if (elapsed >= 16) { // ~60fps
      lastSteeringTimeRef.current = timestamp;
      
      const step = 4; // degrees per frame
      setSteering(prev => {
        if (steeringDirectionRef.current === 'left') {
          return Math.max(-90, prev - step);
        } else {
          return Math.min(90, prev + step);
        }
      });
    }
    
    steeringIntervalRef.current = requestAnimationFrame(animateSteering);
  }, []);

  const startSteering = (direction, e) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    
    // Stop any existing animation
    if (steeringIntervalRef.current) {
      cancelAnimationFrame(steeringIntervalRef.current);
    }
    
    steeringDirectionRef.current = direction;
    lastSteeringTimeRef.current = performance.now();
    
    // Immediate first step
    setSteering(prev => {
      if (direction === 'left') {
        return Math.max(-90, prev - 4);
      } else {
        return Math.min(90, prev + 4);
      }
    });
    
    steeringIntervalRef.current = requestAnimationFrame(animateSteering);
  };

  const stopSteering = (e) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    steeringDirectionRef.current = null;
    if (steeringIntervalRef.current) {
      cancelAnimationFrame(steeringIntervalRef.current);
      steeringIntervalRef.current = null;
    }
  };

  const resetSteering = () => {
    setSteering(0);
  };

  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (steeringIntervalRef.current) cancelAnimationFrame(steeringIntervalRef.current);
    };
  }, []);

  // Format steering display
  const steeringDisplay = steering > 0 ? `+${steering}` : steering.toString();

  return (
    <div className="controller">
      {/* Header */}
      <div className="header">
        <span className="title">🏎️ KART</span>
        <button 
          className={`connect-btn ${isConnected ? 'connected' : ''}`}
          onClick={isConnected ? disconnect : connect}
        >
          {isConnected ? '● ON' : '○ OFF'}
        </button>
      </div>

      {/* Main Controls */}
      <div className="main-controls">
        {/* Left Arrow */}
        <button 
          className="arrow-btn left"
          onPointerDown={(e) => startSteering('left', e)}
          onPointerUp={stopSteering}
          onPointerLeave={stopSteering}
          onPointerCancel={stopSteering}
          onContextMenu={(e) => e.preventDefault()}
        >
          ◀
        </button>

        {/* Center - Speed Slider + Reset */}
        <div className="center-panel">
          <div className="speed-section">
            <div className="slider-container">
              <input 
                type="range" 
                min="0" 
                max="100" 
                value={motorSpeed}
                onChange={(e) => setMotorSpeed(parseInt(e.target.value))}
                className="slider"
              />
              <div className="slider-bg">
                <div className="slider-fill" style={{ height: `${motorSpeed}%` }}></div>
              </div>
            </div>
            <div className="speed-info">
              <span className="speed-num">{motorSpeed}%</span>
              <button className="stop-btn" onClick={() => setMotorSpeed(0)}>STOP</button>
            </div>
          </div>
          
          <div className="steering-info">
            <div className="steering-value">{steeringDisplay}</div>
            <button className="reset-btn" onClick={resetSteering}>↺ 0</button>
          </div>
        </div>

        {/* Right Arrow */}
        <button 
          className="arrow-btn right"
          onPointerDown={(e) => startSteering('right', e)}
          onPointerUp={stopSteering}
          onPointerLeave={stopSteering}
          onPointerCancel={stopSteering}
          onContextMenu={(e) => e.preventDefault()}
        >
          ▶
        </button>
      </div>

      {/* Steering Bar */}
      <div className="steering-bar">
        <span className="bar-label left">-90</span>
        <div className="bar-track">
          <div 
            className="steering-indicator" 
            style={{ left: `${((steering + 90) / 180) * 100}%` }}
          ></div>
        </div>
        <span className="bar-label right">+90</span>
      </div>

      {/* Terminal */}
      <div className="terminal">
        {logs.slice(-3).map(l => (
          <div key={l.id} className={l.type}>{l.message}</div>
        ))}
      </div>
    </div>
  );
}

export default App;
