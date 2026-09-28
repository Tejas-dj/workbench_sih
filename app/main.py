"""
main.py
-------
FastAPI app tying everything together:
  GET  /                      -> UI
  GET  /api/status            -> Ollama health + registered & discovered models
  GET  /api/sessions          -> list saved chat sessions
  GET  /api/sessions/{id}     -> load full session details
  DELETE /api/sessions/{id}   -> delete a session
  POST /api/upload            -> save an uploaded file into the workspace
  POST /api/ingest            -> OCR/extract + chunk + embed a file into RAG
  POST /api/pid/ingest        -> process P&ID drawing (OCR + symbols + lines + NetworkX graph)
  GET  /api/pid/list          -> list processed P&ID documents
  GET  /api/pid/{pid_id}/data -> get canonical JSON & highlights for P&ID viewer
  GET  /api/pid/{pid_id}/page/{page_num} -> serve high-res rendered P&ID image page
  POST /api/export-summary    -> generate & save summary report for download (.docx, .md, .txt)
  WS   /ws/agent              -> submit a task, stream agent steps live, auto-save session
  GET  /api/outputs           -> list generated deliverables
  GET  /outputs/{filename}    -> download a generated deliverable

Run with:  uvicorn app.main:app --reload --port 8000
"""

import asyncio
import json
import shutil
import time
from pathlib import Path

from fastapi import FastAPI, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from app.agent import run_agent
from app.ingestion.ocr import ingest_document
from app.knowledge.connector import local_knowledge_connector
from app.ollama_client import ollama
from app.pid.pipeline import PID_DATA_DIR, process_pid_document
from app.rag.chunker import chunk_text
from app.rag.vector_store import add_chunks, collection_stats
from app.router import router
from app.security.audit_log import audit_logger
from app.security.component_registry import component_registry
from app.security.network_monitor import network_monitor
from app.security.security_policy import security_policy
from app.security.startup_check import startup_checker
from app.sessions import delete_session, duplicate_session, get_session, list_sessions, save_session, set_session_pinned

BASE_DIR = Path(__file__).parent.parent
UPLOAD_DIR = BASE_DIR / "data" / "uploads"
OUTPUT_DIR = BASE_DIR / "data" / "outputs"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
active_agent_tasks: dict[str, asyncio.Task] = {}

app = FastAPI(title="Local AI Workbench")
app.mount("/static", StaticFiles(directory=str(BASE_DIR / "app" / "static")), name="static")


@app.on_event("startup")
async def startup_event():
    network_monitor.start_monitoring()
    startup_checker.run_check()


@app.get("/", response_class=HTMLResponse)
async def index():
    html_path = BASE_DIR / "app" / "templates" / "index.html"
    return HTMLResponse(html_path.read_text(encoding="utf-8"))


def _tag_matches(registered_name: str, local_models: list[str]) -> bool:
    normalized = registered_name if ":" in registered_name else f"{registered_name}:latest"
    return registered_name in local_models or normalized in local_models


@app.get("/api/status")
async def status():
    healthy = await ollama.health()
    local_models = await ollama.list_local_models() if healthy else []
    embedding_available = any(_tag_matches("nomic-embed-text:latest", [model]) for model in local_models)
    
    registered = []
    for m in router.models:
        pulled = _tag_matches(m.name, local_models)
        registered.append({
            "display_name": m.display_name,
            "name": m.name,
            "role": m.role,
            "capabilities": m.capabilities,
            "vram_gb": m.vram_gb,
            "pulled": pulled,
        })

    for local in local_models:
        if not any(_tag_matches(r["name"], [local]) for r in registered):
            display_name = local.split(":")[0].replace("-", " ").replace("_", " ").title()
            registered.append({
                "display_name": f"{display_name} (Local)",
                "name": local,
                "role": "chat",
                "capabilities": ["general", "reasoning"],
                "vram_gb": 4.0,
                "pulled": True,
            })

    return {
        "ollama_running": healthy,
        "registered_models": registered,
        "rag_stats": collection_stats(),
        "runtime": {
            "ollama_state": "available" if healthy else "missing",
            "embedding_state": "available" if embedding_available else "missing",
        },
    }


@app.get("/api/sessions")
async def get_all_sessions():
    return list_sessions()


@app.get("/api/sessions/{session_id}")
async def get_session_by_id(session_id: str):
    sess = get_session(session_id)
    if not sess:
        return {"error": "Session not found"}
    return sess


@app.delete("/api/sessions/{session_id}")
async def delete_session_by_id(session_id: str):
    success = delete_session(session_id)
    return {"success": success}


class SessionPinRequest(BaseModel):
    pinned: bool


@app.post("/api/sessions/{session_id}/pin")
async def pin_session(session_id: str, request: SessionPinRequest):
    updated = set_session_pinned(session_id, request.pinned)
    return updated or {"error": "Session not found"}


@app.post("/api/sessions/{session_id}/duplicate")
async def duplicate_saved_session(session_id: str):
    duplicate = duplicate_session(session_id)
    return duplicate or {"error": "Session not found"}


@app.post("/api/upload")
async def upload(file: UploadFile):
    dest = UPLOAD_DIR / file.filename
    try:
        with dest.open("wb") as f:
            shutil.copyfileobj(file.file, f)
    except PermissionError:
        # File is locked by Word or another process, try saving to fallback target
        dest = UPLOAD_DIR / f"uploaded_{file.filename}"
        with dest.open("wb") as f:
            shutil.copyfileobj(file.file, f)

    return {"saved_to": f"uploads/{dest.name}", "filename": dest.name}


@app.get("/api/uploads")
async def list_uploads():
    files = sorted((f for f in UPLOAD_DIR.iterdir() if f.is_file() and not f.name.startswith(".")), key=lambda f: f.stat().st_mtime, reverse=True)
    return [
        {"filename": f.name, "extension": f.suffix.lower().lstrip("."), "size_kb": round(f.stat().st_size / 1024, 1)}
        for f in files
    ]


@app.post("/api/ingest")
async def ingest(filename: str, mode: str | None = None):
    clean_name = filename.replace("~$", "") if filename.startswith("~$") else filename
    file_path = UPLOAD_DIR / clean_name
    if not file_path.exists():
        file_path = BASE_DIR / "data" / clean_name
    if not file_path.exists():
        file_path = UPLOAD_DIR / filename
    if not file_path.exists():
        file_path = BASE_DIR / "data" / filename
    if not file_path.exists():
        return {"error": f"File not found: {filename}"}

    try:
        result = await ingest_document(str(file_path), mode=mode)
        chunks, metadatas, ids = chunk_text(result["text"], source_name=result["source"])
        if chunks:
            await add_chunks(chunks, metadatas, ids)

        return {
            "source": result["source"],
            "method": result["method"],
            "chunks_indexed": len(chunks),
            "preview": result["text"][:500],
        }
    except Exception as e:
        return {"error": f"Ingestion failed for {filename}: {e}"}


# ---------------- P&ID Intelligence REST Endpoints ----------------

@app.post("/api/pid/ingest")
async def pid_ingest(filename: str, dpi: int = 300):
    clean_name = filename.replace("~$", "") if filename.startswith("~$") else filename
    file_path = UPLOAD_DIR / clean_name
    if not file_path.exists():
        file_path = BASE_DIR / "data" / clean_name
    if not file_path.exists():
        file_path = UPLOAD_DIR / filename
    if not file_path.exists():
        file_path = BASE_DIR / "data" / filename
    if not file_path.exists():
        return {"error": f"P&ID file not found: {filename}"}

    try:
        meta = await process_pid_document(str(file_path), dpi=dpi)
        
        # 1. Index extracted P&ID detections into RAG vector DB
        try:
            det_path = Path(meta["artifact_dir"]) / "detections.json"
            if det_path.exists():
                det_text = det_path.read_text(encoding="utf-8")
                chunks, metadatas, ids = chunk_text(det_text, source_name=meta["filename"])
                if chunks:
                    await add_chunks(chunks, metadatas, ids)
        except Exception as e:
            print(f"[P&ID Ingest Warning] Failed to index detections to RAG: {e}")

        # 2. Index full document OCR text into RAG vector DB
        try:
            doc_res = await ingest_document(str(file_path))
            if doc_res.get("text"):
                d_chunks, d_metas, d_ids = chunk_text(doc_res["text"], source_name=meta["filename"])
                if d_chunks:
                    await add_chunks(d_chunks, d_metas, d_ids)
        except Exception as e:
            print(f"[P&ID Ingest Warning] Failed to index OCR text to RAG: {e}")

        return meta
    except Exception as e:
        return {"error": f"P&ID processing failed for {filename}: {e}"}


@app.get("/api/pid/list")
async def list_pids():
    items = []
    for meta_file in PID_DATA_DIR.glob("*/metadata.json"):
        try:
            with open(meta_file, "r", encoding="utf-8") as f:
                items.append(json.load(f))
        except Exception:
            continue
    items.sort(key=lambda x: x.get("pid_id", ""), reverse=True)
    return items


@app.get("/api/pid/{pid_id}/data")
async def get_pid_data(pid_id: str):
    art_dir = PID_DATA_DIR / pid_id
    det_file = art_dir / "detections.json"
    if not det_file.exists():
        return {"error": "P&ID data not found"}
    with open(det_file, "r", encoding="utf-8") as f:
        return json.load(f)


@app.get("/api/pid/{pid_id}/page/{page_num}")
async def get_pid_page_image(pid_id: str, page_num: int = 1):
    art_dir = PID_DATA_DIR / pid_id
    pages_dir = art_dir / "pages"
    if not pages_dir.exists():
        return {"error": "Image page not found"}

    exact_matches = list(pages_dir.glob(f"*_page_{page_num}.png"))
    if exact_matches:
        return FileResponse(str(exact_matches[0]))

    img_files = sorted(list(pages_dir.glob("*.png")), key=lambda p: p.name)
    if not img_files:
        return {"error": "Image page not found"}
    if 1 <= page_num <= len(img_files):
        return FileResponse(str(img_files[page_num - 1]))
    return FileResponse(str(img_files[0]))


class SummaryExportRequest(BaseModel):
    title: str = "Summary Report"
    content: str
    format: str = "docx"


@app.post("/api/export-summary")
async def export_summary(req: SummaryExportRequest):
    timestamp = int(time.time())
    safe_title = "".join(c for c in req.title if c.isalnum() or c in (" ", "_", "-")).strip().replace(" ", "_")
    if not safe_title:
        safe_title = "Summary_Report"

    if req.format == "docx":
        from app.outputs.docx_writer import build_report
        filename = f"{safe_title}_{timestamp}.docx"
        sections = []
        paras = req.content.split("\n\n")
        current_heading = "Executive Summary"
        current_body = []
        for p in paras:
            p_strip = p.strip()
            if p_strip.startswith("#") or p_strip.startswith("###") or p_strip.startswith("##"):
                if current_body:
                    sections.append({"heading": current_heading, "body": "\n\n".join(current_body)})
                    current_body = []
                current_heading = p_strip.lstrip("#").strip()
            else:
                current_body.append(p_strip)
        if current_body:
            sections.append({"heading": current_heading, "body": "\n\n".join(current_body)})
        if not sections:
            sections = [{"heading": "Summary Analysis", "body": req.content}]

        path = build_report(title=req.title, sections=sections, filename=filename)
        return {"filename": filename, "url": f"/outputs/{filename}"}

    elif req.format == "md":
        filename = f"{safe_title}_{timestamp}.md"
        out_path = OUTPUT_DIR / filename
        out_path.write_text(f"# {req.title}\n\n{req.content}", encoding="utf-8")
        return {"filename": filename, "url": f"/outputs/{filename}"}

    else:
        filename = f"{safe_title}_{timestamp}.txt"
        out_path = OUTPUT_DIR / filename
        out_path.write_text(f"{req.title}\n{'=' * len(req.title)}\n\n{req.content}", encoding="utf-8")
        return {"filename": filename, "url": f"/outputs/{filename}"}


@app.get("/api/outputs")
async def list_outputs():
    files = sorted(OUTPUT_DIR.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True)
    return [{"filename": f.name, "size_kb": round(f.stat().st_size / 1024, 1)} for f in files if f.is_file()]


@app.get("/outputs/{filename}")
async def download_output(filename: str):
    path = OUTPUT_DIR / filename
    if not path.exists():
        return {"error": "not found"}
    return FileResponse(str(path), filename=filename)


async def _run_agent_task(websocket: WebSocket, task: str, selected_model: str, session_id: str, source_count: int = 0):
    accumulated_output = []
    trace_logs = []
    deliverables = []
    save_session(session_id, {"task": task, "model": selected_model, "source_count": source_count, "output": "Processing task...", "trace_logs": [], "deliverables": []})
    try:
        async for event in run_agent(task, selected_model=selected_model):
            await websocket.send_json({**event, "session_id": session_id})
            event_type = event.get("type")
            if event_type == "stream_chunk" and event.get("chunk"):
                accumulated_output.append(event["chunk"])
            elif event_type in ("routing", "thinking", "tool_call", "tool_result"):
                trace_logs.append(event)
                args = event.get("args", {})
                if event_type == "tool_call" and isinstance(args, dict) and args.get("filename"):
                    deliverables.append(args["filename"])
            elif event_type in ("final", "error"):
                save_session(session_id, {"task": task, "model": selected_model, "source_count": source_count, "output": "".join(accumulated_output) or event.get("content", ""), "trace_logs": trace_logs, "deliverables": deliverables})
    except asyncio.CancelledError:
        message = "Task stopped by the user."
        save_session(session_id, {"task": task, "model": selected_model, "source_count": source_count, "output": "".join(accumulated_output) or message, "trace_logs": trace_logs, "deliverables": deliverables})
        try:
            await websocket.send_json({"type": "cancelled", "content": message, "session_id": session_id})
        except Exception:
            pass
        raise
    finally:
        active_agent_tasks.pop(session_id, None)


@app.post("/api/tasks/{session_id}/cancel")
async def cancel_task(session_id: str):
    task = active_agent_tasks.get(session_id)
    if not task or task.done():
        return {"cancelled": False, "message": "No active task found."}
    task.cancel()
    return {"cancelled": True, "message": "Cancellation requested."}


@app.websocket("/ws/agent")
async def agent_ws(websocket: WebSocket):
    await websocket.accept()
    try:
        while True:
            data = await websocket.receive_json()
            task = data.get("task", "").strip()
            selected_model = data.get("model", "auto")
            session_id = data.get("session_id") or f"session_{int(time.time()*1000)}"
            if not task:
                continue
            source_count = int(data.get("source_count", 0) or 0)
            workflow = asyncio.create_task(_run_agent_task(websocket, task, selected_model, session_id, source_count))
            active_agent_tasks[session_id] = workflow
            try:
                await workflow
            except asyncio.CancelledError:
                continue
    except WebSocketDisconnect:
        for task in list(active_agent_tasks.values()):
            task.cancel()


# ---------------- Security & Privacy REST Endpoints ----------------

@app.get("/api/security/privacy-dashboard")
async def get_privacy_dashboard():
    stats = network_monitor.get_summary_stats()
    ollama_available = await ollama.health()
    local_models = await ollama.list_local_models() if ollama_available else []
    embedding_available = any(_tag_matches("nomic-embed-text:latest", [model]) for model in local_models)
    startup = startup_checker.run_check({
        "ollama_state": "available" if ollama_available else "missing",
        "embedding_state": "available" if embedding_available else "missing",
    })
    components = component_registry.list_components({
        "ollama_llm": "AVAILABLE" if ollama_available else "MISSING",
        "ollama_embed": "AVAILABLE" if embedding_available else "MISSING",
        "tesseract_ocr": "AVAILABLE" if startup["ocr_local"] else "MISSING",
        "chromadb_local": "VERIFIED" if startup["vector_store_local"] else "CONFIGURED",
        "fastapi_frontend": "AVAILABLE",
        "fastapi_backend": "AVAILABLE",
    })
    activity = network_monitor.get_activity_log(limit=15)
    return {
        "privacy_status": "LOCAL-ONLY",
        "stats": stats,
        "startup_check": startup,
        "components": components,
        "activity_log": activity,
    }


@app.get("/api/security/audit-log")
async def get_security_audit_log(limit: int = 50):
    return audit_logger.get_recent_logs(limit=limit)


@app.get("/api/security/demo-mode")
async def get_security_demo_mode():
    stats = network_monitor.get_summary_stats()
    return {
        "current_mode": "LOCAL-ONLY",
        "external_connections": stats["external_network_calls"],
        "blocked_external_attempts": stats["blocked_external_attempts"],
        "monitored_processes": stats["monitored_processes"],
        "local_services": stats["local_services_count"],
        "last_security_event": "None" if not stats["blocked_external_attempts"] else "Blocked External Network Attempt",
        "live_event_stream": network_monitor.get_activity_log(limit=10),
    }


# ---------------- Knowledge Base REST Endpoints ----------------

class KnowledgeIngestRequest(BaseModel):
    filename: str
    document_id: str | None = None
    document_name: str | None = None
    revision: str = "1.0"
    source_type: str = "SOP"
    department: str = "Engineering"
    author: str = "Internal"
    date: str = ""
    access_scope: list[str] = ["all"]
    tags: list[str] = []
    equipment_tags: list[str] = []


@app.post("/api/knowledge/ingest")
async def knowledge_ingest(req: KnowledgeIngestRequest):
    file_path = UPLOAD_DIR / req.filename
    if not file_path.exists():
        file_path = BASE_DIR / "data" / req.filename
    if not file_path.exists():
        return {"error": f"Document not found: {req.filename}"}

    meta = {
        "document_id": req.document_id,
        "document_name": req.document_name,
        "revision": req.revision,
        "source_type": req.source_type,
        "department": req.department,
        "author": req.author,
        "date": req.date,
        "access_scope": req.access_scope,
        "tags": req.tags,
        "equipment_tags": req.equipment_tags,
    }
    try:
        res = await local_knowledge_connector.ingest_organizational_document(str(file_path), custom_metadata=meta)
        return res
    except Exception as e:
        return {"error": f"Knowledge ingestion failed: {e}"}


@app.post("/api/knowledge/correspondence")
async def knowledge_correspondence_ingest(filename: str):
    file_path = UPLOAD_DIR / filename
    if not file_path.exists():
        file_path = BASE_DIR / "data" / filename
    if not file_path.exists():
        return {"error": f"Correspondence file not found: {filename}"}

    try:
        res = await local_knowledge_connector.ingest_correspondence_file(str(file_path))
        return {"filename": filename, "items_ingested": len(res), "details": res}
    except Exception as e:
        return {"error": f"Correspondence ingestion failed: {e}"}


@app.get("/api/knowledge/documents")
async def list_knowledge_documents():
    return list(local_knowledge_connector.documents.values())


@app.get("/api/knowledge/search")
async def search_knowledge(q: str, top_k: int = 5, scope: str = "all"):
    scopes = [s.strip() for s in scope.split(",") if s.strip()]
    results = await local_knowledge_connector.search(query=q, top_k=top_k, user_scopes=scopes)
    return results

