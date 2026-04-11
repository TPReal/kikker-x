import { docElem } from "/util.mjs";

function load() {
  fetch("/api/logs")
    .then(r => r.text())
    .then(t => {
      docElem.log.textContent = t;
      docElem.status.textContent = `${t.length} bytes`;
      docElem.log.scrollTop = docElem.log.scrollHeight;
    })
    .catch(() => {
      docElem.status.textContent = "Error";
    });
}

load();
docElem.refreshBtn.addEventListener("click", load);
