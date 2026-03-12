import { useState, useEffect } from 'react'
import { api } from '../api'

const DEFAULT_APIS = [
  {
    id: 'airline',
    name: 'Airline API',
    desc: 'Flight search and seat map data for recovery flow',
    dot: 'purple',
    baseUrl: '',
    apiKey: '',
    isActive: true
  },
  {
    id: 'cdp',
    name: 'CDP API',
    desc: 'Customer Data Platform for passenger profile lookup',
    dot: 'green',
    baseUrl: '',
    apiKey: '',
    isActive: true
  },
  {
    id: 'disruption',
    name: 'Disruption API',
    desc: 'Flight disruption events lookup by PNR',
    dot: 'yellow',
    baseUrl: '',
    apiKey: '',
    isActive: true
  }
]

export default function ApiSettings() {
  const [apis, setApis] = useState(DEFAULT_APIS)
  const [settings, setSettings] = useState(null)
  const [loadError, setLoadError] = useState(false)
  const [saveStatus, setSaveStatus] = useState(null)

  useEffect(() => {
    loadSettings()
  }, [])

  const loadSettings = async () => {
    try {
      const data = await api.getSettings()
      setSettings(data)
      setApis(data.apis || DEFAULT_APIS)
      setLoadError(false)
    } catch {
      setLoadError(true)
    }
  }

  const update = (id, field, value) => {
    setApis(prev => prev.map(a => a.id === id ? { ...a, [field]: value } : a))
    setSaveStatus(null)
  }

  const toggleStatus = (id) => {
    setApis(prev => prev.map(a => a.id === id ? { ...a, isActive: !a.isActive } : a))
    setSaveStatus(null)
  }

  const handleSave = async () => {
    if (!settings) return
    try {
      const saved = await api.saveSettings({
        apis,
        recoveryAgent: settings.recoveryAgent || 'Select Agent',
        messagingAgent: settings.messagingAgent || 'Select Agent',
        recoveryAgentActive: settings.recoveryAgentActive !== false,
        messagingAgentActive: settings.messagingAgentActive !== false
      })
      setSettings(saved)
      setApis(saved.apis || DEFAULT_APIS)
      setSaveStatus('success')
      setTimeout(() => setSaveStatus(null), 3000)
    } catch {
      setSaveStatus('error')
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>URLs &amp; API Keys</h1>
        <p>Configure the external API endpoints used by the disruption pipeline</p>
      </div>

      {loadError && (
        <div className="alert alert-error" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span>Failed to load settings</span>
          <button className="btn btn-outline" style={{ fontSize: 13, padding: '4px 12px' }} onClick={loadSettings}>
            Retry
          </button>
        </div>
      )}

      {saveStatus === 'success' && (
        <div className="alert alert-success">Settings saved successfully!</div>
      )}

      {saveStatus === 'error' && (
        <div className="alert alert-error">Failed to save settings. Please try again.</div>
      )}

      <div className="api-grid">
        {apis.map(item => (
          <div key={item.id} className="api-card">
            <div className="api-card-header">
              <span className={`api-dot ${item.dot}`} />
              <div>
                <h3>{item.name}</h3>
                <p>{item.desc}</p>
              </div>
            </div>

            <div className="api-field">
              <label>Base URL</label>
              <input
                type="text"
                placeholder="http://127.0.0.1:9001"
                value={item.baseUrl}
                onChange={e => update(item.id, 'baseUrl', e.target.value)}
              />
            </div>

            <div className="api-field">
              <label>API Key</label>
              <input
                type="password"
                placeholder="Enter API key"
                value={item.apiKey}
                onChange={e => update(item.id, 'apiKey', e.target.value)}
              />
            </div>

            <button
              className={`status-toggle ${item.isActive ? 'active' : 'inactive'}`}
              onClick={() => toggleStatus(item.id)}
              title="Toggle API active status"
            >
              {item.isActive ? 'Active' : 'Inactive'}
            </button>
          </div>
        ))}
      </div>

      <div className="save-row">
        <button className="btn btn-primary" style={{ padding: '10px 28px', marginTop: 20 }} onClick={handleSave}>
          Save Settings
        </button>
      </div>
    </div>
  )
}
