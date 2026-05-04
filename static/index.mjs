import { getPageOptions, patchPageOptions } from "/page_options.mjs";
import { docElem, POST_REBOOT_RELOAD_MS, showToast } from "/util.mjs";

function toast(message) {
  showToast(docElem.toast, message);
}

function loadStatus() {
  fetch("/api/status")
    .then(r => r.json())
    .then(d => {
      const hasBattery = d.features?.battery ?? true;
      docElem.batteryRow.style.display = hasBattery ? "contents" : "none";
      if (hasBattery) {
        docElem.statusBat.textContent = `${d.battery.voltage} mV (${d.battery.level}%)`;
      }

      const hasLed = d.features?.led ?? true;
      docElem.ledSection.style.display = hasLed ? "" : "none";
      if (hasLed) {
        fetch("/api/led")
          .then(r => r.json())
          .then(ld => setLedBtn(ld.state))
          .catch(() => {});
      }

      docElem.statusBoard.textContent = d.features?.board ?? "—";
      docElem.statusId.textContent = d.id;
      docElem.statusId.style.fontFamily = "monospace";
      const wifiText =
        d.wifi.mode === "ap"
          ? `${d.wifi.ssid} · ${d.wifi.ip} · (AP mode)`
          : `${d.wifi.ssid} · ${d.wifi.ip} · ${d.wifi.rssi} dBm`;
      docElem.statusWifi.textContent = wifiText;
      docElem.statusVerText.textContent = `v${d.version}`;
      docElem.otaLink.style.display = d.allow_ota === false ? "none" : "";
    })
    .catch(() => {
      ["statusBat", "statusBoard", "statusId", "statusWifi", "statusVerText"].forEach(id => {
        docElem[id].textContent = "N/A";
      });
    });
}

loadStatus();

function setLedBtn(on) {
  docElem.ledBtn.classList.toggle("on", on);
}

function toggleLed() {
  const next = !docElem.ledBtn.classList.contains("on");
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
  toast("Reconnecting…");
  fetch("/api/wifi/reconnect", { method: "POST" })
    .then(r => r.text())
    .then(t => toast(`${t} Reloading…`))
    .catch(() => toast("Device is reconnecting. Reloading soon…"))
    .finally(() => setTimeout(() => location.reload(), POST_REBOOT_RELOAD_MS));
}

function doRestart() {
  toast("Sending…");
  fetch("/api/restart", { method: "POST" })
    .then(r => r.text())
    .then(t => toast(t))
    .catch(() => toast("Device is restarting. Reloading soon…"))
    .finally(() => setTimeout(() => location.reload(), POST_REBOOT_RELOAD_MS));
}

function applyDurUnit(unit) {
  docElem.durVal.disabled = unit === "permanent";
  docElem.durVal.max = unit === "h" ? "4" : "255";
}

function clampDurVal() {
  const min = Number(docElem.durVal.min);
  const max = Number(docElem.durVal.max);
  let v = Number(docElem.durVal.value);
  if (Number.isNaN(v)) {
    v = min;
  }
  docElem.durVal.value = Math.max(min, Math.min(max, v));
}

function restoreDurState() {
  const opts = getPageOptions();
  if (opts.durVal != null) {
    docElem.durVal.value = opts.durVal;
  }
  if (opts.durUnit != null) {
    docElem.durUnit.value = opts.durUnit;
  }
  applyDurUnit(docElem.durUnit.value);
}

restoreDurState();

docElem.durVal.addEventListener("change", () => {
  clampDurVal();
  patchPageOptions({ durVal: docElem.durVal.value });
});
docElem.durUnit.addEventListener("change", () => {
  applyDurUnit(docElem.durUnit.value);
  clampDurVal();
  patchPageOptions({ durUnit: docElem.durUnit.value });
});

function doPowerOff() {
  const unit = docElem.durUnit.value;
  let seconds;
  if (unit === "permanent") {
    seconds = 0;
  } else if (unit === "h") {
    seconds = Math.round(parseFloat(docElem.durVal.value) * 3600);
  } else {
    seconds = Math.round(parseFloat(docElem.durVal.value) * 60);
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
  toast("Sending…");
  fetch(`/api/poweroff?duration=${seconds}`, { method: "POST" })
    .then(r => r.text())
    .then(t => {
      if (seconds > 0) {
        const wakeAt = new Date(Date.now() + seconds * 1000);
        t += ` (Scheduled wake-up: ${wakeAt.toLocaleTimeString()})`;
      }
      toast(t);
    })
    .catch(() => toast("Device is shutting down."));
}

docElem.refreshBtn.addEventListener("click", loadStatus);
docElem.ledBtn.addEventListener("click", toggleLed);
docElem.blinkBtn.addEventListener("click", doBlink);
docElem.reconnectBtn.addEventListener("click", doReconnect);
docElem.restartBtn.addEventListener("click", doRestart);
docElem.poweroffBtn.addEventListener("click", doPowerOff);
