/* eslint-env browser */
const list = document.getElementById("list");
const q = document.getElementById("q");
let rows = [];

window.addEventListener("message", (e) => {
    const { channel, payload } = e.data || {};
    if (!channel) return;
    push(channel, payload);
});

function push(channel, p) {
    let text = "", cls = "";
    if (channel.startsWith("cap:rest")) {
        if (channel.endsWith("request")) text = `[REST→] ${p.method} ${p.url}`;
        else text = `[REST←] ${p.status} ${p.method} ${p.url}`;
        cls = channel.endsWith("response") && p.status >= 400 ? "err" : "ok";
    } else if (channel.startsWith("cap:ws")) {
        if (channel.includes(":open")) text = `[WS ◉] ${p.id} ${p.url}`;
        if (channel.includes(":msg")) text = `[WS ⇄ ${p.dir}] ${p.id} ${String(p.data).slice(0, 140)}`;
        if (channel.includes(":close")) text = `[WS ⬤] ${p.id} code=${p.code} reason=${p.reason || ""}`;
    }
    rows.push({ channel, p, text, cls });
    render();
}

function render() {
    const f = (q.value || "").toLowerCase();
    list.innerHTML = "";
    rows.forEach(r => {
        const s = `${r.text} ${JSON.stringify(r.p)}`.toLowerCase();
        if (f && !s.includes(f)) return;
        const div = document.createElement("div");
        div.className = `row ${r.cls || ""}`;
        div.innerHTML = `<span class="tag">${r.channel.replace("cap:", "")}</span>${r.text}`;
        list.appendChild(div);
    });
}
q.addEventListener("input", render);
