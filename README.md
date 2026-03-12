# Marketplace Admin Panel — Backend Reference

This document explains every function in `cosmos_IO.py` and `backend/main.py`: what it does, why it exists, and how it connects to the rest of the system.

---

## Table of Contents

1. [Project Structure](#project-structure)
2. [Environment Setup](#environment-setup)
3. [cosmos\_IO.py — Database Layer](#cosmos_iopy--database-layer)
   - [Connection Bootstrap](#connection-bootstrap)
   - [`_db()`](#_db)
   - [`CosmosIO` class](#cosmosio-class)
   - [Read Helpers (external consumers)](#read-helpers-external-consumers)
4. [backend/main.py — API Layer](#backendmainpy--api-layer)
   - [Shared Doc Helpers](#shared-doc-helpers)
   - [Pydantic Models (Request Schemas)](#pydantic-models-request-schemas)
   - [Document Normalisers](#document-normalisers)
   - [Alias & CRUD Factories](#alias--crud-factories)
   - [API Endpoints](#api-endpoints)
5. [Data Flow Diagram](#data-flow-diagram)
6. [Running the Project](#running-the-project)

---

## Project Structure

```
.
├── .env                  # Environment variables (DB credentials)
├── cosmos_IO.py          # All database logic (connection + CRUD + read helpers)
├── requirements.txt      # Python dependencies
├── backend/
│   └── main.py           # FastAPI app — defines all HTTP endpoints
└── src/                  # React frontend
    ├── api.js            # Frontend API client
    └── pages/            # UI pages that call api.js
```

---

## Environment Setup

Create a `.env` file in the project root:

```env
COSMOS_DB_USERNAME=<your-cosmos-username>
COSMOS_DB_PASSWORD=<your-cosmos-password>
COSMOS_DB_HOST=<your-cosmos-host>.cosmos.azure.com
COSMOS_DB_NAME=<your-database-name>
```

Alternatively, set `COSMOS_DB_URI` directly to override the auto-built URI.

---

## cosmos\_IO.py — Database Layer

This file owns **everything related to the database**. The rest of the app never imports `pymongo` directly — it only talks to this file. That way, if the DB driver ever changes, only this file needs updating.

---

### Connection Bootstrap

```python
COSMOS_DB_NAME = os.getenv("COSMOS_DB_NAME")

COSMOS_DB_URI = os.getenv("COSMOS_DB_URI") or (
    f"mongodb+srv://{_user}:{quote_plus(_pass or '')}"
    f"@{_host}/?ssl=true&retryWrites=false&maxIdleTimeMS=120000"
)
```

**Why it exists:**  
Reads credentials from `.env` at startup. The URI is built automatically from individual parts (`USERNAME`, `PASSWORD`, `HOST`) so you never have to manually format the connection string. If `COSMOS_DB_URI` is already set as a full string, that takes priority.

**Azure-specific flags:**
| Flag | Value | Reason |
|---|---|---|
| `ssl` | `true` | Azure Cosmos DB requires encrypted connections |
| `retryWrites` | `false` | Cosmos DB does not support distributed retryable writes |
| `maxIdleTimeMS` | `120000` | Prevents dropped connections due to Cosmos DB's idle timeout |

---

### `_db()`

```python
def _db():
```

**What it does:**  
Returns the connected MongoDB database instance. Creates the `MongoClient` only once (lazy singleton pattern) and reuses it for every subsequent call.

**Why it exists:**  
Opening a new database connection on every request is extremely slow. A singleton means the connection is established once and shared across all operations. The function also guards against missing env vars and raises a clear `RuntimeError` if config is wrong, rather than failing with a cryptic connection error.

---

### `_NO_ID`

```python
_NO_ID = {"_id": 0}
```

**What it does:**  
A reusable MongoDB projection dict that tells Mongo to exclude the internal `_id` field from results.

**Why it exists:**  
MongoDB adds an `_id` (ObjectId) field to every document. The frontend doesn't need it and it can't be serialized to JSON directly. This constant is passed to every `.find()` / `.find_one()` call to strip it automatically — defined once instead of repeating `{"_id": 0}` everywhere.

---

### `CosmosIO` class

A thin wrapper around the 4 core database operations. Every API endpoint uses one of these methods.

---

#### `list_items(col)`

```python
def list_items(self, col: str) -> list[dict]:
```

**What it does:**  
Fetches **all documents** from a collection and returns them sorted newest-first by `createdAt` or `updatedAt`.

**Why it exists:**  
Every "list" API endpoint (`GET /api/prompts`, `GET /api/brand-guidelines`, etc.) needs the same pattern: fetch all, strip `_id`, sort by date. Centralising this avoids repeating the same 3-line block in every route.

---

#### `get_item(col, item_id)`

```python
def get_item(self, col: str, item_id: str) -> dict | None:
```

**What it does:**  
Fetches a **single document** by its `id` field. Returns `None` if not found.

**Why it exists:**  
Used by `patch_item` before updating to retrieve the existing document, and by `ensure_settings` to check if settings already exist. Provides a safe, `None`-returning lookup instead of throwing an exception on a miss.

---

#### `upsert_item(col, doc)`

```python
def upsert_item(self, col: str, doc: dict) -> dict:
```

**What it does:**  
Saves a document to the collection. If a document with the same `id` already exists it is replaced; otherwise a new one is inserted. Automatically stamps `createdAt` (only on first insert) and `updatedAt` (on every save).

**Why it exists:**  
Combines create and update into one operation. This means the frontend never needs to know whether a document is new or existing — it always calls the same backend endpoint and gets the saved doc back. The automatic timestamps ensure every document has consistent audit fields.

---

#### `patch_item(col, item_id, updates)`

```python
def patch_item(self, col: str, item_id: str, updates: dict) -> dict | None:
```

**What it does:**  
Performs a **partial update**: fetches the existing document, merges `updates` into it, and saves it back via `upsert_item`. Returns `None` if the document doesn't exist.

**Why it exists:**  
The frontend sends only the fields that changed (e.g., `{"isActive": false}`). This function merges those changes into the full existing document so unrelated fields are preserved. Without this, a partial update would wipe all other fields.

---

#### `delete_item(col, item_id)`

```python
def delete_item(self, col: str, item_id: str) -> bool:
```

**What it does:**  
Deletes a document by `id`. Returns `True` if something was deleted, `False` if the document didn't exist.

**Why it exists:**  
The API layer needs to know whether the delete actually found the document (to return 404 vs 200). The boolean return lets the route decide the HTTP response.

---

### Read Helpers (external consumers)

These are **standalone functions** (not part of `CosmosIO`) for use by external systems — e.g., the AI agent pipeline that needs to read config without going through the HTTP API.

---

#### `fetch_api_settings()`

```python
def fetch_api_settings() -> dict:
```

Reads the single `api_settings` document from the `settings` collection. Returns `{}` if not found. Used by external agents to get the configured API keys and base URLs.

---

#### `fetch_active_prompt_payload()`

```python
def fetch_active_prompt_payload() -> dict:
```

Fetches the currently active prompt document (`is_active: True`) from `prompts` and returns it in a normalised shape with `name`, `is_active`, `system_prompt`, and `user_prompt` fields. Handles both camelCase (`systemPrompt`) and snake_case (`system_prompt`) field naming from different document sources.

---

#### `fetch_active_prompt()`

```python
def fetch_active_prompt() -> str | None:
```

Thin wrapper over `fetch_active_prompt_payload()` that returns just the `user_prompt` string, or `None` if none is active. Convenience function for callers that only need the prompt text.

---

#### `fetch_active_agents()`

```python
def fetch_active_agents() -> list[dict]:
```

Returns all agents where `is_active` is `True` from the `agents` collection, projecting only `agent_id`, `name`, and `description`. Used to populate agent dropdowns without exposing sensitive agent internals.

---

#### `fetch_active_template()`

```python
def fetch_active_template() -> dict | None:
```

Returns the active message template (where `is_active: True`). Falls back to the first available template if none is marked active. Ensures the AI pipeline always has a template to work with even if no one has explicitly activated one.

---

## backend/main.py — API Layer

This file defines all HTTP endpoints. It **never talks to MongoDB directly** — it always goes through `CosmosIO`. Its job is to: validate incoming requests, call the right DB operation, and shape the response for the frontend.

---

### Shared Doc Helpers

#### `_pick(doc, *keys, default="")`

```python
def _pick(doc: dict, *keys: str, default: Any = "") -> Any:
```

**What it does:**  
Scans a document for the first truthy value among the given keys. Returns `default` if none are found.

**Why it exists:**  
Documents in the DB were created at different times by different systems and use inconsistent field names (e.g., `filename` vs `name`, `user_prompt` vs `content`). Instead of chaining `doc.get("a") or doc.get("b") or doc.get("c")` repeatedly in every normaliser, `_pick` does that in one readable call. Used by every normaliser function.

---

#### `_is_active(doc)`

```python
def _is_active(doc: dict) -> bool:
```

**What it does:**  
Returns the active status of a document, checking both `isActive` (camelCase, frontend style) and `is_active` (snake_case, DB style). Defaults to `True` if neither key is present.

**Why it exists:**  
Documents written by the admin panel use `isActive`, while documents written by the agent pipeline use `is_active`. This helper normalises both into a single boolean so the frontend always gets a consistent field.

---

### Pydantic Models (Request Schemas)

These define the shape of data the frontend must send for each POST/PUT request. FastAPI validates incoming JSON against these automatically — if a required field is missing or the wrong type, a 422 error is returned before any DB call is made.

| Model | Used by | Key fields |
|---|---|---|
| `BrandGuidelineIn` | `POST /api/brand-guidelines` | `name`, `size`, `fileType`, `isActive` |
| `PromptIn` | `POST /api/prompts` | `title`, `content`, `isActive` |
| `TemplateIn` | `POST /api/message-templates` | `name`, `size`, `type`, `isActive` |
| `ApiConfigItem` | nested in `SettingsIn` | `id`, `baseUrl`, `apiKey`, `isActive` |
| `SettingsIn` | `PUT /api/settings` | `apis[]`, `recoveryAgent`, `messagingAgent` |

---

### Document Normalisers

These functions convert a raw DB document into the exact shape the frontend expects. They handle field name mismatches between different document sources.

#### `_normalize_brand(doc)`
Maps DB fields → `{ id, name, size, fileType, isActive }`.  
Handles: `filename` → `name`, `file_type` → `fileType`.

#### `_normalize_prompt(doc)`
Maps DB fields → `{ id, title, content, isActive }`.  
Handles: `name` → `title`, `user_prompt`/`text` → `content`, `is_active` → `isActive`.

#### `_normalize_template(doc)`
Maps DB fields → `{ id, name, size, type, isActive }`.  
Handles: `filename` → `name`, `template_type` → `type`, `is_active` → `isActive`.

#### `_normalize_settings(doc)`
Maps DB fields → `{ id, apis, recoveryAgent, messagingAgent }`.  
Handles: `recovery_agent` → `recoveryAgent`, `messaging_agent` → `messagingAgent`. Fills in `DEFAULT_APIS` when `apis` is missing.

**Why normalisers exist:**  
The DB can hold documents created by multiple systems with different naming conventions. Normalisers act as a translation layer so the frontend always gets a predictable, consistent shape regardless of how the data was written.

---

#### `ensure_settings()`

```python
def ensure_settings() -> dict:
```

**What it does:**  
Tries to load the `api_settings` document. If it doesn't exist yet (first run), creates it with `DEFAULT_SETTINGS` and saves it to the DB.

**Why it exists:**  
Settings must always exist — the dashboard and agent dropdowns depend on them. Rather than returning `null` or crashing on first run, this function self-heals by seeding the defaults automatically.

---

### Alias & CRUD Factories

#### `_PROMPT_ALIASES` / `_TEMPLATE_ALIASES`

```python
_PROMPT_ALIASES   = {"title": "name", "content": "user_prompt", "isActive": "is_active"}
_TEMPLATE_ALIASES = {"name": "filename", "type": "file_type",   "isActive": "is_active"}
```

Mapping dictionaries that define how frontend field names map to DB field names.

#### `_apply_aliases(updates, alias_map)`

```python
def _apply_aliases(updates: dict, alias_map: dict) -> dict:
```

**What it does:**  
Copies the `updates` dict and adds DB-side alias keys for every frontend key that's present. For example, if the frontend sends `{"title": "My Prompt"}`, this adds `{"name": "My Prompt"}` so both keys exist in the document.

**Why it exists:**  
The DB stores prompts with `name` and `user_prompt` (to match the agent pipeline's schema), but the frontend sends `title` and `content`. This function bridges that gap on writes so both naming conventions coexist in the document without loss.

---

#### `_delete_or_404(col, item_id, label)`

```python
def _delete_or_404(col: str, item_id: str, label: str) -> dict:
```

**What it does:**  
Calls `cosmos.delete_item()` and raises a `404 HTTPException` if the item wasn't found. Returns `{"deleted": True}` on success.

**Why it exists:**  
Every delete endpoint does exactly the same thing: delete, check result, raise 404 or return success. This factory collapses that repeated 4-line block into a single reusable call.

---

#### `_update_or_404(col, item_id, updates, normalizer, label)`

```python
def _update_or_404(col, item_id, updates, normalizer, label) -> dict:
```

**What it does:**  
Calls `cosmos.patch_item()`, raises 404 if not found, and runs the returned doc through `normalizer` before returning it.

**Why it exists:**  
Every PUT endpoint follows the same pattern: patch, check for None, normalise, return. This factory does it in one line per route.

---

### API Endpoints

#### `GET /api/health`
Returns `{"status": "ok"}`. Used by load balancers and monitoring tools to verify the server is running.

---

#### Brand Guidelines

| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/brand-guidelines` | Returns all brand guideline docs, normalised |
| `POST` | `/api/brand-guidelines` | Creates a new brand guideline; auto-assigns a UUID `id` |
| `PUT` | `/api/brand-guidelines/{id}` | Partially updates a brand guideline by id |
| `DELETE` | `/api/brand-guidelines/{id}` | Deletes a brand guideline; 404 if not found |

---

#### Prompts

| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/prompts` | Returns all prompts, normalised to `{title, content, isActive}` |
| `POST` | `/api/prompts` | Creates a prompt; aliases `title→name`, `content→user_prompt` for DB storage |
| `PUT` | `/api/prompts/{id}` | Partially updates; same aliasing applied to incoming fields |
| `DELETE` | `/api/prompts/{id}` | Deletes a prompt; 404 if not found |

---

#### Message Templates

| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/message-templates` | Returns all templates, normalised to `{name, size, type, isActive}` |
| `POST` | `/api/message-templates` | Creates a template; aliases `name→filename`, `type→file_type` |
| `PUT` | `/api/message-templates/{id}` | Partially updates with aliasing |
| `DELETE` | `/api/message-templates/{id}` | Deletes a template; 404 if not found |

---

#### Settings

| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/settings` | Loads settings (seeds defaults if first run via `ensure_settings`) |
| `PUT` | `/api/settings` | Saves all settings; always uses the fixed `SETTINGS_ID = "api_settings"` so there is only ever one settings document |

---

#### `GET /api/dashboard-summary`

Returns aggregated counts for the dashboard overview card:

```json
{
  "brandCount": 3,
  "promptCount": 1,
  "smsCount": 2,
  "emailCount": 1,
  "waCount": 0,
  "recoveryAgent": "asst_XYZ",
  "messagingAgent": "asst_ABC"
}
```

**Why it exists:**  
The frontend dashboard needs counts from multiple collections in a single request. Without this endpoint, the frontend would have to make 4 separate calls, wait for all of them, and sum the results itself — wasting round trips.

---

## Data Flow Diagram

```
Frontend (React)
      │
      │  HTTP  (fetch via src/api.js)
      ▼
backend/main.py  (FastAPI)
  │  validates request body (Pydantic)
  │  applies field aliases (_apply_aliases)
  │  calls CosmosIO method
  │  normalises DB doc (_normalize_*)
  │  returns JSON response
      │
      ▼
cosmos_IO.py  (CosmosIO class)
  │  uses singleton _db() client
  │  executes MongoDB query
      │
      ▼
Azure Cosmos DB for MongoDB
  Collections: brand_guidelines | prompts | templates | settings | agents
```

---

## Running the Project

```bash
# 1. Install Python dependencies
pip install -r requirements.txt

# 2. Start the backend (from project root)
uvicorn backend.main:app --reload --port 8000

# 3. Install frontend dependencies
npm install

# 4. Start the frontend
npm run dev
```

The FastAPI interactive docs are available at **http://localhost:8000/docs** once the backend is running.
