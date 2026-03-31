function loadStatus() {
  fetch("/api/status")
    .then(r => r.json())
    .then(d => {
      const hasBattery = d.features?.battery ?? true;
      document.getElementById("battery-row").style.display = hasBattery ? "contents" : "none";
      if (hasBattery)
        document.getElementById("status-bat").textContent = `${d.battery.voltage} mV (${d.battery.level}%)`;

      const hasLed = d.features?.led ?? true;
      document.getElementById("led-section").style.display = hasLed ? "" : "none";
      if (hasLed)
        fetch("/api/led")
          .then(r => r.json())
          .then(ld => setLedBtn(ld.state))
          .catch(() => {});

      document.getElementById("status-board").textContent = d.features?.board ?? "—";
      const idEl = document.getElementById("status-id");
      idEl.textContent = d.id;
      idEl.style.fontFamily = "monospace";
      const wifiText =
        d.wifi.mode === "ap"
          ? `${d.wifi.ssid} · ${d.wifi.ip} · (AP mode)`
          : `${d.wifi.ssid} · ${d.wifi.ip} · ${d.wifi.rssi} dBm`;
      document.getElementById("status-wifi").textContent = wifiText;
      document.getElementById("status-ver").textContent = d.version;
    })
    .catch(() => {
      ["status-bat", "status-board", "status-id", "status-wifi", "status-ver"].forEach(id => {
        document.getElementById(id).textContent = "N/A";
      });
    });
}

loadStatus();

function setLedBtn(on) {
  document.getElementById("led-btn").classList.toggle("on", on);
}

function toggleLed() {
  const btn = document.getElementById("led-btn");
  const next = !btn.classList.contains("on");
  fetch("/api/led", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state: next }),
  })
    .then(r => r.json())
    .then(d => {
      setLedBtn(d.state);
    })
    .catch(() => {});
}

function doBlink() {
  const raw = prompt("Blink pattern (ms on, ms off, …):", "200,200,200,200,200");
  if (raw === null) {
    return;
  }
  const pattern = raw.trim() || "200";
  fetch("/api/led/blink", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pattern: pattern }),
  })
    .then(r => (r.ok ? null : r.text().then(t => alert(t))))
    .catch(() => {});
}

function doReconnect() {
  const msg = document.getElementById("msg");
  msg.textContent = "Reconnecting…";
  fetch("/api/wifi/reconnect", { method: "POST" })
    .then(r => r.text())
    .then(t => {
      msg.textContent = `${t} Reloading…`;
      setTimeout(() => location.reload(), 6000);
    })
    .catch(() => {
      msg.textContent = "Reconnecting… Reloading…";
      setTimeout(() => location.reload(), 6000);
    });
}

function doRestart() {
  const msg = document.getElementById("msg");
  msg.textContent = "Sending…";
  fetch("/api/restart", { method: "POST" })
    .then(r => r.text())
    .then(t => {
      msg.textContent = t;
      setTimeout(() => location.reload(), 3000);
    })
    .catch(() => {
      msg.textContent = "Device is restarting.";
      setTimeout(() => location.reload(), 3000);
    });
}

const durVal = document.getElementById("dur-val");
const durUnit = document.getElementById("dur-unit");

import { getPageOptions, patchPageOptions } from "/page_options.mjs";

function applyDurUnit(unit) {
  durVal.disabled = unit === "permanent";
  durVal.max = unit === "h" ? "4" : "255";
}

function clampDurVal() {
  const min = Number(durVal.min);
  const max = Number(durVal.max);
  let v = Number(durVal.value);
  if (Number.isNaN(v)) {
    v = min;
  }
  durVal.value = Math.max(min, Math.min(max, v));
}

function restoreDurState() {
  const opts = getPageOptions();
  if (opts.durVal != null) {
    durVal.value = opts.durVal;
  }
  if (opts.durUnit != null) {
    durUnit.value = opts.durUnit;
  }
  applyDurUnit(durUnit.value);
}

restoreDurState();

durVal.addEventListener("change", () => {
  clampDurVal();
  patchPageOptions({ durVal: durVal.value });
});
durUnit.addEventListener("change", () => {
  applyDurUnit(durUnit.value);
  clampDurVal();
  patchPageOptions({ durUnit: durUnit.value });
});

function doPowerOff() {
  const unit = durUnit.value;
  let seconds;
  if (unit === "permanent") {
    seconds = 0;
  } else if (unit === "h") {
    seconds = Math.round(parseFloat(durVal.value) * 3600);
  } else {
    seconds = Math.round(parseFloat(durVal.value) * 60);
  }
  const MAX_SLEEP_S = 255 * 60; // BM8563 timer limit: 255 minutes
  if (unit !== "permanent" && seconds <= 0) {
    alert("Duration must be greater than 0.");
    return;
  }
  if (seconds > MAX_SLEEP_S) {
    alert("Maximum sleep duration is 255 minutes (4 h 15 min).");
    return;
  }
  const msg = document.getElementById("msg");
  msg.textContent = "Sending…";
  fetch(`/api/poweroff?duration=${seconds}`, { method: "POST" })
    .then(r => r.text())
    .then(t => {
      if (seconds > 0) {
        const wakeAt = new Date(Date.now() + seconds * 1000);
        t += ` (Scheduled wake-up: ${wakeAt.toLocaleTimeString()})`;
      }
      msg.textContent = t;
    })
    .catch(() => {
      msg.textContent = "Device is shutting down.";
    });
}

document.getElementById("refresh-btn").addEventListener("click", loadStatus);
document.getElementById("led-btn").addEventListener("click", toggleLed);
document.getElementById("blink-btn").addEventListener("click", doBlink);
document.getElementById("reconnect-btn").addEventListener("click", doReconnect);
document.getElementById("restart-btn").addEventListener("click", doRestart);
document.getElementById("poweroff-btn").addEventListener("click", doPowerOff);
