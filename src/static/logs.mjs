function load() {
  fetch("/api/logs")
    .then(r => r.text())
    .then(t => {
      const log = document.getElementById("log");
      log.textContent = t;
      document.getElementById("status").textContent = `${t.length} bytes`;
      log.scrollTop = log.scrollHeight;
    })
    .catch(() => {
      document.getElementById("status").textContent = "Error";
    });
}

load();
document.getElementById("refresh-btn").addEventListener("click", load);
