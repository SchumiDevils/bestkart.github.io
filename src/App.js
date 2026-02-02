import { useState, useRef, useCallback, useEffect } from 'react';
import './App.css';

// BLE Service and Characteristic UUIDs
const BLE_SERVICE_UUID = 0xFFA0;
const BLE_CHARACTERISTIC_UUID = 0xFFE1;

function App() {
  // BLE State
  const [isConnected, setIsConnected] = useState(false);
  const [logs, setLogs] = useState([]);
  
  // Servo & Motor State
  const [servoAngle, setServoAngle] = useState(90);
  const [motorSpeed, setMotorSpeed] = useState(0);
  
  // Refs for BLE
  const deviceCacheRef = useRef(null);
  const characteristicCacheRef = useRef(null);
  const intervalRef = useRef(null);
  const readBufferRef = useRef('');
  
  // Refs for current values
  const servoAngleRef = useRef(90);
  const motorSpeedRef = useRef(0);
  
  // Refs for steering
  const steeringIntervalRef = useRef(null);

  useEffect(() => {
    servoAngleRef.current = servoAngle;
  }, [servoAngle]);

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

  const sendingBLEinfo = useCallback(() => {
    send(servoAngleRef.current + ";" + motorSpeedRef.current, false);
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
    log('Reconnecting...');
    connectDeviceAndCacheCharacteristic(event.target)
      .then(characteristic => startNotifications(characteristic))
      .catch(error => log(error.toString()));
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

  const disconnect = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
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
  }, [log, handleDisconnection, handleCharacteristicValueChanged]);

  // STEERING with arrow buttons - press and hold (5 degrees, smoother delay)
  const startSteering = (direction) => {
    // Move immediately once
    setServoAngle(prev => {
      const newAngle = direction === 'left' 
        ? Math.max(0, prev - 5) 
        : Math.min(180, prev + 5);
      return newAngle;
    });
    
    // Then continue moving while held (5 degrees every 100ms for smoother steering)
    steeringIntervalRef.current = setInterval(() => {
      setServoAngle(prev => {
        const newAngle = direction === 'left' 
          ? Math.max(0, prev - 5) 
          : Math.min(180, prev + 5);
        return newAngle;
      });
    }, 100); // 100ms delay for smoother movement
  };

  const stopSteering = () => {
    if (steeringIntervalRef.current) {
      clearInterval(steeringIntervalRef.current);
      steeringIntervalRef.current = null;
    }
  };

  const centerSteering = () => {
    setServoAngle(90);
  };

  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (steeringIntervalRef.current) clearInterval(steeringIntervalRef.current);
    };
  }, []);

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
          onTouchStart={() => startSteering('left')}
          onTouchEnd={stopSteering}
          onMouseDown={() => startSteering('left')}
          onMouseUp={stopSteering}
          onMouseLeave={stopSteering}
        >
          ◀
        </button>

        {/* Center - Speed Slider */}
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
          
          <button className="center-btn" onClick={centerSteering}>
            {servoAngle}°
          </button>
        </div>

        {/* Right Arrow */}
        <button 
          className="arrow-btn right"
          onTouchStart={() => startSteering('right')}
          onTouchEnd={stopSteering}
          onMouseDown={() => startSteering('right')}
          onMouseUp={stopSteering}
          onMouseLeave={stopSteering}
        >
          ▶
        </button>
      </div>

      {/* Steering Bar */}
      <div className="steering-bar">
        <div 
          className="steering-indicator" 
          style={{ left: `${(servoAngle / 180) * 100}%` }}
        ></div>
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
