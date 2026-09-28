const $ = (id) => document.getElementById(id);
const docs = new Map(), pending = new Map();
const out = $("direct-output-box"), files = $("attached-document-list"), prompt = $("prompt-row");
const modelList = $("model-list"), pidModal = $("pid-modal"), pidCanvas = $("pid-canvas-container");
const pidStage = $("pid-stage"), pidView = $("pid-viewport"), appLayout = $("app-layout");
const sessionListEl = $("session-list"), traceLogsEl = $("trace-logs");
const modelPicker = $("model-picker"), modelPickerOptions = $("model-picker-options");
const modelDescriptions = new Map([["auto", { label: "Automatic routing", description: "Best available model for each task.", available: true }]]);
let session = null, stream = "", ws, running = false, uploading = false, lastTaskTitle = "ForgeLocal analysis";
let pidData, pidId, pidPage = 1, pidZoom = 1, pidImage;

const esc = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[char]));
const ext = (name) => (name.split(".").pop() || "").toLowerCase();
const nearLatest = (element) => element.scrollHeight - element.scrollTop - element.clientHeight < 72;
const isNarrow = () => window.innerWidth < 1200;

function setTheme(theme) {
  const dark = theme === "dark";
  document.documentElement.classList.toggle("dark", dark);
  const button = $("theme-toggle-btn");
  button.setAttribute("aria-pressed", String(dark));
  button.setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
  button.title = dark ? "Switch to light theme" : "Switch to dark theme";
  $("theme-toggle-icon").textContent = dark ? "☀" : "◐";
  try { localStorage.setItem("forgelocal-theme", dark ? "dark" : "light"); } catch (_) {}
}

function closeDrawers() {
  $("left-sidebar").classList.remove("is-open");
  $("right-sidebar").classList.remove("is-open");
  $("sidebar-scrim").classList.remove("is-visible");
  document.body.classList.remove("drawer-open");
}
function toggleDrawer(side) {
  const sidebar = $(side + "-sidebar");
  if (!isNarrow()) { appLayout.classList.toggle(side + "-collapsed"); return; }
  const open = !sidebar.classList.contains("is-open");
  closeDrawers();
  if (open) {
    sidebar.classList.add("is-open");
    $("sidebar-scrim").classList.add("is-visible");
    document.body.classList.add("drawer-open");
  }
}
function openDocuments() {
  if (!isNarrow()) appLayout.classList.remove("right-collapsed");
  else {
    closeDrawers();
    $("right-sidebar").classList.add("is-open");
    $("sidebar-scrim").classList.add("is-visible");
    document.body.classList.add("drawer-open");
  }
}
function updateNav(label = "Analysis") {
  document.querySelectorAll(".workspace-nav__item").forEach((item) => item.classList.toggle("is-active", item.textContent.trim() === label));
}
function progress(text, state = "") { $("task-progress-text").textContent = text; $("task-progress").className = "task-progress " + state; }
function setTimeline(step) {
  const order = ["prepare", "sources", "reason", "complete"], index = Math.max(0, order.indexOf(step));
  document.querySelectorAll("[data-timeline-step]").forEach((item, itemIndex) => item.classList.toggle("is-active", itemIndex <= index));
}
function setPipelineStage(stage) {
  const order = ["device", "index", "analysis", "deliver"], index = Math.max(0, order.indexOf(stage));
  document.querySelectorAll("[data-pipeline-step]").forEach((item, itemIndex) => {
    item.classList.toggle("is-active", itemIndex === index);
    item.classList.toggle("is-complete", itemIndex < index);
  });
}
function updateTrustLayer() {
  const ready = selected().filter((file) => file.state === "ready").length;
  const model = modelDescriptions.get($("model-select").value) || modelDescriptions.get("auto");
  $("trust-source-count").textContent = ready + " " + (ready === 1 ? "source" : "sources") + " indexed";
  $("trust-model").textContent = model.label;
}
function taskRunning(value) {
  running = value; $("run-btn").disabled = value; $("stop-btn").hidden = !value; $("clear-btn").disabled = value;
  const timeline = $("processing-timeline"), audit = $("execution-steps-drawer");
  appLayout.classList.toggle("analysis-focus", value); $("header-activity-pulse").hidden = !value;
  if (value) { closeDrawers(); timeline.hidden = false; audit.open = true; setTimeline("prepare"); setPipelineStage("analysis"); }
  else if (!timeline.hidden) { setTimeline("complete"); window.setTimeout(() => { if (!running) timeline.hidden = true; }, 1400); }
}
function selected() { return [...docs.values()].filter((file) => file.selected); }
const workflowConfig = {
  documents: { placeholder: "For example: Extract obligations, exceptions and actions from the selected documents.", action: "Analyze documents", prompt: "Summarize the selected files and list key actions." },
  drawing: { placeholder: "For example: Identify tagged equipment, control points and any items requiring review.", action: "Inspect drawing", prompt: "Explain the selected drawing and identify the main equipment and flow.", mode: "pid" },
  data: { placeholder: "For example: Identify trends, missing values and exceptions in the selected data.", action: "Review data", prompt: "Analyze the selected spreadsheet. Highlight trends, totals, and anomalies." },
  briefing: { placeholder: "For example: Create an executive briefing with findings, decisions and owners.", action: "Create briefing", prompt: "Create a concise briefing from the selected information." },
};
let activeWorkflow = "";
function chooseWorkflow(name) {
  const config = workflowConfig[name]; if (!config) return;
  activeWorkflow = name;
  document.querySelectorAll("[data-workflow]").forEach((card) => card.classList.toggle("is-selected", card.dataset.workflow === name));
  $("task-input").placeholder = config.placeholder; $("run-btn").textContent = config.action;
  if (!$("task-input").value.trim()) $("task-input").value = config.prompt;
  if (config.mode) $("mode-select").value = config.mode;
}
function resetWorkflow() {
  activeWorkflow = ""; document.querySelectorAll("[data-workflow]").forEach((card) => card.classList.remove("is-selected"));
  $("task-input").placeholder = "For example: Compare the selected procedures and identify the actions that need an owner.";
  $("run-btn").textContent = "Analyze";
}
function modelBrief(model) {
  if (model.role === "vision") return "Vision + OCR · " + model.vram_gb + " GB";
  return model.capabilities.some((capability) => /cod|debug/i.test(capability)) ? "General + coding · " + model.vram_gb + " GB" : "General analysis · " + model.vram_gb + " GB";
}
function updateModelDescription() {
  const current = modelDescriptions.get($("model-select").value) || modelDescriptions.get("auto");
  $("model-picker-title").textContent = current.label;
  $("model-picker-caption").textContent = current.description;
  modelPickerOptions.querySelectorAll(".model-picker-option").forEach((option) => option.setAttribute("aria-selected", String(option.dataset.value === $("model-select").value)));
  updateTrustLayer();
}
function setModel(value) {
  const model = modelDescriptions.get(value);
  if (!model || !model.available) return;
  $("model-select").value = value; updateModelDescription(); modelPicker.open = false;
}
function renderModelOptions() {
  modelPickerOptions.replaceChildren();
  modelDescriptions.forEach((model, value) => {
    const option = document.createElement("button"), text = document.createElement("span"), name = document.createElement("strong"), description = document.createElement("small");
    option.type = "button"; option.className = "model-picker-option"; option.dataset.value = value; option.setAttribute("role", "option"); option.setAttribute("aria-selected", String(value === $("model-select").value)); option.disabled = !model.available;
    name.textContent = model.label; description.textContent = model.available ? model.description : "Not installed on this device.";
    text.append(name, description); option.append(text);
    if (value === "auto") { const badge = document.createElement("em"); badge.textContent = "Recommended"; option.append(badge); }
    option.onclick = () => setModel(value); modelPickerOptions.append(option);
  });
}

function starters() {
  const current = selected(), extensions = current.map((file) => file.extension);
  if (extensions.some((value) => ["xlsx", "xls", "csv", "tsv"].includes(value))) return [
    ["Analyze data", "Analyze the selected spreadsheet. Highlight trends, totals, and anomalies."],
    ["Check quality", "Check the selected spreadsheet for missing values, duplicates, and inconsistent data."],
    ["Create summary", "Create a concise summary from the selected data."],
  ];
  if (extensions.some((value) => ["png", "jpg", "jpeg", "tif", "tiff", "dwg"].includes(value)) || current.some((file) => file.mode === "pid")) return [
    ["Explain drawing", "Explain the selected drawing and identify the main equipment and flow."],
    ["Find equipment", "List detected equipment and instrument tags in the selected drawing."],
    ["Review safety", "Review the selected drawing for control and isolation points."],
  ];
  return [
    ["Summarize", "Summarize the selected files and list key actions."],
    ["Compare files", "Compare the selected documents and highlight differences."],
    ["Create briefing", "Create a concise briefing from the selected information."],
  ];
}
function suggestions() {
  prompt.replaceChildren();
  const label = document.createElement("span"); label.textContent = "Suggested starting points"; prompt.append(label);
  starters().forEach(([labelText, taskText]) => {
    const button = document.createElement("button");
    button.type = "button"; button.className = "chip"; button.dataset.prompt = taskText; button.textContent = labelText; prompt.append(button);
  });
}
function setPrompt(value) {
  $("task-input").value = value; $("task-input").focus();
  $("task-form").scrollIntoView({ behavior: "smooth", block: "center" }); updateNav("Analysis");
}
function empty() {
  out.innerHTML = '<div class="output-placeholder"><div><span class="output-placeholder__mark" aria-hidden="true">□</span><strong>Start with a clear objective.</strong><span>Select a workflow, add local source files, or describe the result you need.</span><button type="button" class="button button--secondary" data-open-documents>Add source files</button></div></div>';
  $("answer-caption").textContent = "Evidence, recommendations and generated deliverables will appear here.";
  $("answer-actions").hidden = true; $("answer-sources").hidden = true; $("export-status").textContent = "";
}
function formattedOutput(value) {
  return String(value ?? "").split("\n").map((line) => {
    const safe = esc(line);
    if (/^#{1,3}\s+/.test(line)) return `<p class="output-line output-line--heading">${safe.replace(/^#{1,3}\s+/, "")}</p>`;
    if (/^[-*]\s+/.test(line)) return `<p class="output-line output-line--bullet">${safe.replace(/^[-*]\s+/, "")}</p>`;
    if (/^\d+\.\s+/.test(line)) return `<p class="output-line output-line--bullet">${safe.replace(/^\d+\.\s+/, "")}</p>`;
    return line.trim() ? `<p class="output-line">${safe}</p>` : '<div class="output-line"></div>';
  }).join("");
}
function sources() {
  const ready = selected().filter((file) => file.state === "ready");
  $("answer-actions").hidden = !stream; $("answer-sources").hidden = !ready.length;
  $("answer-sources").innerHTML = ready.length ? `<strong>Sources</strong>${ready.map((file) => `<span>${esc(file.filename)}</span>`).join("")}` : "";
}
function render() {
  const follow = nearLatest(out); out.innerHTML = formattedOutput(stream);
  if (follow) { out.scrollTop = out.scrollHeight; $("jump-latest-btn").hidden = true; } else $("jump-latest-btn").hidden = false;
  sources();
}
function renderDocs() {
  files.replaceChildren();
  if (!docs.size) files.innerHTML = '<p class="empty-state">No files added.</p>';
  docs.forEach((file) => {
    const row = document.createElement("div"), check = document.createElement("input"), details = document.createElement("div");
    row.className = "attached-document"; check.type = "checkbox"; check.checked = file.selected;
    check.disabled = ["uploading", "extracting", "indexing"].includes(file.state); check.setAttribute("aria-label", "Use " + file.filename + " for this analysis");
    check.onchange = () => { file.selected = check.checked; renderDocs(); };
    details.innerHTML = `<div class="document-name">${esc(file.filename)}</div><div class="document-meta">${esc((file.extension || "file").toUpperCase())}${file.size_kb ? " · " + file.size_kb + " KB" : ""}</div><span class="state-badge ${esc(file.state)}">${esc(file.state)}</span>`;
    row.append(check, details);
    if (file.state === "failed" && pending.has(file.filename)) {
      const retry = document.createElement("button"); retry.className = "retry-upload-btn"; retry.textContent = "Retry"; retry.onclick = () => upload(pending.get(file.filename)); row.append(retry);
    }
    if (file.state === "ready" && (file.preview || file.pid_id)) {
      const preview = document.createElement("button"); preview.type = "button"; preview.className = "file-preview-btn"; preview.textContent = "Preview"; preview.onclick = () => openSourcePreview(file); row.append(preview);
    }
    files.append(row);
  });
  const active = selected();
  $("selected-document-summary").textContent = active.length ? "Using for this analysis: " + active.map((file) => file.filename).join(", ") : "No source files selected. You can still ask a general question.";
  suggestions(); sources(); updateTrustLayer();
}
function put(file) {
  docs.set(file.filename, { ...(docs.get(file.filename) || {}), ...file, extension: file.extension || ext(file.filename), state: file.state || "ready", selected: file.selected ?? false });
  renderDocs();
}
async function uploads() {
  try { (await (await fetch("/api/uploads")).json()).forEach((file) => { if (!docs.has(file.filename)) put({ ...file, state: "ready" }); }); } catch (_) {}
}
function selectFile(file) {
  if (!file) return;
  const transfer = new DataTransfer(); transfer.items.add(file); $("file-input").files = transfer.files;
  $("drop-zone").querySelector(".drop-text").textContent = "Ready: " + file.name;
}
function wireWorkflowDropzones() {
  document.querySelectorAll("[data-workflow]").forEach((card) => {
    card.addEventListener("dragover", (event) => { event.preventDefault(); card.classList.add("is-drop-target"); });
    card.addEventListener("dragleave", () => card.classList.remove("is-drop-target"));
    card.addEventListener("drop", (event) => {
      event.preventDefault(); card.classList.remove("is-drop-target");
      const file = event.dataTransfer.files[0]; if (!file) return;
      chooseWorkflow(card.dataset.workflow); if (card.dataset.workflow === "drawing") $("mode-select").value = "pid";
      selectFile(file); openDocuments(); updateNav("Documents"); upload(file);
    });
  });
}
async function upload(file) {
  if (!file || uploading) return;
  const mode = $("mode-select").value, base = { filename: file.name, extension: ext(file.name), size_kb: +(file.size / 1024).toFixed(1), selected: true, mode };
  uploading = true; setPipelineStage("device"); $("ingest-btn").disabled = true; pending.set(file.name, file); put({ ...base, state: "uploading" }); $("ingest-log").textContent = "Uploading " + file.name + "…";
  try {
    const formData = new FormData(); formData.append("file", file);
    const response = await fetch("/api/upload", { method: "POST", body: formData }); if (!response.ok) throw new Error("Upload failed");
    put({ ...base, state: "extracting" }); setPipelineStage("index"); $("ingest-log").textContent = "Extracting content from " + file.name + "…";
    await new Promise(requestAnimationFrame);
    put({ ...base, state: "indexing" }); setPipelineStage("index"); $("ingest-log").textContent = "Indexing " + file.name + "…";
    const url = mode === "pid" ? "/api/pid/ingest?" + new URLSearchParams({ filename: file.name, dpi: "300" }) : "/api/ingest?" + new URLSearchParams({ filename: file.name, ...(mode !== "auto" ? { mode } : {}) });
    const data = await (await fetch(url, { method: "POST" })).json(); if (data.error) throw new Error(data.error);
    put({ ...base, state: "ready", preview: data.preview || "", pid_id: data.pid_id || "", page_count: data.page_count || 0, total_symbols: data.total_symbols || 0, total_texts: data.total_texts || 0 }); setPipelineStage("index"); pending.delete(file.name); $("ingest-log").textContent = "Ready: " + file.name;
    if (mode === "pid" && data.pid_id) openPid(data.pid_id);
    $("file-input").value = ""; $("drop-zone").querySelector(".drop-text").textContent = "Add source files";
  } catch (error) {
    put({ ...base, state: "failed" }); $("ingest-log").textContent = "Could not process " + file.name + ": " + error.message + ". You can retry.";
  } finally { uploading = false; $("ingest-btn").disabled = false; }
}
function openSourcePreview(file) {
  $("source-preview-modal").hidden = false; $("source-preview-title").textContent = file.filename;
  const meta = file.pid_id ? (file.page_count || 1) + " pages · " + (file.total_symbols || 0) + " detected symbols" : ((file.extension || "file").toUpperCase() + " · extracted preview");
  $("source-preview-meta").textContent = meta;
  const content = $("source-preview-content"); content.replaceChildren();
  if (file.pid_id) {
    const image = document.createElement("img"), actions = document.createElement("div"), open = document.createElement("button");
    image.src = "/api/pid/" + encodeURIComponent(file.pid_id) + "/page/1"; image.alt = "First page of " + file.filename; image.className = "source-preview-image";
    open.type = "button"; open.className = "button button--secondary"; open.textContent = "Open drawing inspector"; open.onclick = () => { $("source-preview-modal").hidden = true; openPid(file.pid_id); };
    actions.className = "preview-actions"; actions.append(open); content.append(image, actions);
  } else {
    const label = document.createElement("span"), excerpt = document.createElement("pre");
    label.className = "preview-kicker"; label.textContent = ["csv", "tsv", "xlsx", "xls"].includes(file.extension) ? "Data sample" : "Extracted excerpt";
    excerpt.textContent = file.preview || "Preview unavailable for this file."; content.append(label, excerpt);
  }
}

async function status() {
  try {
    const data = await (await fetch("/api/status")).json();
    $("ollama-dot").className = "status-dot " + (data.ollama_running ? "on" : "off"); $("ollama-status-text").textContent = data.ollama_running ? "Ready" : "Needs attention";
    const old = $("model-select").value; modelDescriptions.clear(); modelDescriptions.set("auto", { label: "Automatic routing", description: "Best available model for each task.", available: true }); modelList.replaceChildren();
    data.registered_models.forEach((model) => {
      if (!["chat", "vision"].includes(model.role)) return;
      const kind = model.role === "vision" ? "Vision" : model.capabilities.some((capability) => /cod|debug/i.test(capability)) ? "Coding" : "General";
      modelDescriptions.set(model.name, { label: model.display_name, description: modelBrief(model), available: model.pulled });
      const row = document.createElement("details"); row.className = "model-row";
      row.innerHTML = `<summary><span class="status-dot ${model.pulled ? "on" : "off"}"></span><span class="model-meta"><strong class="model-name">${esc(model.display_name)}</strong><span class="model-caps">${kind} · ${model.pulled ? "Available" : "Unavailable"}</span></span></summary><div class="model-details">Capabilities: ${esc(model.capabilities.join(", "))}<br>Memory: ~${model.vram_gb} GB VRAM</div>`;
      row.querySelector(".model-details").textContent = modelBrief(model);
      modelList.append(row);
    });
    if (!modelDescriptions.get(old)?.available) $("model-select").value = "auto";
    renderModelOptions();
    updateModelDescription();
  } catch (_) { $("ollama-dot").className = "status-dot off"; $("ollama-status-text").textContent = "Unavailable"; }
}
function log(kind, label, text) {
  if (traceLogsEl.querySelector(".empty-state")) traceLogsEl.replaceChildren();
  const count = (window.steps || 0) + 1; window.steps = count; $("step-count-badge").textContent = count + " " + (count === 1 ? "event" : "events");
  traceLogsEl.insertAdjacentHTML("beforeend", `<div class="trace-entry"><span class="trace-label ${esc(kind)}">${esc(label)}</span>${esc(text)}</div>`);
}
function connect() {
  ws = new WebSocket((location.protocol === "https:" ? "wss" : "ws") + "://" + location.host + "/ws/agent");
  ws.onclose = () => setTimeout(connect, 1500);
  ws.onmessage = (event) => {
    const value = JSON.parse(event.data); if (value.session_id) session = value.session_id;
    if (value.type === "routing") { log("route", "ROUTE", "Using " + (value.model || "local model")); setTimeline("prepare"); progress("Preparing " + (value.model || "local model"), "is-active"); }
    if (value.type === "thinking") { log("call", "PLAN", value.content); setTimeline("reason"); progress("Preparing analysis", "is-active"); }
    if (value.type === "tool_call") { log("call", "CALL " + value.tool, JSON.stringify(value.args)); setTimeline(/search|doc/i.test(value.tool) ? "sources" : "reason"); progress(/search|doc/i.test(value.tool) ? "Reviewing selected sources" : "Working with task data", "is-active"); }
    if (value.type === "stream_chunk") { stream += value.chunk || ""; render(); setTimeline("reason"); progress("Generating result", "is-active"); $("answer-caption").textContent = "Analysis in progress"; }
    if (value.type === "final") { if (!stream) stream = value.content || ""; render(); taskRunning(false); setPipelineStage("deliver"); progress("Analysis completed", "is-success"); $("answer-caption").textContent = "Analysis completed"; refreshSessions(); refreshOutputs(); }
    if (value.type === "error") { taskRunning(false); progress("Analysis needs attention", "is-error"); $("answer-caption").textContent = value.content || "The analysis could not be completed."; }
    if (value.type === "cancelled") { taskRunning(false); progress("Analysis stopped"); $("answer-caption").textContent = "Analysis stopped"; }
  };
}
async function refreshSessions() {
  try {
    const sessions = await (await fetch("/api/sessions")).json(); sessionListEl.replaceChildren();
    if (!sessions.length) { sessionListEl.innerHTML = '<p class="empty-state">No saved analysis yet.</p>'; return; }
    sessions.forEach((item) => {
      const button = document.createElement("button"); button.className = "session-item " + (item.id === session ? "active" : "");
      button.innerHTML = `<span class="session-title">${esc(item.title)}</span><span class="session-time">${esc(item.model || "automatic")}</span>`;
      button.onclick = async () => {
        const detail = await (await fetch("/api/sessions/" + encodeURIComponent(item.id))).json();
        session = item.id; stream = detail.output || ""; $("task-input").value = detail.task || "";
        if (stream) render(); else empty(); $("answer-caption").textContent = stream ? "Saved analysis" : "Ready for a local analysis"; refreshSessions(); closeDrawers();
      };
      sessionListEl.append(button);
    });
  } catch (_) {}
}
async function refreshOutputs() {
  try {
    const outputs = await (await fetch("/api/outputs")).json(), list = $("output-list"); list.replaceChildren();
    const visibleOutputs = outputs.filter((file) => !file.filename.startsWith("."));
    if (!visibleOutputs.length) { list.innerHTML = '<p class="empty-state">Generated files will appear here.</p>'; return; }
    visibleOutputs.forEach((file) => {
      const row = document.createElement("div"); row.className = "output-row";
      row.innerHTML = `<div class="output-meta"><span class="output-name">${esc(file.filename)}</span><span class="output-size">${esc(file.size_kb)} KB</span></div><a href="/outputs/${encodeURIComponent(file.filename)}">Download</a>`;
      list.append(row);
    });
  } catch (_) {}
}
async function loadSession(item) {
  const detail = await (await fetch("/api/sessions/" + encodeURIComponent(item.id))).json();
  session = item.id; stream = detail.output || ""; $("task-input").value = detail.task || "";
  if (stream) render(); else empty(); $("answer-caption").textContent = stream ? "Saved analysis" : "Ready for a local analysis";
  refreshSessions(); closeDrawers();
}
async function refreshSessions() {
  try {
    const sessions = await (await fetch("/api/sessions")).json(); sessionListEl.replaceChildren();
    if (!sessions.length) { sessionListEl.innerHTML = '<p class="empty-state">No saved analysis yet.</p>'; return; }
    sessions.forEach((item) => {
      const row = document.createElement("div"), open = document.createElement("button"), actions = document.createElement("div"), pin = document.createElement("button"), duplicate = document.createElement("button"), title = document.createElement("span"), outcome = document.createElement("span"), meta = document.createElement("span");
      row.className = "session-row"; open.type = "button"; open.className = "session-item " + (item.id === session ? "active" : ""); title.className = "session-title"; outcome.className = "session-outcome"; meta.className = "session-time";
      title.textContent = (item.pinned ? "★ " : "") + item.title; outcome.textContent = item.outcome || "No outcome recorded yet."; meta.textContent = (item.source_count || 0) + " " + ((item.source_count || 0) === 1 ? "source" : "sources") + " · " + (item.model || "automatic"); open.append(title, outcome, meta); open.onclick = () => loadSession(item);
      actions.className = "session-actions";
      pin.type = "button"; pin.className = "session-action"; pin.textContent = item.pinned ? "Unpin" : "Pin"; pin.title = pin.textContent + " analysis"; pin.onclick = async () => { await fetch("/api/sessions/" + encodeURIComponent(item.id) + "/pin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pinned: !item.pinned }) }); refreshSessions(); };
      duplicate.type = "button"; duplicate.className = "session-action"; duplicate.textContent = "Copy"; duplicate.title = "Duplicate analysis"; duplicate.onclick = async () => { const response = await fetch("/api/sessions/" + encodeURIComponent(item.id) + "/duplicate", { method: "POST" }); const copy = await response.json(); if (!copy.error) { await refreshSessions(); loadSession(copy); } };
      actions.append(pin, duplicate); row.append(open, actions); sessionListEl.append(row);
    });
  } catch (_) {}
}
function openDeliverablePreview() {
  if (!stream) return;
  $("deliverable-preview-modal").hidden = false; const content = $("deliverable-preview-content"); content.replaceChildren();
  const label = document.createElement("span"), preview = document.createElement("pre");
  label.className = "preview-kicker"; label.textContent = "Generated content"; preview.textContent = stream; content.append(label, preview);
}
async function openExistingDeliverablePreview(file) {
  $("source-preview-modal").hidden = false; $("source-preview-title").textContent = file.filename; $("source-preview-meta").textContent = file.size_kb + " KB · generated deliverable";
  const content = $("source-preview-content"); content.replaceChildren();
  const extension = file.filename.split(".").pop().toLowerCase();
  if (["md", "txt"].includes(extension)) {
    const excerpt = document.createElement("pre"); excerpt.textContent = await (await fetch("/outputs/" + encodeURIComponent(file.filename))).text(); content.append(excerpt);
  } else {
    const message = document.createElement("p"); message.textContent = "This format is ready to download. Use Download to open it in its native application."; content.append(message);
  }
}
async function refreshOutputs() {
  try {
    const outputs = await (await fetch("/api/outputs")).json(), list = $("output-list"); list.replaceChildren();
    const visibleOutputs = outputs.filter((file) => !file.filename.startsWith("."));
    if (!visibleOutputs.length) { list.innerHTML = '<p class="empty-state">Generated files will appear here.</p>'; return; }
    visibleOutputs.forEach((file) => {
      const row = document.createElement("div"), meta = document.createElement("div"), name = document.createElement("span"), size = document.createElement("span"), actions = document.createElement("div"), preview = document.createElement("button"), download = document.createElement("a");
      row.className = "output-row"; meta.className = "output-meta"; name.className = "output-name"; size.className = "output-size"; name.textContent = file.filename; size.textContent = file.size_kb + " KB"; meta.append(name, size);
      actions.className = "output-actions"; preview.type = "button"; preview.className = "output-preview-btn"; preview.textContent = "Preview"; preview.onclick = () => openExistingDeliverablePreview(file);
      download.href = "/outputs/" + encodeURIComponent(file.filename); download.textContent = "Download"; actions.append(preview, download); row.append(meta, actions); list.append(row);
    });
  } catch (_) {}
}
async function exportFile(format) {
  if (!stream) return;
  $("export-status").textContent = "Creating deliverable…";
  try {
    const response = await fetch("/api/export-summary", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: lastTaskTitle, content: stream, format }) });
    const data = await response.json(); if (!response.ok || data.error) throw new Error(data.error || "Export failed");
    setPipelineStage("deliver"); $("export-status").textContent = (format === "docx" ? "Word document" : "Markdown file") + " added to Deliverables.";
    await refreshOutputs(); openDocuments(); $("deliverables-section").scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (error) { $("export-status").textContent = "Could not create deliverable: " + error.message; }
}

function currentPage() { return pidData?.pages?.find((page) => page.page === pidPage) || pidData?.pages?.[pidPage - 1]; }
function pidControls() {
  const count = pidData?.pages?.length || 0; $("pid-page-status").textContent = count ? "Page " + pidPage + " of " + count : "Page —";
  $("pid-prev-page-btn").disabled = pidPage <= 1; $("pid-next-page-btn").disabled = pidPage >= count; $("pid-zoom-label").textContent = Math.round(pidZoom * 100) + "%";
}
function zoom(value) {
  pidZoom = Math.max(.25, Math.min(3, value)); pidCanvas.style.transform = "scale(" + pidZoom + ")";
  pidStage.style.width = ((pidImage?.naturalWidth || 0) * pidZoom) + "px"; pidStage.style.height = ((pidImage?.naturalHeight || 0) * pidZoom) + "px"; pidControls();
}
function fit() { if (pidImage) zoom(Math.max(.25, Math.min(1, (pidView.clientWidth - 32) / pidImage.naturalWidth, (pidView.clientHeight - 32) / pidImage.naturalHeight))); }
function overlay(item, className, scaleX, scaleY, text = false) {
  const [left, top, right, bottom] = item.bbox || []; if (![left, top, right, bottom].every(Number.isFinite)) return;
  const query = $("pid-tag-search").value.toLowerCase(), match = query && (String(item.tag || "") + " " + String(item.text || "") + " " + String(item.type || "")).toLowerCase().includes(query);
  const button = document.createElement("button"); button.className = className + (match ? " is-match" : "");
  button.style.left = (left * scaleX) + "px"; button.style.top = (top * scaleY) + "px"; button.style.width = Math.max(2, (right - left) * scaleX) + "px"; button.style.height = Math.max(2, (bottom - top) * scaleY) + "px";
  button.onclick = () => { $("pid-selection-details").innerHTML = `<h3>Selected ${text ? "OCR text" : "equipment"}</h3><dl><dt>${text ? "Text" : "Type"}</dt><dd>${esc(text ? item.text : item.type)}</dd><dt>Tag</dt><dd>${esc(item.tag || item.id)}</dd><dt>Confidence</dt><dd>${Math.round((item.confidence || 0) * 100)}%</dd></dl>`; };
  pidCanvas.append(button);
}
function overlays() {
  pidCanvas.querySelectorAll(".pid-overlay").forEach((item) => item.remove());
  const page = currentPage(); if (!page || !pidImage) return;
  const scaleX = pidImage.naturalWidth / page.width, scaleY = pidImage.naturalHeight / page.height;
  if ($("toggle-symbols-cb").checked) (page.symbols || []).forEach((item) => overlay(item, "pid-overlay pid-symbol-overlay", scaleX, scaleY));
  if ($("toggle-texts-cb").checked) (page.texts || []).forEach((item) => overlay(item, "pid-overlay pid-text-overlay", scaleX, scaleY, true));
}
function showPage() {
  pidCanvas.innerHTML = '<p class="empty-state">Loading drawing…</p>'; pidImage = new Image(); pidImage.src = "/api/pid/" + encodeURIComponent(pidId) + "/page/" + pidPage;
  pidImage.onload = () => { pidCanvas.innerHTML = ""; pidCanvas.style.width = pidImage.naturalWidth + "px"; pidCanvas.style.height = pidImage.naturalHeight + "px"; pidCanvas.append(pidImage); overlays(); fit(); pidControls(); };
}
async function drawing(id) {
  const data = await (await fetch("/api/pid/" + encodeURIComponent(id) + "/data")).json(); if (data.error) return;
  pidId = id; pidData = data; pidPage = 1; $("pid-document-caption").textContent = (data.filename || "Drawing") + " · " + (data.pages?.length || 0) + " pages"; showPage();
}
async function pidList(preferred) {
  try {
    const list = await (await fetch("/api/pid/list")).json(); $("pid-doc-select").replaceChildren(new Option("Select drawing", ""));
    list.forEach((item) => $("pid-doc-select").add(new Option(item.filename + " · " + (item.page_count || 1) + " pages · " + String(item.pid_id).split("_").pop(), item.pid_id)));
    const id = preferred || list[0]?.pid_id; if (id) { $("pid-doc-select").value = id; drawing(id); }
  } catch (_) {}
}
function openPid(preferred) { pidModal.hidden = false; closeDrawers(); pidList(preferred); updateNav("Drawings"); }
async function openPrivacy() {
  const modal = $("privacy-dashboard-modal"); modal.hidden = false;
  try {
    const data = await (await fetch("/api/security/privacy-dashboard")).json();
    $("privacy-mode-state").textContent = data.privacy_status === "LOCAL-ONLY" ? "Configured locally" : data.privacy_status;
    $("privacy-external-attempts").textContent = data.stats.external_attempts || 0; $("privacy-blocked-count").textContent = data.stats.blocked_external_attempts || 0; $("privacy-monitor-state").textContent = data.stats.monitor_active ? "Available" : "Missing";
    $("privacy-startup-checks").innerHTML = data.startup_check.checks.map((check) => `<div class="check-item"><strong class="check-state ${esc(check.state)}">${esc(check.state)}</strong><span><strong>${esc(check.name)}</strong><br>${esc(check.detail)}</span></div>`).join("");
    $("privacy-component-rows").innerHTML = data.components.map((component) => `<tr><td>${esc(component.name)}</td><td>${esc(component.location)}</td><td>${esc(component.status)}</td></tr>`).join("");
    $("privacy-network-logs").innerHTML = (data.activity_log || []).length ? data.activity_log.map((entry) => `<div class="log-entry">${esc(typeof entry === "string" ? entry : JSON.stringify(entry))}</div>`).join("") : '<span class="empty-state">No application socket activity recorded.</span>';
  } catch (_) { $("privacy-network-logs").textContent = "Runtime details could not be loaded."; }
}

function startNewAnalysis() {
  session = "session_" + Date.now(); stream = ""; $("task-input").value = ""; resetWorkflow(); empty(); progress("Ready for a local analysis"); updateNav("Analysis"); closeDrawers(); $("task-input").focus();
}
const commandActions = [
  { label: "New analysis", detail: "Clear the workspace and start fresh", run: startNewAnalysis },
  { label: "Upload source files", detail: "Open the local source-file panel", run: () => { openDocuments(); updateNav("Documents"); $("drop-zone").focus(); } },
  { label: "Upload a drawing", detail: "Choose P&ID processing and add a drawing", run: () => { chooseWorkflow("drawing"); $("mode-select").value = "pid"; openDocuments(); updateNav("Documents"); $("drop-zone").focus(); } },
  { label: "Open drawing inspector", detail: "Review an already processed drawing", run: () => openPid() },
  { label: "Open deliverables", detail: "View generated files for this analysis", run: () => { openDocuments(); updateNav("Deliverables"); $("deliverables-section").scrollIntoView({ behavior: "smooth", block: "nearest" }); } },
  { label: "Focus objective", detail: "Return to the analysis brief", run: () => { closeDrawers(); $("task-form").scrollIntoView({ behavior: "smooth", block: "center" }); $("task-input").focus(); } },
];
function renderCommandList(query = "") {
  const list = $("command-list"), term = query.trim().toLowerCase(); list.replaceChildren();
  commandActions.filter((action) => !term || (action.label + " " + action.detail).toLowerCase().includes(term)).forEach((action) => {
    const button = document.createElement("button"), text = document.createElement("span"), label = document.createElement("strong"), detail = document.createElement("small");
    button.type = "button"; label.textContent = action.label; detail.textContent = action.detail; text.append(label, detail); button.append(text); button.onclick = () => { $("command-palette-modal").hidden = true; action.run(); }; list.append(button);
  });
  if (!list.children.length) { const empty = document.createElement("p"); empty.className = "empty-state"; empty.textContent = "No matching actions."; list.append(empty); }
}
function openCommandPalette() {
  $("command-palette-modal").hidden = false; $("command-search").value = ""; renderCommandList(); $("command-search").focus();
}

$("theme-toggle-btn").onclick = () => setTheme(document.documentElement.classList.contains("dark") ? "light" : "dark");
$("toggle-left-sidebar").onclick = () => toggleDrawer("left");
$("toggle-right-sidebar").onclick = () => toggleDrawer("right");
$("sidebar-scrim").onclick = closeDrawers;
document.querySelectorAll("[data-close-drawer]").forEach((button) => { button.onclick = closeDrawers; });
$("new-chat-btn").onclick = startNewAnalysis;
$("clear-btn").onclick = () => { $("task-input").value = ""; $("task-input").focus(); };
$("jump-latest-btn").onclick = () => { out.scrollTop = out.scrollHeight; $("jump-latest-btn").hidden = true; };
$("copy-answer-btn").onclick = async () => { try { await navigator.clipboard.writeText(stream); $("copy-answer-btn").textContent = "Copied"; setTimeout(() => { $("copy-answer-btn").textContent = "Copy"; }, 1000); } catch (_) {} };
$("export-docx-btn").onclick = openDeliverablePreview; $("export-md-btn").onclick = openDeliverablePreview;
$("close-source-preview-btn").onclick = () => { $("source-preview-modal").hidden = true; }; $("close-deliverable-preview-btn").onclick = () => { $("deliverable-preview-modal").hidden = true; };
$("create-preview-docx-btn").onclick = () => { $("deliverable-preview-modal").hidden = true; exportFile("docx"); }; $("create-preview-md-btn").onclick = () => { $("deliverable-preview-modal").hidden = true; exportFile("md"); };
$("command-search").oninput = () => renderCommandList($("command-search").value);
$("task-form").onsubmit = (event) => {
  event.preventDefault(); const text = $("task-input").value.trim(); if (!text || running) return;
  session ||= "session_" + Date.now(); const sourceFiles = selected().filter((file) => file.state === "ready").map((file) => file.filename);
  const task = sourceFiles.length ? text + "\n\nUse these selected files when relevant: " + sourceFiles.join(", ") + "." : text;
  lastTaskTitle = text.slice(0, 72); stream = "";
  out.innerHTML = '<div class="output-placeholder"><div><span class="output-placeholder__mark" aria-hidden="true">…</span><strong>Preparing local analysis.</strong><span>Your sources remain on this device.</span></div></div>';
  $("answer-actions").hidden = true; $("answer-caption").textContent = "Analysis in progress"; $("export-status").textContent = ""; taskRunning(true); progress("Preparing local model", "is-active"); updateNav("Analysis");
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ task, model: $("model-select").value, session_id: session, source_count: sourceFiles.length })); else { taskRunning(false); progress("Connecting to local backend", "is-error"); }
};
$("stop-btn").onclick = async () => { const result = await (await fetch("/api/tasks/" + encodeURIComponent(session) + "/cancel", { method: "POST" })).json(); if (!result.cancelled) progress(result.message, "is-error"); };
$("drop-zone").onclick = () => $("file-input").click();
$("drop-zone").onkeydown = (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); $("file-input").click(); } };
$("file-input").onchange = () => selectFile($("file-input").files[0]);
$("drop-zone").ondragover = (event) => { event.preventDefault(); $("drop-zone").classList.add("dragover"); };
$("drop-zone").ondragleave = () => $("drop-zone").classList.remove("dragover");
$("drop-zone").ondrop = (event) => { event.preventDefault(); $("drop-zone").classList.remove("dragover"); selectFile(event.dataTransfer.files[0]); };
$("upload-form").onsubmit = (event) => { event.preventDefault(); upload($("file-input").files[0]); };
$("open-pid-viewer-btn").onclick = () => openPid(); $("close-pid-modal-btn").onclick = () => { pidModal.hidden = true; updateNav("Analysis"); };
$("pid-doc-select").onchange = () => drawing($("pid-doc-select").value);
$("pid-prev-page-btn").onclick = () => { if (pidPage > 1) { pidPage--; showPage(); } }; $("pid-next-page-btn").onclick = () => { if (pidPage < (pidData?.pages?.length || 0)) { pidPage++; showPage(); } };
$("pid-zoom-in-btn").onclick = () => zoom(pidZoom + .15); $("pid-zoom-out-btn").onclick = () => zoom(pidZoom - .15); $("pid-fit-btn").onclick = fit; $("toggle-symbols-cb").onchange = overlays; $("toggle-texts-cb").onchange = overlays; $("pid-tag-search").oninput = overlays;
$("open-privacy-dashboard-btn").onclick = openPrivacy; $("close-privacy-modal-btn").onclick = () => { $("privacy-dashboard-modal").hidden = true; };
document.addEventListener("click", (event) => {
  const workflowTarget = event.target.closest("[data-workflow]"); if (workflowTarget) chooseWorkflow(workflowTarget.dataset.workflow);
  const promptTarget = event.target.closest("[data-prompt]"); if (promptTarget) { setPrompt(promptTarget.dataset.prompt); return; }
  if (event.target.closest("[data-open-documents]")) { openDocuments(); updateNav("Documents"); return; }
  if (event.target.closest("[data-start-drawing-upload]")) { $("mode-select").value = "pid"; openDocuments(); updateNav("Documents"); $("drop-zone").focus(); return; }
  if (event.target.closest("[data-open-pid]")) { openPid(); return; }
  if (event.target.closest("[data-open-privacy]")) { openPrivacy(); return; }
  if (event.target.closest("[data-focus-task]")) { updateNav("Analysis"); closeDrawers(); $("task-form").scrollIntoView({ behavior: "smooth", block: "center" }); return; }
  if (event.target.closest("[data-focus-deliverables]")) { openDocuments(); updateNav("Deliverables"); $("deliverables-section").scrollIntoView({ behavior: "smooth", block: "nearest" }); }
});
window.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); openCommandPalette(); return; }
  if (event.key === "Escape") { closeDrawers(); pidModal.hidden = true; $("privacy-dashboard-modal").hidden = true; $("source-preview-modal").hidden = true; $("deliverable-preview-modal").hidden = true; $("command-palette-modal").hidden = true; }
});
setTheme(document.documentElement.classList.contains("dark") ? "dark" : "light");
window.steps = 0; empty(); suggestions(); renderModelOptions(); updateModelDescription(); setPipelineStage("device"); wireWorkflowDropzones(); status(); uploads(); refreshSessions(); refreshOutputs(); connect(); setInterval(status, 8000);
