<script lang="ts">
  import { onMount } from 'svelte';

  type Telemetry = {
    deviceId: string;
    temperature?: number;
    humidity?: number;
    battery?: number;
    ts?: string;
  };

  type DeviceState = {
    id: string;
    name: string;
    last: Telemetry | null;
  };

  type FlipperEvent = {
    deviceId: string;
    channel?: string;
    button?: string;
    value?: string | number;
    ts?: string;
    raw?: unknown;
  };

  let status = 'connecting...';
  let devices: Record<string, DeviceState> = {};
  let lastRawMessages: { topic: string; payload: string }[] = [];
  let rawEnabled = false;
  let rawTotal = 0;
  let flipperTimeline: FlipperEvent[] = [];
  let flipperCounters: Record<string, number> = {};
  let lastFlipper: FlipperEvent | null = null;

  const DEVICE_LABELS: Record<string, string> = {
    'esp32-01': 'Salle 1',
    'esp32-02': 'Salle 2',
    'esp32-03': 'Salle 3',
    'esp32-04': 'Terrasse',
    'esp32-05': 'Toit',
    'esp32-06': 'Annexe',
    'esp32-07': 'Couloir'
  };

  function getDeviceName(id: string) {
    return DEVICE_LABELS[id] ?? id;
  }

  function parseTopic(topic: string): { deviceId: string | null } {
    const parts = topic.split('/');
    if (parts.length >= 3 && parts[0] === 'classroom') {
      return { deviceId: parts[1] };
    }
    return { deviceId: null };
  }

  function parseFlipperTopic(topic: string): { deviceId: string | null; channel?: string } {
    const parts = topic.split('/');
    if (parts.length >= 3 && parts[0] === 'flipper') {
      return { deviceId: parts[1], channel: parts[2] };
    }
    return { deviceId: null };
  }

  function isOnline(ts?: string): boolean {
    if (!ts) return false;
    const t = new Date(ts).getTime();
    if (Number.isNaN(t)) return false;
    const now = Date.now();
    const diffSeconds = (now - t) / 1000;
    return diffSeconds < 60; // online si message de moins de 60s
  }

  function formatDate(ts?: string): string {
    if (!ts) return '–';
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '–';
    return d.toLocaleTimeString();
  }

  onMount(() => {
    const ws = new WebSocket('ws://localhost:8080');

    ws.onopen = () => {
      status = 'connected';
    };

    ws.onclose = () => {
      status = 'disconnected';
    };

    ws.onerror = () => {
      status = 'error';
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (!data.topic || !data.payload) {
          return;
        }

        // Historique compact des derniers messages bruts (max 20)
        rawTotal += 1;
        if (rawEnabled) {
          lastRawMessages = [
            { topic: data.topic, payload: data.payload },
            ...lastRawMessages
          ].slice(0, 20);
        }

        // Flipper events handling
        if (data.topic.startsWith('flipper/')) {
          const { deviceId, channel } = parseFlipperTopic(data.topic);
          if (!deviceId) return;

          try {
          const parsed = JSON.parse(data.payload);
          const tsMs =
            parsed.ts !== undefined
              ? typeof parsed.ts === 'number'
                ? parsed.ts * 1000
                : Number(parsed.ts)
              : undefined;

          let button: string | undefined =
            parsed.button ?? parsed.btn ?? parsed.key ?? parsed.event ?? parsed.name;
          let value: string | number | undefined;

          // Boutons : si payload { buttons: { leftFlipper: bool, ... } }
          if (!button && channel === 'buttons' && typeof parsed.buttons === 'object') {
            const pressed = Object.entries(parsed.buttons).filter(([, v]) => v === true);
            if (pressed.length === 0) {
              // pas de bouton enfoncé => on ignore pour réduire le bruit
              return;
            }
            // On comptabilise chaque bouton actuellement enfoncé
            pressed.forEach(([k]) => {
              flipperCounters = {
                ...flipperCounters,
                [k]: (flipperCounters[k] ?? 0) + 1
              };
            });
            button = pressed.map(([k]) => k).join('+');
            value = 'pressed';
          }

          // Tilt/nudge : on ne compte que si tilt ou nudge est true
          if (!button && channel === 'tilt') {
            if (parsed.tilt === true) {
              button = 'tilt';
              value = 'tilt';
            } else if (parsed.nudge === true) {
              button = 'nudge';
              value = 'nudge';
            } else {
              // tilt stable => on ignore pour réduire le bruit
              return;
            }
          }

          // Plunger : action (pull/release)
          if (!button && channel === 'plunger' && parsed.action) {
            button = parsed.action;
            value = parsed.position ?? parsed.value ?? parsed.payload;
          }

          // Par défaut, on remonte value générique
          if (value === undefined) {
            const rawValue =
              parsed.value ??
              parsed.state ??
              parsed.press ??
              parsed.payload ??
              parsed.count;
            value =
              rawValue && typeof rawValue === 'object'
                ? JSON.stringify(rawValue)
                : rawValue;
          }

            const ev: FlipperEvent = {
              deviceId,
              channel,
              button,
              value,
              ts: tsMs && !Number.isNaN(tsMs) ? new Date(tsMs).toISOString() : parsed.ts,
              raw: parsed
            };

          if (button) {
            const btnKey = button;
            flipperCounters = {
              ...flipperCounters,
              [btnKey]: (flipperCounters[btnKey] ?? 0) + 1
            };
          }
            flipperTimeline = [ev, ...flipperTimeline].slice(0, 20);
            lastFlipper = ev;
          } catch (err) {
            console.error('Error parsing flipper payload', err);
          }
          return;
        }

        // Classroom telemetry handling
        const { deviceId } = parseTopic(data.topic);
        if (!deviceId) return;

        let telemetry: Telemetry | null = null;
        try {
          const parsed = JSON.parse(data.payload);
          const tsMs =
            parsed.ts !== undefined
              ? typeof parsed.ts === 'number'
                ? parsed.ts * 1000
                : Number(parsed.ts)
              : undefined;
          telemetry = {
            deviceId,
            temperature:
              parsed.temperature ??
              parsed.tempC ??
              (parsed.tempValue !== undefined && parsed.tempUnit === 'C'
                ? parsed.tempValue
                : undefined),
            humidity: parsed.humidity ?? parsed.humPct,
            battery: parsed.battery ?? parsed.batteryPct,
            ts: tsMs && !Number.isNaN(tsMs) ? new Date(tsMs).toISOString() : parsed.ts
          };
        } catch (e) {
          console.error('Error parsing telemetry payload', e);
          return;
        }

        if (!devices[deviceId]) {
          devices = {
            ...devices,
            [deviceId]: {
              id: deviceId,
              name: getDeviceName(deviceId),
              last: telemetry
            }
          };
        } else {
          devices = {
            ...devices,
            [deviceId]: {
              ...devices[deviceId],
              last: telemetry
            }
          };
        }
      } catch (e) {
        console.error('Error handling WS message', e);
      }
    };

    return () => {
      ws.close();
    };
  });
</script>

<main>
  <section class="header">
    <h1>Météo IoT – Classroom</h1>
    <p class:ok={status === 'connected'} class:bad={status !== 'connected'}>
      WebSocket status: <strong>{status}</strong>
    </p>
  </section>

  <section class="grid">
    {#if Object.keys(devices).length === 0}
      <p class="placeholder">
        En attente de données… Vérifie que le bridge est lancé (<code>node bridge/server.js</code>)
        et que les ESP32 envoient bien sur <code>classroom/+/telemetry</code>.
      </p>
    {:else}
      {#each Object.values(devices) as device}
        {#if device.last}
          <article
            class="card"
            class:online={isOnline(device.last.ts)}
            class:offline={!isOnline(device.last.ts)}
          >
            <header>
              <h2>{device.name}</h2>
              <span class="chip">{device.id}</span>
            </header>
            <div class="metrics">
              <div>
                <span class="label">Température</span>
                <span class="value">
                  {device.last.temperature !== undefined
                    ? `${device.last.temperature.toFixed(1)} °C`
                    : '–'}
                </span>
              </div>
              <div>
                <span class="label">Humidité</span>
                <span class="value">
                  {device.last.humidity !== undefined
                    ? `${device.last.humidity.toFixed(0)} %`
                    : '–'}
                </span>
              </div>
              <div>
                <span class="label">Batterie</span>
                <span class="value">
                  {device.last.battery !== undefined
                    ? `${device.last.battery.toFixed(2)} V`
                    : '–'}
                </span>
              </div>
            </div>
            <footer>
              <span class="updated">
                Dernière mise à jour: {formatDate(device.last.ts)}
              </span>
              <span class="state">
                {#if isOnline(device.last.ts)}
                  <span class="dot online-dot"></span> Online
                {:else}
                  <span class="dot offline-dot"></span> Offline
                {/if}
              </span>
            </footer>
          </article>
        {/if}
      {/each}
    {/if}
  </section>

  <section class="flipper-section">
    <div class="flipper-head">
      <div>
        <h2>Flipper events</h2>
        <p class="muted">
          Souscription à <code>flipper/+/+</code> via le bridge MQTT → WebSocket.
        </p>
      </div>
      <span class="chip pill">Bonus</span>
    </div>

    <div class="flipper-grid">
      <article class="card">
        <h3>Dernier event</h3>
        {#if lastFlipper}
          <div class="flipper-last">
            <div class="row">
              <span class="label">Device</span>
              <span class="value">{lastFlipper.deviceId}</span>
            </div>
            <div class="row">
              <span class="label">Channel</span>
              <span class="value">{lastFlipper.channel ?? '—'}</span>
            </div>
            <div class="row">
              <span class="label">Bouton</span>
              <span class="value">{lastFlipper.button ?? '—'}</span>
            </div>
            <div class="row">
              <span class="label">Valeur</span>
              <span class="value">{lastFlipper.value ?? '—'}</span>
            </div>
            <div class="row">
              <span class="label">Horodatage</span>
              <span class="value">{formatDate(lastFlipper.ts)}</span>
            </div>
          </div>
        {:else}
          <p class="muted">En attente d’un premier event flipper…</p>
        {/if}
      </article>

      <article class="card">
        <h3>Compteurs par bouton</h3>
        <div class="chips">
          {#if Object.keys(flipperCounters).length === 0}
            <p class="muted">En attente de messages flipper…</p>
          {:else}
            {#each Object.entries(flipperCounters) as [btn, count]}
              <span class="chip counter">
                <strong>{btn}</strong>
                <span class="muted">×</span>
                {count}
              </span>
            {/each}
          {/if}
        </div>
      </article>

      <article class="card timeline-card">
        <h3>Timeline (20 derniers events)</h3>
        <ul class="timeline">
          {#if flipperTimeline.length === 0}
            <li class="muted">En attente de messages flipper…</li>
          {:else}
            {#each flipperTimeline as ev}
              <li>
                <span class="chip small">{ev.button ?? 'unknown'}</span>
                <span class="muted">
                  {ev.deviceId} · {ev.channel ?? '—'} · {formatDate(ev.ts)}
                </span>
                {#if ev.value !== undefined}
                  <span class="value-inline">{ev.value}</span>
                {/if}
              </li>
            {/each}
          {/if}
        </ul>
      </article>
    </div>
  </section>

  <section class="debug">
    <div class="debug-head">
      <div>
        <h2>Derniers messages bruts (20 max)</h2>
        <p class="muted">Capture opt-in pour éviter le spam. Total reçus: {rawTotal}</p>
      </div>
      <button class="btn" on:click={() => (rawEnabled = !rawEnabled)}>
        {rawEnabled ? 'Masquer' : 'Afficher'}
      </button>
    </div>
    <ul>
      {#each lastRawMessages as m}
        <li>
          <code>{m.topic}</code> – <code>{m.payload}</code>
        </li>
      {/each}
    </ul>
  </section>
</main>

<style>
  main {
    min-height: 100vh;
    padding: 2rem;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: radial-gradient(circle at top, #1e293b 0, #020617 55%);
    color: #e5e7eb;
  }

  .header {
    margin-bottom: 2rem;
  }

  h1 {
    font-size: 2rem;
    margin: 0;
  }

  .header p {
    margin-top: 0.5rem;
  }

  .ok {
    color: #4ade80;
  }

  .bad {
    color: #f97373;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 1.5rem;
    margin-bottom: 2rem;
  }

  .placeholder {
    grid-column: 1 / -1;
    background: rgba(15, 23, 42, 0.8);
    border-radius: 1rem;
    padding: 1.5rem;
    border: 1px dashed rgba(148, 163, 184, 0.6);
  }

  .card {
    background: rgba(15, 23, 42, 0.9);
    border-radius: 1rem;
    padding: 1.25rem;
    border: 1px solid rgba(148, 163, 184, 0.3);
    box-shadow: 0 18px 40px rgba(15, 23, 42, 0.6);
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    transition: transform 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease;
  }

  .card.online {
    border-color: rgba(74, 222, 128, 0.7);
  }

  .card.offline {
    border-color: rgba(248, 113, 113, 0.7);
    opacity: 0.75;
  }

  .card:hover {
    transform: translateY(-3px);
    box-shadow: 0 22px 50px rgba(15, 23, 42, 0.9);
  }

  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  h2 {
    font-size: 1.1rem;
    margin: 0;
  }

  .chip {
    font-size: 0.75rem;
    padding: 0.15rem 0.5rem;
    border-radius: 999px;
    background: rgba(15, 23, 42, 0.9);
    border: 1px solid rgba(148, 163, 184, 0.7);
  }

  .metrics {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0.75rem;
  }

  .label {
    display: block;
    font-size: 0.75rem;
    color: #9ca3af;
  }

  .value {
    font-size: 0.95rem;
    font-weight: 600;
  }

  footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 0.75rem;
    color: #9ca3af;
  }

  .state {
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }

  .dot {
    width: 0.6rem;
    height: 0.6rem;
    border-radius: 999px;
  }

  .online-dot {
    background: #22c55e;
    box-shadow: 0 0 6px #22c55e;
  }

  .offline-dot {
    background: #ef4444;
    box-shadow: 0 0 6px #ef4444;
  }

  code {
    font-family: ui-monospace, Menlo, Monaco, 'SFMono-Regular', Consolas, 'Liberation Mono', 'Courier New', monospace;
  }

  /* Flipper */
  .flipper-section {
    margin-bottom: 2rem;
  }

  .flipper-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1rem;
    margin-bottom: 1rem;
  }

  .flipper-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: 1rem;
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: center;
    min-height: 2rem;
  }

  .chip.counter {
    background: rgba(56, 189, 248, 0.12);
    border-color: rgba(56, 189, 248, 0.4);
    color: #e5e7eb;
  }

  .chip.small {
    font-size: 0.7rem;
    padding: 0.08rem 0.45rem;
  }

  .flipper-last .row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.3rem 0;
    border-bottom: 1px solid rgba(148, 163, 184, 0.15);
  }

  .flipper-last .row:last-child {
    border-bottom: none;
  }

  .timeline {
    list-style: none;
    padding: 0;
    margin: 0;
    max-height: 220px;
    overflow: auto;
  }

  .timeline li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem;
    padding: 0.35rem 0;
    border-bottom: 1px solid rgba(148, 163, 184, 0.15);
  }

  .timeline li:last-child {
    border-bottom: none;
  }

  .timeline-card .muted {
    display: block;
  }

  .pill {
    padding: 0.2rem 0.65rem;
    background: rgba(56, 189, 248, 0.1);
    border: 1px solid rgba(56, 189, 248, 0.35);
    border-radius: 999px;
    color: #e5e7eb;
    font-size: 0.8rem;
  }

  .muted {
    color: #9ca3af;
  }

  .value-inline {
    color: #e5e7eb;
    font-weight: 600;
  }

  /* Debug raw messages */
  .debug {
    background: rgba(15, 23, 42, 0.8);
    border-radius: 1rem;
    padding: 1rem 1.25rem;
    border: 1px solid rgba(148, 163, 184, 0.4);
  }

  .debug-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .debug h2 {
    font-size: 0.95rem;
    margin-top: 0;
    margin-bottom: 0.5rem;
  }

  .debug ul {
    list-style: none;
    padding: 0;
    margin: 0;
    max-height: 180px;
    overflow: auto;
    font-size: 0.8rem;
    word-break: break-all;
  }

  .debug li + li {
    margin-top: 0.25rem;
  }

  .muted {
    color: #9ca3af;
  }
</style>
