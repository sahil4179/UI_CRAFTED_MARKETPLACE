# Marketplace Admin Frontend

React + Vite single-page app for the multi-tenant Marketplace Admin dashboard. Handles tenant auth, routing, and CRUD flows for brand guidelines, prompts, message templates, and API settings.

## Quick Start
- Prereq: Node 18+ and npm.
- Install: `npm install`
- Dev server: `npm run dev` (Vite, defaults to http://localhost:5173)
- Build: `npm run build`
- Preview production build: `npm run preview`

## Configuration
- API base URL is defined in [frontend/src/api.js](frontend/src/api.js) (`API_BASE`). Update it if your backend runs elsewhere.
- Session is stored in `sessionStorage` under `tenant_session` after login/registration. Requests send `x-db-name` and `x-tenant-id` headers when present.

## App Structure
- [frontend/src/main.jsx](frontend/src/main.jsx): React entrypoint.
- [frontend/src/App.jsx](frontend/src/App.jsx): Router with protected layout (redirects to Login when session is missing `dbName`).
- [frontend/src/api.js](frontend/src/api.js): Fetch helpers and REST endpoints.
- [frontend/src/components/Sidebar.jsx](frontend/src/components/Sidebar.jsx): Navigation + agent selection (recovery/messaging) with save + logout.
- Pages:
  - [frontend/src/pages/Login.jsx](frontend/src/pages/Login.jsx): Login/Register, saves tenant session.
  - [frontend/src/pages/Dashboard.jsx](frontend/src/pages/Dashboard.jsx): Summary cards for counts and active agents.
  - [frontend/src/pages/BrandGuidelines.jsx](frontend/src/pages/BrandGuidelines.jsx): Upload ZIP/RAR/JSON brand docs, toggle active, delete. JSON supports single object, array, or `documents/guidelines` array.
  - [frontend/src/pages/PromptOverride.jsx](frontend/src/pages/PromptOverride.jsx): Manage prompts; one active at a time; uses modal for add/edit; system prompt is read-only.
  - [frontend/src/pages/MessageTemplate.jsx](frontend/src/pages/MessageTemplate.jsx): Upload/paste templates (TXT/JSON/MD/CSV/XML/YAML). Supports multi-channel groups; ensures a single active template per set.
  - [frontend/src/pages/ApiSettings.jsx](frontend/src/pages/ApiSettings.jsx): Configure external API base URLs/keys; normalization supports legacy flat keys and new array format.

## Behavior Notes
- Protected routes: any missing/invalid session clears storage and redirects to Login.
- Agent settings: Sidebar filters agents by category (recovery = cancel/cancle, messaging = delay) before selection.
- File uploads: Brand and template pages display success/error banners and keep one active record where applicable.
- API settings: Save merges existing settings with edited API entries to maintain compatibility with stored data.

## Styling
Global styles and layout live in [frontend/src/index.css](frontend/src/index.css). Adjust tokens there to change look and feel.

## Troubleshooting
- If requests fail, verify `API_BASE` points at a reachable backend and that CORS is allowed.
- Clearing browser storage can resolve stale session header issues.
