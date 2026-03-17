from typing import Any, Optional
from uuid import uuid4
import re
import os
import io
import zipfile
import csv as _csv

import bcrypt as _bcrypt_lib

from fastapi import Depends, FastAPI, File, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from cosmos_IO import CosmosConnectionError, CosmosIO


# ── Shared doc helpers ────────────────────────────────────────────────────────

def _pick(doc: dict, *keys: str, default: Any = "") -> Any:
    """Return the first truthy value found in doc for the given keys."""
    for k in keys:
        v = doc.get(k)
        if v is not None:
            return v
    return default


def _is_active(doc: dict) -> bool:
    return bool(doc.get("isActive", doc.get("is_active", False)))


app = FastAPI(title="Marketplace Admin API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(CosmosConnectionError)
async def cosmos_connection_error_handler(_, exc: CosmosConnectionError):
    return JSONResponse(
        status_code=503,
        content={
            "detail": str(exc),
            "errorType": "COSMOS_CONNECTION_ERROR",
        },
    )


cosmos = CosmosIO()


def _hash_password(plain: str) -> str:
    return _bcrypt_lib.hashpw(plain.encode("utf-8"), _bcrypt_lib.gensalt()).decode("utf-8")


def _verify_password(plain: str, hashed: str) -> bool:
    try:
        return _bcrypt_lib.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))
    except Exception:
        return False

CAT_BRAND         = "brand_guidelines"
CAT_PROMPT        = "prompts"
CAT_TEMPLATE      = "templates"
CAT_SETTINGS      = "settings"
CAT_SYSTEM_PROMPT = "system_prompt"
USERS_COL         = "users"   # shared, not tenant-scoped

# ── Shared flight_operations collections (db_name=None → COSMOS_DB_NAME) ─────
CAT_TENANT_AGENT_SETTINGS = "tenant_agent_settings"  # agent selection per tenant

# ── API key mapping: component id ↔ DB field name ────────────────────────────
DB_KEY_MAP = {
    "airline":    "Airline_api",
    "cdp":        "Cdp_Api",
    "disruption": "Disruption_Api",
}
DB_KEY_REVERSE = {v: k for k, v in DB_KEY_MAP.items()}

API_META = {
    "airline":    {"name": "Airline API",    "desc": "Flight search and seat map data for recovery flow",   "dot": "purple"},
    "cdp":        {"name": "CDP API",        "desc": "Customer Data Platform for passenger profile lookup", "dot": "green"},
    "disruption": {"name": "Disruption API", "desc": "Flight disruption events lookup by PNR",              "dot": "yellow"},
}


def _clean_db_name(company_name: str) -> str:
    """Turn 'Indigo Airlines' -> 'indigo_airlines_data' (safe MongoDB DB name)."""
    clean = re.sub(r'[^a-z0-9]+', '_', company_name.lower().strip()).strip('_')
    return f"{clean}_data"


def require_db(x_db_name: str | None = Header(default=None)) -> str:
    """Read tenant DB from header, with env fallback for single-tenant/local runs."""
    fallback = os.getenv("COSMOS_DB_NAME", "")
    db_name = (x_db_name or fallback).strip()
    if not db_name:
        raise HTTPException(status_code=400, detail="Missing X-DB-Name header and COSMOS_DB_NAME is not set")
    return db_name


def require_tenant(x_tenant_id: str | None = Header(default=None)) -> str:
    """Read tenant ID from request header."""
    return (x_tenant_id or "").strip()



DEFAULT_SETTINGS = {
    "isActive":       True,
    "Airline_api":    {"baseUrl": "", "apiKey": "", "isActive": True},
    "Cdp_Api":        {"baseUrl": "", "apiKey": "", "isActive": True},
    "Disruption_Api": {"baseUrl": "", "apiKey": "", "isActive": True},
}


class RegisterIn(BaseModel):
    companyName: str
    email: str
    password: str


class LoginIn(BaseModel):
    email: str
    password: str


class BrandGuidelineIn(BaseModel):
    name: str
    size: str
    fileType: str = "zip"
    isActive: bool = True
    content: Optional[Any] = None


class PromptIn(BaseModel):
    title: str = Field(min_length=1)
    systemPrompt: str = ""
    content: str = Field(min_length=1)
    isActive: bool = True


class TemplateIn(BaseModel):
    name: str
    size: str
    type: str = "sms"
    isActive: bool = True
    content: Optional[Any] = None


class ApiConfigItem(BaseModel):
    id: str
    name: str
    desc: str
    dot: str
    baseUrl: str = ""
    apiKey: str = ""
    isActive: bool = True


class SettingsIn(BaseModel):
    apis: list[ApiConfigItem]


class AgentSettingsIn(BaseModel):
    recoveryAgent: str
    messagingAgent: str
    recoveryAgentActive: bool = True
    messagingAgentActive: bool = True


# ── Document normalisers (DB → frontend shape) ───────────────────────────────

def _normalize_brand(doc: dict) -> dict:
    return {
        "id":            doc.get("id"),
        "isActive":      _is_active(doc),
        "name":          _pick(doc, "name", "filename", default="Untitled"),
        "filename":      _pick(doc, "filename", "name", default="Untitled"),
        "size":          doc.get("size") or "",
        "fileType":      _pick(doc, "fileType", "file_type", default="zip"),
        "content":       doc.get("content"),
        "sourceArchive": doc.get("sourceArchive") or doc.get("source_archive"),
        "uploadedAt":    doc.get("uploadedAt") or doc.get("createdAt"),
    }


def _normalize_prompt(doc: dict) -> dict:
    return {"id": doc.get("id"), "isActive": _is_active(doc),
            "title":        _pick(doc, "title",        "name",         default="Untitled"),
            "systemPrompt": _pick(doc, "systemPrompt", "system_prompt"),
            "content":      _pick(doc, "content",      "user_prompt",  "text")}


def _normalize_template(doc: dict) -> dict:
    return {"id": doc.get("id"), "isActive": _is_active(doc),
            "name":    _pick(doc, "name", "filename", default="Untitled"),
            "size":    doc.get("size") or "",
            "type":    _pick(doc, "type", "template_type", default="sms"),
            "content": doc.get("content")}


def _flat_to_apis(doc: dict) -> list[dict]:
    """Convert flat DB keys (Airline_api / Cdp_Api / Disruption_Api) → frontend apis array."""
    apis = []
    for db_key, comp_id in DB_KEY_REVERSE.items():
        obj = doc.get(db_key)
        if obj and isinstance(obj, dict):
            apis.append({
                "id":       comp_id,
                **API_META[comp_id],
                "baseUrl":  obj.get("baseUrl",  obj.get("base_url",  "")),
                "apiKey":   obj.get("apiKey",   obj.get("api_key",   "")),
                "isActive": obj.get("isActive", obj.get("is_active", True)),
            })
    # Fall back to stored apis array (legacy) or defaults if flat keys absent
    if not apis:
        apis = doc.get("apis") 
    return apis


def _normalize_settings(doc: dict | None, tenant_id: str = "") -> dict:
    d = doc or {}
    result = {
        "id":                  tenant_id or d.get("id", ""),
        "tenantId":            tenant_id or d.get("tenantId", ""),
        "isActive":            True,
        "apis":                _flat_to_apis(d),
        "recoveryAgent":       _pick(d, "recoveryAgent",       "recovery_agent",       default="Select Agent"),
        "messagingAgent":      _pick(d, "messagingAgent",      "messaging_agent",      default="Select Agent"),
        "recoveryAgentActive": bool(d.get("recoveryAgentActive", d.get("recovery_agent_active", True))),
        "messagingAgentActive":bool(d.get("messagingAgentActive",d.get("messaging_agent_active",True))),
    }
    return result



def ensure_settings(db_name: str, tenant_id: str = "") -> dict:
    # Settings doc is keyed by tenantId
    settings_id = tenant_id or "default"
    doc = cosmos.get_item(CAT_SETTINGS, settings_id, db_name=db_name)
    if not doc:
        cosmos.ensure_tenant_collections(db_name)
        initial = {**DEFAULT_SETTINGS, "id": settings_id, "tenantId": settings_id}
        doc = cosmos.upsert_item(CAT_SETTINGS, initial, db_name=db_name)
    # Overlay agent selections from shared flight_operations if present
    if tenant_id:
        agent_doc = cosmos.get_item(CAT_TENANT_AGENT_SETTINGS, tenant_id, db_name=None)
        if agent_doc:
            doc = {**doc,
                   "recoveryAgent":        agent_doc.get("recoveryAgent",        doc.get("recoveryAgent",        "Select Agent")),
                   "messagingAgent":       agent_doc.get("messagingAgent",       doc.get("messagingAgent",       "Select Agent")),
                   "recoveryAgentActive":  agent_doc.get("recoveryAgentActive",  doc.get("recoveryAgentActive",  True)),
                   "messagingAgentActive": agent_doc.get("messagingAgentActive", doc.get("messagingAgentActive", True))}
    return _normalize_settings(doc, tenant_id)


def get_fixed_system_prompt(_db_name: str | None = None) -> str:
    """Always fetch from the shared flight_operations DB (COSMOS_DB_NAME), regardless of tenant."""
    docs = cosmos.list_items(CAT_SYSTEM_PROMPT, db_name=None)
    if not docs:
        return ""
    active_doc = next(
        (d for d in docs if bool(d.get("is_active", d.get("isActive", False)))),
        docs[0],
    )
    return _pick(active_doc, "system_prompt", "systemPrompt", "text", default="")


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/auth/register")
def register(payload: RegisterIn) -> dict:
    email = payload.email.lower().strip()
    if cosmos.find_one_by_field(USERS_COL, "email", email):
        raise HTTPException(status_code=400, detail="Email already registered")
    tenant_id = str(uuid4()).replace("-", "")[:16]
    db_name   = _clean_db_name(payload.companyName)
    user_doc  = {
        "id":           str(uuid4()),
        "email":        email,
        "companyName":  payload.companyName.strip(),
        "tenantId":     tenant_id,
        "dbName":       db_name,
        "passwordHash": _hash_password(payload.password),
    }
    cosmos.upsert_item(USERS_COL, user_doc)
    # Eagerly provision all collections for this new tenant so CosmosDB doesn't
    # reject update_many / find operations on a brand-new empty database.
    ensure_settings(db_name, tenant_id)
    return {"tenantId": tenant_id, "email": user_doc["email"], "companyName": user_doc["companyName"], "dbName": db_name}


@app.post("/api/auth/login")
def login(payload: LoginIn) -> dict:
    email = payload.email.lower().strip()
    user  = cosmos.find_one_by_field(USERS_COL, "email", email)
    if not user or not _verify_password(payload.password, user.get("passwordHash", "")):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    tenant_id = user["tenantId"]
    # Mark this tenant as active in the shared flight_operations agent settings
    existing = cosmos.get_item(CAT_TENANT_AGENT_SETTINGS, tenant_id, db_name=None)
    if existing:
        cosmos.upsert_item(CAT_TENANT_AGENT_SETTINGS, {**existing, "isActive": True}, db_name=None)
    return {"tenantId": tenant_id, "email": user["email"], "companyName": user["companyName"], "dbName": user["dbName"]}


class LogoutIn(BaseModel):
    tenantId: str


@app.post("/api/auth/logout")
def logout(payload: LogoutIn) -> dict:
    tenant_id = payload.tenantId.strip()
    if not tenant_id:
        raise HTTPException(status_code=400, detail="tenantId is required")
    # Mark this tenant inactive in shared flight_operations agent settings
    existing = cosmos.get_item(CAT_TENANT_AGENT_SETTINGS, tenant_id, db_name=None)
    if existing:
        cosmos.upsert_item(CAT_TENANT_AGENT_SETTINGS, {**existing, "isActive": False}, db_name=None)
    return {"loggedOut": True}


@app.get("/api/system-prompt")
def read_system_prompt(db_name: str = Depends(require_db)) -> dict[str, str]:
    return {"systemPrompt": get_fixed_system_prompt()}


# ── Alias helper (frontend-key → db-key sync on writes) ──────────────────────

_PROMPT_ALIASES   = {"title": "name", "content": "user_prompt", "isActive": "is_active"}
_TEMPLATE_ALIASES = {"name": "filename", "type": "file_type",   "isActive": "is_active"}

def _apply_aliases(updates: dict, alias_map: dict) -> dict:
    out = updates.copy()
    for src, dst in alias_map.items():
        if src in out:
            out[dst] = out[src]
    return out


# ── Reusable CRUD factory ─────────────────────────────────────────────────────

def _delete_or_404(col: str, item_id: str, label: str, db_name: str | None = None) -> dict:
    if not cosmos.delete_item(col, item_id, db_name=db_name):
        raise HTTPException(status_code=404, detail=f"{label} not found")
    return {"deleted": True}


def _update_or_404(col: str, item_id: str, updates: dict, normalizer, label: str, db_name: str | None = None) -> dict:
    doc = cosmos.patch_item(col, item_id, updates, db_name=db_name)
    if not doc:
        raise HTTPException(status_code=404, detail=f"{label} not found")
    return normalizer(doc)


def _ensure_single_active(col: str, docs: list[dict], db_name: str | None = None) -> list[dict]:
    active_docs = [doc for doc in docs if _is_active(doc)]
    if len(active_docs) <= 1:
        return docs
    for doc in active_docs[1:]:
        item_id = doc.get("id")
        if item_id:
            cosmos.patch_item(col, item_id, {"isActive": False, "is_active": False}, db_name=db_name)
    return cosmos.list_items(col, db_name=db_name)


def _find_agent_doc_by_ref(agent_ref: str, db_name: str | None = None) -> dict | None:
    if not agent_ref or agent_ref == "Select Agent":
        return None
    for doc in cosmos.list_items("agents", db_name=db_name):
        if agent_ref in {
            str(doc.get("id") or ""),
            str(doc.get("agent_id") or ""),
            str(doc.get("assistant_id") or ""),
        }:
            return doc
    return None


def _resolve_agent_label(agent_ref: str, db_name: str | None = None) -> str:
    doc = _find_agent_doc_by_ref(agent_ref, db_name=db_name)
    if not doc:
        return agent_ref
    return doc.get("name") or doc.get("agent_id") or doc.get("id") or agent_ref


def _sync_selected_agent_status(agent_ref: str, is_active: bool, db_name: str | None = None) -> None:
    doc = _find_agent_doc_by_ref(agent_ref, db_name=db_name)
    if not doc:
        return
    item_id = doc.get("id")
    if not item_id:
        return
    cosmos.patch_item(
        "agents",
        item_id,
        {"isActive": is_active, "is_active": is_active},
        db_name=db_name,
    )


# ── Agents ──────────────────────────────────────────────────────────────────

@app.get("/api/agents")
def list_agents(db_name: str = Depends(require_db)) -> list[dict]:
    docs = cosmos.list_items("agents", db_name=db_name)
    result: list[dict] = []
    for d in docs:
        agent_id = d.get("agent_id") or d.get("id") or d.get("assistant_id")
        if not agent_id:
            continue
        result.append(
            {
                "id": str(agent_id),
                "name": d.get("name") or str(agent_id),
                "description": d.get("description") or "",
                "category": str(d.get("category") or "").strip().lower(),
                "isActive": bool(d.get("is_active", d.get("isActive", False))),
            }
        )
    return result


# ── Brand Guidelines ──────────────────────────────────────────────────────────

_EXTRACTABLE_EXTENSIONS = {".txt", ".json", ".md", ".csv", ".xml", ".yaml", ".yml"}


def _parse_zip_file_content(text: str, ext: str) -> dict:
    """Parse extracted file text into a JSON-serialisable dict."""
    try:
        if ext == ".json":
            import json as _json
            return _json.loads(text)
        elif ext == ".csv":
            reader = _csv.DictReader(io.StringIO(text))
            return {"rows": list(reader)}
        elif ext in (".yaml", ".yml"):
            try:
                import yaml
                parsed = yaml.safe_load(text)
                return parsed if isinstance(parsed, dict) else {"data": parsed}
            except ImportError:
                return {"raw_content": text}
        elif ext == ".xml":
            return {"xml_content": text}
        else:
            return {"text": text}
    except Exception as exc:
        return {"raw_content": text, "parse_error": str(exc)}


def _extract_zip_and_save(file_bytes: bytes, archive_filename: str, db_name: str) -> list[dict]:
    """Extract a ZIP archive and persist each supported file as a brand-guideline doc."""
    saved: list[dict] = []
    try:
        zf_buf = io.BytesIO(file_bytes)
        with zipfile.ZipFile(zf_buf, "r") as zf:
            for entry in zf.namelist():
                if entry.endswith("/"):        # skip directories
                    continue
                ext = os.path.splitext(entry)[1].lower()
                if ext not in _EXTRACTABLE_EXTENSIONS:
                    continue
                fname = os.path.basename(entry)
                try:
                    raw = zf.read(entry)
                    text = raw.decode("utf-8", errors="replace")
                except Exception:
                    continue
                parsed = _parse_zip_file_content(text, ext)
                size_str = f"{len(raw) / 1024:.1f} KB"
                is_first = len(saved) == 0
                new_id = str(uuid4())
                if is_first:
                    cosmos.deactivate_others(CAT_BRAND, new_id, db_name=db_name)
                doc = {
                    "id":            new_id,
                    "name":          fname,
                    "filename":      fname,
                    "fileType":      ext,
                    "size":          size_str,
                    "content":       parsed,
                    "sourceArchive": archive_filename,
                    "isActive":      is_first,
                }
                saved.append(cosmos.upsert_item(CAT_BRAND, doc, db_name=db_name))
    except zipfile.BadZipFile:
        raise HTTPException(status_code=400, detail="Uploaded file is not a valid ZIP archive")
    if not saved:
        raise HTTPException(
            status_code=422,
            detail="The ZIP archive contained no supported files (.txt, .json, .md, .csv, .xml, .yaml, .yml)"
        )
    return saved


_EXAMPLE_BRAND_FILES = {
    "colors.json": """{
  "baseColors": {
    "airlineBlue": "#003A8F",
    "skyBlue": "#00A8E8",
    "cloudWhite": "#F5F7FA",
    "runwayGrey": "#4A4F5A",
    "successGreen": "#2ECC71",
    "warningAmber": "#FFC107",
    "alertRed": "#D72638",
    "sunGold": "#C89B3C"
  },
  "backgroundColors": {
    "primary": "#003A8F",
    "secondary": "#4A4F5A",
    "warning": "#FFC107",
    "danger": "#D72638",
    "white": "#F5F7FA"
  },
  "textColors": {
    "primary": "#F5F7FA",
    "highlight": "#00A8E8",
    "success": "#2ECC71",
    "cta": "#C89B3C",
    "danger": "#D72638"
  },
  "iconColors": {
    "primary": "#F5F7FA",
    "highlight": "#00A8E8",
    "success": "#2ECC71",
    "cta": "#C89B3C"
  },
  "borderColors": {
    "primary": "#F5F7FA",
    "divider": "#4A4F5A",
    "highlight": "#00A8E8",
    "cta": "#C89B3C"
  },
  "gradients": {
    "sky": {
      "name": "Sky Gradient",
      "colors": ["#003A8F", "#00A8E8"],
      "css": "linear-gradient(180deg, #003A8F 0%, #00A8E8 100%)"
    },
    "sunrise": {
      "name": "Sunrise CTA",
      "colors": ["#FFC107", "#C89B3C"],
      "css": "linear-gradient(180deg, #FFC107 0%, #C89B3C 100%)"
    }
  }
}""",
    "typography.json": """{
  "fontFamilies": {
    "display": "Bauhaus Std, sans-serif",
    "body": "Poppins, sans-serif"
  },
  "fontWeights": {
    "regular": 400,
    "medium": 500,
    "semiBold": 600
  },
  "letterSpacing": { "none": "0" },
  "lineHeight": { "auto": "auto" },
  "textTransform": { "none": "none", "uppercase": "uppercase" },
  "webTypography": {
    "display": { "large": { "fontFamily": "Bauhaus Std, sans-serif", "fontSize": "36px", "fontWeight": 500 } },
    "heading": { "medium": { "fontFamily": "Poppins, sans-serif", "fontSize": "24px", "fontWeight": 500 } },
    "body":    { "medium": { "fontFamily": "Poppins, sans-serif", "fontSize": "14px", "fontWeight": 400 } },
    "label":   { "small":  { "fontFamily": "Poppins, sans-serif", "fontSize": "10px", "fontWeight": 400 } }
  },
  "mobileTypography": {
    "display": { "medium": { "fontFamily": "Bauhaus Std, sans-serif", "fontSize": "24px", "fontWeight": 500 } },
    "heading": { "small":  { "fontFamily": "Poppins, sans-serif", "fontSize": "16px", "fontWeight": 600 } },
    "body":    { "medium": { "fontFamily": "Poppins, sans-serif", "fontSize": "12px", "fontWeight": 400 } },
    "label":   { "small":  { "fontFamily": "Poppins, sans-serif", "fontSize": "8px",  "fontWeight": 400 } }
  }
}""",
    "spacing.json": """{
  "spacing": { "0": "0", "2": "8px", "4": "16px", "6": "24px", "8": "32px", "10": "40px" },
  "padding":  { "none": "0", "sm": "8px", "base": "16px", "lg": "24px", "xl": "32px" },
  "margin":   { "none": "0", "sm": "8px", "base": "16px", "lg": "24px" },
  "gap":      { "none": "0", "sm": "8px", "base": "16px", "lg": "24px" },
  "componentSpacing": {
    "button": { "small": "32px", "medium": "40px", "large": "56px" },
    "input":  { "web": { "standard": "44px" }, "mobile": { "standard": "40px" } },
    "checkbox": { "web": "32px", "mobile": "24px" },
    "toggle": { "small": "36px", "medium": "44px" }
  }
}""",
    "borderRadius.json": """{
  "borderRadius": {
    "none": "0", "sm": "4px", "base": "8px", "lg": "12px", "xl": "16px", "full": "50%"
  },
  "semanticBorderRadius": {
    "button":   { "small": "8px", "medium": "12px", "large": "16px" },
    "card":     "12px",
    "input":    { "small": "4px", "medium": "8px" },
    "badge":    { "small": "16px", "medium": "20px" },
    "avatar":   "50%",
    "checkbox": "4px",
    "radio":    "50%",
    "toggle":   "50%"
  }
}""",
    "shadows.json": """{
  "shadows": {
    "none": "none",
    "sm":   "0 1px 3px rgba(0, 0, 0, 0.1)",
    "base": "0 2px 6px rgba(0, 0, 0, 0.15)",
    "md":   "0 4px 12px rgba(0, 0, 0, 0.2)",
    "lg":   "0 8px 20px rgba(0, 0, 0, 0.25)"
  },
  "semanticShadows": {
    "card":         "0 2px 6px rgba(0, 0, 0, 0.15)",
    "modal":        "0 8px 20px rgba(0, 0, 0, 0.25)",
    "dropdown":     "0 4px 12px rgba(0, 0, 0, 0.2)",
    "tooltip":      "0 1px 3px rgba(0, 0, 0, 0.1)",
    "notification": "0 4px 12px rgba(0, 0, 0, 0.2)"
  }
}""",
}


@app.get("/api/brand-guidelines/example")
def download_example_brand_guidelines():
    """Stream brand-guidelines.zip containing the five standard token files."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for filename, content in _EXAMPLE_BRAND_FILES.items():
            zf.writestr(filename, content)
    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": "attachment; filename=brand-guidelines.zip"},
    )


@app.get("/api/brand-guidelines")
def list_brand_guidelines(db_name: str = Depends(require_db)) -> list[dict]:
    return [_normalize_brand(d) for d in _ensure_single_active(CAT_BRAND, cosmos.list_items(CAT_BRAND, db_name=db_name), db_name=db_name)]


@app.post("/api/brand-guidelines/upload")
async def upload_brand_guideline_zip(
    file: UploadFile = File(...),
    db_name: str = Depends(require_db),
) -> list[dict]:
    """
    Accept a ZIP archive, extract its contents, and store each supported file
    as a separate brand-guideline document.  Blocks upload when archive-sourced
    documents already exist (delete them first).
    """
    fname_lower = (file.filename or "").lower()
    if not fname_lower.endswith(".zip"):
        raise HTTPException(status_code=400, detail="Only ZIP archives are accepted for brand guidelines")
    if fname_lower != "brand-guidelines.zip":
        raise HTTPException(
            status_code=400,
            detail="The ZIP must be named 'brand-guidelines.zip'. Download the example to see the expected structure."
        )

    # Guardrail: block if archive-sourced docs already exist
    existing = cosmos.list_items(CAT_BRAND, db_name=db_name)
    archive_docs = [d for d in existing if d.get("sourceArchive") or d.get("source_archive")]
    if archive_docs:
        filenames = [d.get("filename") or d.get("name", "unknown") for d in archive_docs]
        source = archive_docs[0].get("sourceArchive") or archive_docs[0].get("source_archive", "unknown")
        raise HTTPException(
            status_code=409,
            detail=(
                f"A ZIP archive has already been uploaded (source: {source}). "
                f"Please delete the following {len(archive_docs)} file(s) before uploading a new archive: "
                f"{', '.join(filenames)}"
            ),
        )

    file_bytes = await file.read()
    saved = _extract_zip_and_save(file_bytes, file.filename or "upload.zip", db_name)
    return [_normalize_brand(d) for d in saved]


@app.post("/api/brand-guidelines")
def create_brand_guideline(payload: BrandGuidelineIn, db_name: str = Depends(require_db)) -> dict:
    new_id = str(uuid4())
    if payload.isActive:
        cosmos.deactivate_others(CAT_BRAND, new_id, db_name=db_name)
    return _normalize_brand(cosmos.upsert_item(CAT_BRAND, {**payload.model_dump(), "id": new_id}, db_name=db_name))

@app.put("/api/brand-guidelines/{item_id}")
def update_brand_guideline(item_id: str, updates: dict, db_name: str = Depends(require_db)) -> dict:
    if updates.get("isActive"):
        cosmos.deactivate_others(CAT_BRAND, item_id, db_name=db_name)
    return _update_or_404(CAT_BRAND, item_id, updates, _normalize_brand, "Brand guideline", db_name=db_name)

@app.delete("/api/brand-guidelines/{item_id}")
def delete_brand_guideline(item_id: str, db_name: str = Depends(require_db)) -> dict:
    return _delete_or_404(CAT_BRAND, item_id, "Brand guideline", db_name=db_name)


# ── Prompts ───────────────────────────────────────────────────────────────────

@app.get("/api/prompts")
def list_prompts(db_name: str = Depends(require_db)) -> list[dict]:
    fixed_prompt = get_fixed_system_prompt()
    docs = _ensure_single_active(CAT_PROMPT, cosmos.list_items(CAT_PROMPT, db_name=db_name), db_name=db_name)
    prompts = [_normalize_prompt(d) for d in docs]
    for prompt in prompts:
        prompt["systemPrompt"] = fixed_prompt
    return prompts

@app.post("/api/prompts")
def create_prompt(payload: PromptIn, db_name: str = Depends(require_db)) -> dict:
    new_id = str(uuid4())
    if payload.isActive:
        cosmos.deactivate_others(CAT_PROMPT, new_id, db_name=db_name)
    doc = _apply_aliases({**payload.model_dump(), "id": new_id}, _PROMPT_ALIASES)
    result = _normalize_prompt(cosmos.upsert_item(CAT_PROMPT, doc, db_name=db_name))
    result["systemPrompt"] = get_fixed_system_prompt()
    return result

@app.put("/api/prompts/{item_id}")
def update_prompt(item_id: str, updates: dict, db_name: str = Depends(require_db)) -> dict:
    if updates.get("isActive"):
        cosmos.deactivate_others(CAT_PROMPT, item_id, db_name=db_name)
    result = _update_or_404(CAT_PROMPT, item_id, _apply_aliases(updates, _PROMPT_ALIASES), _normalize_prompt, "Prompt", db_name=db_name)
    result["systemPrompt"] = get_fixed_system_prompt()
    return result

@app.delete("/api/prompts/{item_id}")
def delete_prompt(item_id: str, db_name: str = Depends(require_db)) -> dict:
    return _delete_or_404(CAT_PROMPT, item_id, "Prompt", db_name=db_name)


# ── Message Templates ─────────────────────────────────────────────────────────

@app.get("/api/message-templates")
def list_message_templates(db_name: str = Depends(require_db)) -> list[dict]:
    return [_normalize_template(d) for d in _ensure_single_active(CAT_TEMPLATE, cosmos.list_items(CAT_TEMPLATE, db_name=db_name), db_name=db_name)]

@app.post("/api/message-templates")
def create_message_template(payload: TemplateIn, db_name: str = Depends(require_db)) -> dict:
    new_id = str(uuid4())
    if payload.isActive:
        cosmos.deactivate_others(CAT_TEMPLATE, new_id, db_name=db_name)
    doc = _apply_aliases({**payload.model_dump(), "id": new_id}, _TEMPLATE_ALIASES)
    return _normalize_template(cosmos.upsert_item(CAT_TEMPLATE, doc, db_name=db_name))

@app.put("/api/message-templates/{item_id}")
def update_message_template(item_id: str, updates: dict, db_name: str = Depends(require_db)) -> dict:
    if updates.get("isActive"):
        cosmos.deactivate_others(CAT_TEMPLATE, item_id, db_name=db_name)
    return _update_or_404(CAT_TEMPLATE, item_id, _apply_aliases(updates, _TEMPLATE_ALIASES), _normalize_template, "Message template", db_name=db_name)

@app.delete("/api/message-templates/{item_id}")
def delete_message_template(item_id: str, db_name: str = Depends(require_db)) -> dict:
    return _delete_or_404(CAT_TEMPLATE, item_id, "Message template", db_name=db_name)


# ── Settings ──────────────────────────────────────────────────────────────────

@app.get("/api/settings")
def get_settings(db_name: str = Depends(require_db), tenant_id: str = Depends(require_tenant)) -> dict:
    return ensure_settings(db_name, tenant_id)


@app.put("/api/settings")
def save_settings(
    payload: SettingsIn,
    db_name: str = Depends(require_db),
    tenant_id: str = Depends(require_tenant),
) -> dict:
    settings_id = tenant_id or "default"
    existing = cosmos.get_item(CAT_SETTINGS, settings_id, db_name=db_name) or {}

    # Build flat-key entries from the apis array
    flat_apis: dict = {}
    for api_item in payload.apis:
        a = api_item if isinstance(api_item, dict) else api_item.model_dump()
        db_key = DB_KEY_MAP.get(a["id"])
        if db_key:
            flat_apis[db_key] = {
                "baseUrl":  a.get("baseUrl",  ""),
                "apiKey":   a.get("apiKey",   ""),
                "isActive": a.get("isActive", True),
            }

    doc = {
        **existing,                           # preserve createdAt, etc.
        "id":                  settings_id,
        "tenantId":            settings_id,
        "isActive":            True,
        **flat_apis,                          # Airline_api / Cdp_Api / Disruption_Api at top level
    }
    doc.pop("apis", None)                     # remove legacy array format if present

    saved = cosmos.upsert_item(CAT_SETTINGS, doc, db_name=db_name)
    return _normalize_settings(saved, tenant_id)


@app.patch("/api/settings/agents")
def save_agent_settings(
    payload: AgentSettingsIn,
    db_name: str = Depends(require_db),
    tenant_id: str = Depends(require_tenant),
) -> dict:
    """Update only agent fields — never overwrites Airline_api/Cdp_Api/Disruption_Api."""
    settings_id = tenant_id or "default"
    existing = cosmos.get_item(CAT_SETTINGS, settings_id, db_name=db_name) or {**DEFAULT_SETTINGS, "id": settings_id, "tenantId": settings_id}
    previous_recovery_agent  = existing.get("recoveryAgent",  "Select Agent")
    previous_messaging_agent = existing.get("messagingAgent", "Select Agent")
    updated = {**existing, **payload.model_dump(), "id": settings_id, "tenantId": settings_id, "isActive": True}
    saved = cosmos.upsert_item(CAT_SETTINGS, updated, db_name=db_name)
    # Write agent selection to shared flight_operations DB keyed by tenantId
    if tenant_id:
        agent_doc = {**payload.model_dump(), "id": tenant_id, "tenantId": tenant_id}
        cosmos.upsert_item(CAT_TENANT_AGENT_SETTINGS, agent_doc, db_name=None)
    if previous_recovery_agent != payload.recoveryAgent:
        _sync_selected_agent_status(previous_recovery_agent, False, db_name=db_name)
    if previous_messaging_agent != payload.messagingAgent:
        _sync_selected_agent_status(previous_messaging_agent, False, db_name=db_name)
    _sync_selected_agent_status(payload.recoveryAgent,  payload.recoveryAgentActive,  db_name=db_name)
    _sync_selected_agent_status(payload.messagingAgent, payload.messagingAgentActive, db_name=db_name)
    return _normalize_settings(saved, tenant_id)


# ── Dashboard ─────────────────────────────────────────────────────────────────

@app.get("/api/dashboard-summary")
def dashboard_summary(db_name: str = Depends(require_db), tenant_id: str = Depends(require_tenant)) -> dict:
    settings        = ensure_settings(db_name, tenant_id)
    recovery_agent  = settings.get("recoveryAgent",  "Select Agent")
    messaging_agent = settings.get("messagingAgent", "Select Agent")
    return {
        "brandCount":          len(cosmos.list_items(CAT_BRAND,    db_name=db_name)),
        "promptCount":         len(cosmos.list_items(CAT_PROMPT,   db_name=db_name)),
        "messageCount":        len(cosmos.list_items(CAT_TEMPLATE, db_name=db_name)),
        "recoveryAgent":       _resolve_agent_label(recovery_agent,  db_name=db_name),
        "messagingAgent":      _resolve_agent_label(messaging_agent, db_name=db_name),
        "recoveryAgentActive": bool(settings.get("recoveryAgentActive",  True)),
        "messagingAgentActive":bool(settings.get("messagingAgentActive", True)),
    }