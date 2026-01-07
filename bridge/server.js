import mqtt from 'mqtt';
import { WebSocketServer } from 'ws';

const MQTT_URL = 'mqtt://captain.dev0.pandor.cloud:1884';
const WS_PORT = 8080;

// Connect to MQTT broker
const mqttClient = mqtt.connect(MQTT_URL);

mqttClient.on('connect', () => {
  console.log('✅ MQTT connected to', MQTT_URL);
  mqttClient.subscribe('classroom/+/telemetry', (err) => {
    if (err) {
      console.error('❌ Error subscribing to telemetry:', err);
    } else {
      console.log('📡 Subscribed to classroom/+/telemetry');
    }
  });
  mqttClient.subscribe('flipper/+/+', (err) => {
    if (err) {
      console.error('❌ Error subscribing to flipper:', err);
    } else {
      console.log('🎯 Subscribed to flipper/+/+');
    }
  });
});

mqttClient.on('error', (err) => {
  console.error('❌ MQTT error:', err);
});

// Create WebSocket server
const wss = new WebSocketServer({ port: WS_PORT });

wss.on('connection', (ws) => {
  console.log('🔌 WebSocket client connected');
  ws.send(JSON.stringify({ type: 'info', message: 'connected to bridge' }));

  ws.on('close', () => {
    console.log('🔌 WebSocket client disconnected');
  });
});

console.log(`🛰️ WebSocket server listening on ws://localhost:${WS_PORT}`);

// Forward MQTT messages to all WebSocket clients (sans log spam)
mqttClient.on('message', (topic, payload) => {
  const msg = payload.toString();
  const data = { topic, payload: msg };

  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(JSON.stringify(data));
    }
  });
});

