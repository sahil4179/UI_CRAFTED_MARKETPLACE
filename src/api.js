const API_BASE = '/api'

function getSession() {
  try { return JSON.parse(sessionStorage.getItem('tenant_session') || 'null') } catch { return null }
}

async function request(path, options = {}) {
  const session = getSession()
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) }
  if (session?.dbName) headers['x-db-name'] = session.dbName
  if (session?.tenantId) headers['x-tenant-id'] = session.tenantId

  const response = await fetch(`${API_BASE}${path}`, { headers, ...options })

  if (!response.ok) {
    let message = 'Request failed'
    try {
      const errorBody = await response.json()
      message = errorBody?.detail || message
    } catch {
      message = response.statusText || message
    }
    throw new Error(message)
  }

  if (response.status === 204) return null
  return response.json()
}

async function authRequest(path, payload) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const body = await response.json()
  if (!response.ok) throw new Error(body?.detail || 'Request failed')
  return body
}

export const api = {
  login:    (payload) => authRequest('/auth/login',    payload),
  register: (payload) => authRequest('/auth/register', payload),
  logout:   (payload) => authRequest('/auth/logout',   payload),

  getDashboardSummary: () => request('/dashboard-summary'),

  listBrandGuidelines: () => request('/brand-guidelines'),
  uploadBrandGuidelineZip: (file) => {
    const session = getSession()
    const headers = {}
    if (session?.dbName)   headers['x-db-name']   = session.dbName
    if (session?.tenantId) headers['x-tenant-id'] = session.tenantId
    const formData = new FormData()
    formData.append('file', file)
    return fetch(`${API_BASE}/brand-guidelines/upload`, { method: 'POST', headers, body: formData })
      .then(async res => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body?.detail || 'Upload failed')
        }
        return res.json()
      })
  },
  downloadBrandGuidelineExample: () => {
    const session = getSession()
    const headers = {}
    if (session?.dbName) headers['x-db-name'] = session.dbName
    fetch(`${API_BASE}/brand-guidelines/example`, { headers })
      .then(r => r.blob())
      .then(blob => {
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = 'brand-guidelines-example.zip'
        a.click()
        URL.revokeObjectURL(url)
      })
  },
  createBrandGuideline: (payload) => request('/brand-guidelines', { method: 'POST', body: JSON.stringify(payload) }),
  updateBrandGuideline: (id, payload) => request(`/brand-guidelines/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  deleteBrandGuideline: (id) => request(`/brand-guidelines/${id}`, { method: 'DELETE' }),

  listPrompts: () => request('/prompts'),
  createPrompt: (payload) => request('/prompts', { method: 'POST', body: JSON.stringify(payload) }),
  updatePrompt: (id, payload) => request(`/prompts/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  deletePrompt: (id) => request(`/prompts/${id}`, { method: 'DELETE' }),

  listMessageTemplates: () => request('/message-templates'),
  createMessageTemplate: (payload) => request('/message-templates', { method: 'POST', body: JSON.stringify(payload) }),
  updateMessageTemplate: (id, payload) => request(`/message-templates/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  deleteMessageTemplate: (id) => request(`/message-templates/${id}`, { method: 'DELETE' }),

  getSettings: () => request('/settings'),
  saveSettings: (payload) => request('/settings', { method: 'PUT', body: JSON.stringify(payload) }),
  patchAgentSettings: (payload) => request('/settings/agents', { method: 'PATCH', body: JSON.stringify(payload) }),

  getSystemPrompt: () => request('/system-prompt'),
  listAgents: () => request('/agents'),
}
