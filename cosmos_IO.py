import os
from datetime import datetime, timezone
from urllib.parse import quote_plus

from dotenv import find_dotenv, load_dotenv
from pymongo import MongoClient
from pymongo.errors import OperationFailure, PyMongoError

load_dotenv(find_dotenv(), override=True)  # walks up the tree to find .env regardless of CWD

# ── Connection ───────────────────────────────────────────────────────────────

COSMOS_DB_NAME = os.getenv("COSMOS_DB_NAME")

_user = os.getenv("COSMOS_DB_USERNAME")
_pass = os.getenv("COSMOS_DB_PASSWORD")
_host = os.getenv("COSMOS_DB_HOST")

_explicit_uri = os.getenv("COSMOS_DB_URI")

if _explicit_uri:
    COSMOS_DB_URI: str = _explicit_uri
elif _user and _pass and _host:
    COSMOS_DB_URI = (
        f"mongodb+srv://{_user}:{quote_plus(_pass)}"
        f"@{_host}/?ssl=true&retryWrites=false&maxIdleTimeMS=120000"
    )
else:
    COSMOS_DB_URI = ""


class CosmosConnectionError(RuntimeError):
    pass

_client: MongoClient | None = None


def _db(db_name: str | None = None):
    """Return the requested database (or default COSMOS_DB_NAME for shared collections)."""
    global _client
    if not COSMOS_DB_URI:
        raise CosmosConnectionError("Set COSMOS_DB_URI or COSMOS_DB_USERNAME/COSMOS_DB_PASSWORD/COSMOS_DB_HOST in .env")
    if _client is None:
        try:
            _client = MongoClient(
                COSMOS_DB_URI,
                serverSelectionTimeoutMS=15000,
                connectTimeoutMS=15000,
                socketTimeoutMS=15000,
            )
            _client.admin.command("ping")
        except PyMongoError as exc:
            _client = None  # reset so the next request retries the connection
            raise CosmosConnectionError(
                "Failed to connect to Cosmos DB. Verify URI/credentials and allow this machine IP in Cosmos firewall/networking."
            ) from exc
    name = db_name or COSMOS_DB_NAME
    if not name:
        raise CosmosConnectionError("No database name available — set COSMOS_DB_NAME in .env")
    return _client[name]


_NO_ID = {"_id": 0}  # reused projection that strips Mongo's internal _id


# ── CRUD class ───────────────────────────────────────────────────────────────

class CosmosIO:
    def list_items(self, col: str, db_name: str | None = None) -> list[dict]:
        docs = list(_db(db_name)[col].find({}, _NO_ID))
        return sorted(
            docs,
            key=lambda d: str(d.get("createdAt") or d.get("updatedAt") or d.get("created_at") or ""),
            reverse=True,
        )

    def get_item(self, col: str, item_id: str, db_name: str | None = None) -> dict | None:
        return _db(db_name)[col].find_one({"id": item_id}, _NO_ID)

    def upsert_item(self, col: str, doc: dict, db_name: str | None = None) -> dict:
        now = datetime.now(timezone.utc).isoformat()
        doc = {**doc, "updatedAt": now, "createdAt": doc.get("createdAt", now)}
        _db(db_name)[col].replace_one({"id": doc["id"]}, doc, upsert=True)
        return _db(db_name)[col].find_one({"id": doc["id"]}, _NO_ID) or doc

    def patch_item(self, col: str, item_id: str, updates: dict, db_name: str | None = None) -> dict | None:
        doc = self.get_item(col, item_id, db_name)
        return self.upsert_item(col, {**doc, **updates, "id": item_id}, db_name) if doc else None

    def delete_item(self, col: str, item_id: str, db_name: str | None = None) -> bool:
        return _db(db_name)[col].delete_one({"id": item_id}).deleted_count > 0

    def deactivate_others(self, col: str, active_id: str, db_name: str | None = None) -> None:
        """Set all docs in col inactive except the one with active_id."""
        try:
            _db(db_name)[col].update_many(
                {"id": {"$ne": active_id}},
                {"$set": {"isActive": False, "is_active": False}},
            )
        except (OperationFailure, PyMongoError):
            pass  # collection doesn't exist yet — first insert will create it

    def find_one_by_field(self, col: str, field: str, value: str, db_name: str | None = None) -> dict | None:
        return _db(db_name)[col].find_one({field: value}, _NO_ID)

    def copy_agents_to_tenant(self, tenant_db_name: str) -> int:
        """Copy all agents from flight_operations.agents (the shared master DB)
        to the newly created tenant's agents collection.
        Skips agents that already exist (matched by `id`) to avoid duplicates.
        Returns the number of agents copied.
        """
        source_agents = list(_db(None)["agents"].find({}, {"_id": 0}))
        if not source_agents:
            return 0
        now = datetime.now(timezone.utc).isoformat()
        tenant_agents_col = _db(tenant_db_name)["agents"]
        copied = 0
        for agent in source_agents:
            agent_id = agent.get("id")
            if not agent_id:
                continue
            # Skip if this agent already exists in the tenant DB (idempotent)
            if tenant_agents_col.find_one({"id": agent_id}):
                continue
            new_agent = {**agent, "createdAt": now, "updatedAt": now}
            tenant_agents_col.insert_one(new_agent)
            copied += 1
        return copied

    def ensure_tenant_collections(self, db_name: str) -> None:
        """Explicitly create all standard tenant collections if they don't exist yet.
        CosmosDB for MongoDB sometimes requires explicit collection creation before
        update_many / find operations work on a brand-new tenant database.
        """
        required = ["brand_guidelines", "prompts", "templates", "settings", "agents"]
        try:
            db = _db(db_name)
            existing = set(db.list_collection_names())
            for col in required:
                if col not in existing:
                    try:
                        db.create_collection(col)
                    except OperationFailure:
                        pass  # race condition: another request created it first
        except PyMongoError:
            pass  # if listing fails, implicit creation will still be attempted


# ── Read helpers (for external consumers) ────────────────────────────────────

def fetch_api_settings() -> dict:
    return _db()["settings"].find_one({"id": "api_settings"}, _NO_ID) or {}


def fetch_active_prompt_payload() -> dict:
    doc = _db()["prompts"].find_one({"is_active": True}, _NO_ID) or {}
    return {
        "name":          doc.get("name"),
        "is_active":     bool(doc.get("is_active")),
        "system_prompt": doc.get("system_prompt") or doc.get("systemPrompt") or "",
        "user_prompt":   doc.get("user_prompt")   or doc.get("userPrompt")   or doc.get("text") or "",
    }


def fetch_active_prompt() -> str | None:
    return fetch_active_prompt_payload()["user_prompt"] or None


def fetch_active_agents() -> list[dict]:
    # agents use is_active_mess / is_active_recov, not a single is_active flag
    return list(_db()["agents"].find(
        {},
        {**_NO_ID, "agent_id": 1, "name": 1, "description": 1,
         "is_active_mess": 1, "is_active_recov": 1},
    ))


def fetch_active_template() -> dict | None:
    db = _db()
    return db["templates"].find_one({"is_active": True}, _NO_ID) or db["templates"].find_one({}, _NO_ID)