import { useState, useRef, useCallback, useEffect } from 'react';
import './App.css';

// BLE Service and Characteristic UUIDs
const BLE_SERVICE_UUID = 0xFFA0;
const BLE_CHARACTERISTIC_UUID = 0xFFE1;

function App() {
  // Control Mode: null = selection screen, 'buttons' or 'controller'
  const [controlMode, setControlMode] = useState(null);
  const [gamepadConnected, setGamepadConnected] = useState(false);
  
  // BLE State
  const [isConnected, setIsConnected] = useState(false);
  const [logs, setLogs] = useState([]);
  
  // Servo & Motor State (steering: -90 to +90, center is 0)
  const [steering, setSteering] = useState(0);
  const [motorSpeed, setMotorSpeed] = useState(0);
  const [direction, setDirection] = useState(1); // 1 = forward, -1 = backward
  
  // Refs for BLE
  const deviceCacheRef = useRef(null);
  const characteristicCacheRef = useRef(null);
  const intervalRef = useRef(null);
  const readBufferRef = useRef('');
  
  // Refs for current values
  const steeringRef = useRef(0);
  const motorSpeedRef = useRef(0);
  const directionRef = useRef(1);
  
  // Refs for steering (button mode)
  const steeringIntervalRef = useRef(null);
  const steeringDirectionRef = useRef(null);
  const lastSteeringTimeRef = useRef(0);
  
  // Refs for gamepad
  const gamepadLoopRef = useRef(null);
  const smoothedSteeringRef = useRef(0);
  const lastGamepadTimeRef = useRef(0);

  useEffect(() => {
    steeringRef.current = steering;
  }, [steering]);

  useEffect(() => {
    motorSpeedRef.current = motorSpeed;
  }, [motorSpeed]);

  useEffect(() => {
    directionRef.current = direction;
  }, [direction]);

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
  // Format: angle;speed;direction
  const sendingBLEinfo = useCallback(() => {
    const servoAngle = steeringRef.current + 90;
    send(servoAngle + ";" + motorSpeedRef.current + ";" + directionRef.current, false);
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
    setSteering(0);
    setMotorSpeed(0);
    setDirection(1);
    log('⚠️ Safety: Wheels straight, speed 0');
    
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

  const resetToSafeState = useCallback(() => {
    setSteering(0);
    setMotorSpeed(0);
    setDirection(1);
    log('⚠️ Safety: Reset to safe state');
  }, [log]);

  const disconnect = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    
    if (characteristicCacheRef.current && deviceCacheRef.current?.gatt?.connected) {
      try {
        const safeData = '90;0;1\n';
        characteristicCacheRef.current.writeValue(new TextEncoder().encode(safeData));
        log('⚠️ Sent safe state before disconnect');
      } catch (e) {}
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
    resetToSafeState();
  }, [log, handleDisconnection, handleCharacteristicValueChanged, resetToSafeState]);

  // ============ BUTTON MODE STEERING ============
  const animateSteering = useCallback((timestamp) => {
    if (!steeringDirectionRef.current) return;
    
    const elapsed = timestamp - lastSteeringTimeRef.current;
    if (elapsed >= 16) {
      lastSteeringTimeRef.current = timestamp;
      const step = 4;
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
    if (e) { e.preventDefault(); e.stopPropagation(); }
    if (steeringIntervalRef.current) cancelAnimationFrame(steeringIntervalRef.current);
    steeringDirectionRef.current = direction;
    lastSteeringTimeRef.current = performance.now();
    setSteering(prev => direction === 'left' ? Math.max(-90, prev - 4) : Math.min(90, prev + 4));
    steeringIntervalRef.current = requestAnimationFrame(animateSteering);
  };

  const stopSteering = (e) => {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    steeringDirectionRef.current = null;
    if (steeringIntervalRef.current) {
      cancelAnimationFrame(steeringIntervalRef.current);
      steeringIntervalRef.current = null;
    }
  };

  const resetSteering = () => setSteering(0);

  // ============ GAMEPAD / CONTROLLER MODE ============
  const gamepadLoop = useCallback((timestamp) => {
    // Time-based smoothing
    const deltaTime = timestamp - lastGamepadTimeRef.current;
    lastGamepadTimeRef.current = timestamp;
    
    const gamepads = navigator.getGamepads();
    const gp = gamepads[0] || gamepads[1] || gamepads[2] || gamepads[3];
    
    if (gp) {
      if (!gamepadConnected) setGamepadConnected(true);
      
      // Left stick X-axis for steering (axis 0)
      // Value is -1 (left) to 1 (right)
      const stickX = gp.axes[0];
      // Apply deadzone
      const deadzone = 0.1;
      let targetSteering = 0;
      if (Math.abs(stickX) > deadzone) {
        targetSteering = stickX * 90;
      }
      
      // Time-based smooth interpolation
      // smoothSpeed = how many degrees per second to change (higher = faster response)
      const smoothSpeed = 300; // degrees per second
      const maxChange = (smoothSpeed * deltaTime) / 1000;
      const diff = targetSteering - smoothedSteeringRef.current;
      
      if (Math.abs(diff) <= maxChange) {
        smoothedSteeringRef.current = targetSteering;
      } else {
        smoothedSteeringRef.current += Math.sign(diff) * maxChange;
      }
      
      setSteering(Math.round(smoothedSteeringRef.current));
      
      // R2 for forward, L2 for backward
      // PS5: R2 = button 7, L2 = button 6
      let r2Value = 0;
      let l2Value = 0;
      
      // R2 (forward) - button 7
      if (gp.buttons[7] && gp.buttons[7].value > 0) {
        r2Value = Math.round(gp.buttons[7].value * 100);
      }
      // L2 (backward) - button 6
      if (gp.buttons[6] && gp.buttons[6].value > 0) {
        l2Value = Math.round(gp.buttons[6].value * 100);
      }
      
      // R2 = forward (1), L2 = backward (-1)
      if (r2Value > l2Value) {
        setMotorSpeed(r2Value);
        setDirection(1);
      } else if (l2Value > r2Value) {
        setMotorSpeed(l2Value);
        setDirection(-1);
      } else {
        setMotorSpeed(0);
      }
    } else {
      if (gamepadConnected) setGamepadConnected(false);
    }
    
    gamepadLoopRef.current = requestAnimationFrame(gamepadLoop);
  }, [gamepadConnected]);

  // Start/stop gamepad loop based on control mode
  useEffect(() => {
    if (controlMode === 'controller') {
      lastGamepadTimeRef.current = performance.now();
      gamepadLoopRef.current = requestAnimationFrame(gamepadLoop);
      log('🎮 Controller mode active');
    }
    
    return () => {
      if (gamepadLoopRef.current) {
        cancelAnimationFrame(gamepadLoopRef.current);
      }
    };
  }, [controlMode, gamepadLoop, log]);

  // Gamepad connect/disconnect events
  useEffect(() => {
    const handleGamepadConnected = (e) => {
      log('🎮 Controller connected: ' + e.gamepad.id);
      setGamepadConnected(true);
    };
    
    const handleGamepadDisconnected = () => {
      log('🎮 Controller disconnected');
      setGamepadConnected(false);
      // Safety: reset when controller disconnects
      setSteering(0);
      setMotorSpeed(0);
      setDirection(1);
    };
    
    window.addEventListener('gamepadconnected', handleGamepadConnected);
    window.addEventListener('gamepaddisconnected', handleGamepadDisconnected);
    
    return () => {
      window.removeEventListener('gamepadconnected', handleGamepadConnected);
      window.removeEventListener('gamepaddisconnected', handleGamepadDisconnected);
    };
  }, [log]);

  // Cleanup
  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (steeringIntervalRef.current) cancelAnimationFrame(steeringIntervalRef.current);
      if (gamepadLoopRef.current) cancelAnimationFrame(gamepadLoopRef.current);
    };
  }, []);

  const steeringDisplay = steering > 0 ? `+${steering}` : steering.toString();

  // ============ SELECTION SCREEN ============
  if (controlMode === null) {
    return (
      <div className="selection-screen">
        <h1>🏎️ KART CONTROLLER</h1>
        <p>Choose your control method:</p>
        <div className="selection-buttons">
          <button className="select-btn buttons" onClick={() => setControlMode('buttons')}>
            <span className="select-icon">📱</span>
            <span className="select-text">TOUCH BUTTONS</span>
            <span className="select-desc">Use on-screen arrows</span>
          </button>
          <button className="select-btn controller" onClick={() => setControlMode('controller')}>
            <span className="select-icon">🎮</span>
            <span className="select-text">PS5 CONTROLLER</span>
            <span className="select-desc">Stick + R2 fwd / L2 rev</span>
          </button>
        </div>
      </div>
    );
  }

  // ============ CONTROLLER MODE UI ============
  if (controlMode === 'controller') {
    return (
      <div className="controller gamepad-mode">
        <div className="header">
          <button className="back-btn" onClick={() => setControlMode(null)}>← Back</button>
          <span className="title">🎮 CONTROLLER</span>
          <button 
            className={`connect-btn ${isConnected ? 'connected' : ''}`}
            onClick={isConnected ? disconnect : connect}
          >
            {isConnected ? '● ON' : '○ OFF'}
          </button>
        </div>

        <div className="gamepad-display">
          <div className="gamepad-status">
            {gamepadConnected ? (
              <span className="gp-connected">🎮 Controller Connected</span>
            ) : (
              <span className="gp-disconnected">🎮 Press any button on controller...</span>
            )}
          </div>
          
          <div className="gamepad-values">
            <div className="gp-value">
              <span className="gp-label">STEERING</span>
              <span className="gp-num">{steeringDisplay}</span>
            </div>
            <div className="gp-value">
              <span className="gp-label">{direction === 1 ? 'FWD (R2)' : 'REV (L2)'}</span>
              <span className={`gp-num speed ${direction === -1 ? 'reverse' : ''}`}>{motorSpeed}%</span>
            </div>
          </div>
          
          <div className="steering-bar">
            <span className="bar-label">-90</span>
            <div className="bar-track">
              <div className="steering-indicator" style={{ left: `${((steering + 90) / 180) * 100}%` }}></div>
            </div>
            <span className="bar-label">+90</span>
          </div>
          
          <div className="speed-bar">
            <div className="speed-bar-fill" style={{ width: `${motorSpeed}%` }}></div>
          </div>
        </div>

        <div className="terminal">
          {logs.slice(-4).map(l => (
            <div key={l.id} className={l.type}>{l.message}</div>
          ))}
        </div>
      </div>
    );
  }

  // ============ BUTTON MODE UI ============
  return (
    <div className="controller">
      <div className="header">
        <button className="back-btn" onClick={() => setControlMode(null)}>← Back</button>
        <span className="title">🏎️ KART</span>
        <button 
          className={`connect-btn ${isConnected ? 'connected' : ''}`}
          onClick={isConnected ? disconnect : connect}
        >
          {isConnected ? '● ON' : '○ OFF'}
        </button>
      </div>

      <div className="main-controls">
        <button 
          className="arrow-btn left"
          onTouchStart={(e) => startSteering('left', e)}
          onTouchEnd={stopSteering}
          onTouchCancel={stopSteering}
          onMouseDown={(e) => startSteering('left', e)}
          onMouseUp={stopSteering}
          onMouseLeave={stopSteering}
          onContextMenu={(e) => e.preventDefault()}
        >
          ◀
        </button>

        <div className="center-panel">
          <div className="speed-section">
            <div className="slider-container">
              <input 
                type="range" min="0" max="100" value={motorSpeed}
                onChange={(e) => setMotorSpeed(parseInt(e.target.value))}
                className="slider"
              />
              <div className="slider-bg">
                <div className="slider-fill" style={{ height: `${motorSpeed}%` }}></div>
              </div>
            </div>
            <div className="speed-info">
              <span className="speed-num">{motorSpeed}%</span>
              <button 
                className={`dir-btn ${direction === -1 ? 'reverse' : ''}`} 
                onClick={() => setDirection(d => d === 1 ? -1 : 1)}
              >
                {direction === 1 ? '⬆ FWD' : '⬇ REV'}
              </button>
              <button className="stop-btn" onClick={() => setMotorSpeed(0)}>STOP</button>
            </div>
          </div>
          
          <div className="steering-info">
            <div className="steering-value">{steeringDisplay}</div>
            <button className="reset-btn" onClick={resetSteering}>↺ 0</button>
          </div>
        </div>

        <button 
          className="arrow-btn right"
          onTouchStart={(e) => startSteering('right', e)}
          onTouchEnd={stopSteering}
          onTouchCancel={stopSteering}
          onMouseDown={(e) => startSteering('right', e)}
          onMouseUp={stopSteering}
          onMouseLeave={stopSteering}
          onContextMenu={(e) => e.preventDefault()}
        >
          ▶
        </button>
      </div>

      <div className="steering-bar">
        <span className="bar-label left">-90</span>
        <div className="bar-track">
          <div className="steering-indicator" style={{ left: `${((steering + 90) / 180) * 100}%` }}></div>
        </div>
        <span className="bar-label right">+90</span>
      </div>

      <div className="terminal">
        {logs.slice(-3).map(l => (
          <div key={l.id} className={l.type}>{l.message}</div>
        ))}
      </div>
    </div>
  );
}

export default App;
