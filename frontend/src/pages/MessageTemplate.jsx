import { useEffect, useState, useRef } from 'react'
import { api } from '../api'

const EXAMPLE_TEMPLATE = `{
  "templates": [
    {
      "type": "sms",
      "name": "Flight Delay SMS",
      "content": "Dear {{passenger_name}}, your flight {{flight_number}} is delayed by {{delay_minutes}} minutes. New departure: {{new_departure_time}}."
    },
    {
      "type": "email",
      "name": "Flight Cancellation Email",
      "subject": "Important: Flight {{flight_number}} Cancellation",
      "content": "Dear {{passenger_name}},\\n\\nWe regret to inform you that flight {{flight_number}} has been cancelled.\\n\\nWe apologize for the inconvenience."
    },
    {
      "type": "whatsapp",
      "name": "Recovery Offer WhatsApp",
      "content": "Hi {{passenger_name}}! We have rebooked you on flight {{new_flight_number}} departing at {{new_departure_time}}. Reply YES to confirm."
    }
  ]
}`

const ALLOWED_EXTS = ['.txt', '.json', '.md', '.csv', '.xml', '.yaml', '.yml']

function detectType(name) {
  const n = name.toLowerCase()
  if (n.includes('sms')) return 'sms'
  if (n.includes('email')) return 'email'
  if (n.includes('whatsapp') || n.includes('wa')) return 'whatsapp'
  return 'sms'
}

const TYPE_LABELS = { sms: 'SMS', email: 'Email', whatsapp: 'WhatsApp', messages: 'Messages' }

function normalizeTemplateType(value, fallbackName = '') {
  const lowered = String(value || '').toLowerCase()
  if (['sms', 'email', 'whatsapp', 'messages'].includes(lowered)) return lowered
  return detectType(fallbackName)
}

function readFileText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}`))
    reader.readAsText(file)
  })
}

function parseTemplatePayloadsFromJson(rawText, fileName) {
  let parsed
  try {
    parsed = JSON.parse(rawText)
  } catch {
    throw new Error(`${fileName}: invalid JSON format`)
  }

  let list = []
  if (Array.isArray(parsed)) list = parsed
  else if (Array.isArray(parsed?.templates)) list = parsed.templates
  else if (parsed && typeof parsed === 'object') list = [parsed]

  const normalized = list
    .filter(item => item && typeof item === 'object')
    .map((item, idx) => {
      const resolvedName = String(item.name || item.group_id || item.title || `${fileName} template ${idx + 1}`).trim()
      const resolvedType = Array.isArray(item.channels)
        ? 'messages'
        : normalizeTemplateType(item.type || item.channel, resolvedName)
      return {
        name: resolvedName,
        type: resolvedType,
        size: 'JSON import',
        content: item
      }
    })

  if (normalized.length === 0) {
    throw new Error(`${fileName}: expected a template object or a templates array`)
  }

  return normalized
}

function PreviewModal({ onClose }) {
  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 640 }}>
        <h3>Example Template Preview</h3>
        <pre style={{
          background: '#f9fafb',
          border: '1px solid #e5e7eb',
          borderRadius: 8,
          padding: 16,
          fontSize: 13,
          overflowX: 'auto',
          maxHeight: 380,
          overflowY: 'auto'
        }}>{EXAMPLE_TEMPLATE}</pre>
        <div className="modal-actions">
          <button className="btn btn-outline" onClick={onClose}>Close</button>
          <button className="btn btn-primary" onClick={() => {
            const blob = new Blob([EXAMPLE_TEMPLATE], { type: 'application/json' })
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url; a.download = 'example-template.json'; a.click()
            URL.revokeObjectURL(url)
          }}>
            ⬇ Download
          </button>
        </div>
      </div>
    </div>
  )
}

export default function MessageTemplate() {
  const [templates, setTemplates] = useState([])
  const [dragover, setDragover] = useState(false)
  const [showPreview, setShowPreview] = useState(false)
  const [loading, setLoading] = useState(true)
  const [uploadStatus, setUploadStatus] = useState(null)
  const inputRef = useRef()
  const [showPastePanel, setShowPastePanel] = useState(false)
  const [pasteJson, setPasteJson] = useState('')
  const [pasteError, setPasteError] = useState(null)

  useEffect(() => {
    const load = async () => {
      try {
        const data = await api.listMessageTemplates()
        setTemplates(data)
      } catch (error) {
        alert(error.message || 'Failed to load message templates')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  const handleFiles = async (files) => {
    setUploadStatus(null)
    const valid = Array.from(files).filter(f =>
      ALLOWED_EXTS.some(ext => f.name.toLowerCase().endsWith(ext))
    )
    if (valid.length === 0) {
      alert('Only TXT, JSON, MD, CSV, XML, YAML files are supported.')
      return
    }

    try {
      const payloads = []

      for (const file of valid) {
        const isJson = file.name.toLowerCase().endsWith('.json')
        if (isJson) {
          const rawText = await readFileText(file)
          payloads.push(...parseTemplatePayloadsFromJson(rawText, file.name))
          continue
        }

        const rawText = await readFileText(file)
        payloads.push({
          name: file.name,
          size: (file.size / 1024).toFixed(1) + ' KB',
          type: detectType(file.name),
          content: { raw_content: rawText, file_type: file.name.split('.').pop() }
        })
      }

      if (payloads.length === 0) {
        setUploadStatus({ type: 'error', message: 'No templates found in uploaded files.' })
        return
      }

      const hasActive = templates.some(t => t.isActive)
      const created = []
      let shouldAssignActive = !hasActive

      for (const payload of payloads) {
        const next = await api.createMessageTemplate({
          ...payload,
          isActive: shouldAssignActive
        })
        if (shouldAssignActive) shouldAssignActive = false
        created.push(next)
      }

      const activeCreated = created.find(t => t.isActive)
      setTemplates(prev => {
        const nextPrev = activeCreated ? prev.map(t => ({ ...t, isActive: false })) : prev
        return [...created, ...nextPrev]
      })

      setUploadStatus({
        type: 'success',
        message: `Imported ${created.length} template${created.length > 1 ? 's' : ''} successfully.`
      })
    } catch (error) {
      setUploadStatus({ type: 'error', message: error.message || 'Failed to upload templates' })
    }
  }

  const downloadExample = () => {
    const blob = new Blob([EXAMPLE_TEMPLATE], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = 'example-template.json'; a.click()
    URL.revokeObjectURL(url)
  }

  const handlePasteJson = async () => {
    setPasteError(null)
    if (!pasteJson.trim()) {
      setPasteError('Please paste some JSON first.')
      return
    }
    try {
      const payloads = parseTemplatePayloadsFromJson(pasteJson.trim(), 'Pasted JSON')
      const hasActive = templates.some(t => t.isActive)
      const created = []
      let shouldAssignActive = !hasActive
      for (const payload of payloads) {
        const next = await api.createMessageTemplate({ ...payload, isActive: shouldAssignActive })
        if (shouldAssignActive) shouldAssignActive = false
        created.push(next)
      }
      const activeCreated = created.find(t => t.isActive)
      setTemplates(prev => {
        const nextPrev = activeCreated ? prev.map(t => ({ ...t, isActive: false })) : prev
        return [...created, ...nextPrev]
      })
      setPasteJson('')
      setShowPastePanel(false)
      setUploadStatus({ type: 'success', message: `Imported ${created.length} template${created.length > 1 ? 's' : ''} successfully.` })
    } catch (error) {
      setPasteError(error.message || 'Failed to import JSON')
    }
  }

  const removeTemplate = async (id) => {
    try {
      await api.deleteMessageTemplate(id)
      setTemplates(prev => prev.filter(t => t.id !== id))
    } catch (error) {
      alert(error.message || 'Failed to remove template')
    }
  }

  const toggleStatus = async (template) => {
    try {
      const updated = await api.updateMessageTemplate(template.id, { isActive: !template.isActive })
      setTemplates(prev => prev.map(t => {
        if (t.id === template.id) return updated
        if (updated.isActive) return { ...t, isActive: false }  // only one active
        return t
      }))
    } catch (error) {
      alert(error.message || 'Failed to update status')
    }
  }

  const counts = {
    messages: templates.filter(t => t.type === 'messages').length,
    sms: templates.filter(t => t.type === 'sms').length,
    email: templates.filter(t => t.type === 'email').length,
    whatsapp: templates.filter(t => t.type === 'whatsapp').length
  }

  return (
    <div>
      <div className="page-header">
        <h1>Message Templates</h1>
        <p>Upload and manage your message template documents</p>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-header">
          <h2>Upload Templates</h2>
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn btn-outline" onClick={() => { setShowPastePanel(v => !v); setPasteError(null) }}>
              📋 Paste JSON
            </button>
            <button className="btn btn-outline" onClick={() => setShowPreview(true)}>
              👁 Preview Example Template
            </button>
            <button className="btn btn-outline" onClick={downloadExample}>
              ⬇ Download Example Template
            </button>
          </div>
        </div>

        {uploadStatus && (
          <div className={`alert ${uploadStatus.type === 'success' ? 'alert-success' : 'alert-error'}`}>
            {uploadStatus.message}
          </div>
        )}

        <div
          className={`upload-zone${dragover ? ' dragover' : ''}`}
          onDragOver={e => { e.preventDefault(); setDragover(true) }}
          onDragLeave={() => setDragover(false)}
          onDrop={e => { e.preventDefault(); setDragover(false); handleFiles(e.dataTransfer.files) }}
          onClick={() => inputRef.current.click()}
        >
          <div className="upload-icon">📁</div>
          <p>Drag and drop your files here, or <span>browse</span></p>
          <small>Supported formats: TXT, JSON, MD, CSV, XML, YAML</small>
          <small>For JSON, upload either an object with a templates array or a template object/array directly.</small>
          <input
            ref={inputRef}
            type="file"
            accept=".txt,.json,.md,.csv,.xml,.yaml,.yml"
            multiple
            style={{ display: 'none' }}
            onChange={e => handleFiles(e.target.files)}
          />
        </div>

        {showPastePanel && (
          <div className="paste-json-panel">
            <div className="paste-json-header">
              <h3>Paste JSON Directly</h3>
              <button className="icon-btn" onClick={() => { setShowPastePanel(false); setPasteJson(''); setPasteError(null) }}>✕</button>
            </div>
            <textarea
              className="paste-json-area"
              rows={12}
              placeholder={`Paste your template JSON here...\n\nSupports:\n- Single template object\n- Array of templates  [ {...}, {...} ]\n- { "templates": [...] } wrapper\n- Multi-channel group with a "channels" array`}
              value={pasteJson}
              onChange={e => { setPasteJson(e.target.value); setPasteError(null) }}
            />
            {pasteError && <div className="alert alert-error" style={{ marginTop: 8 }}>{pasteError}</div>}
            <div className="paste-json-actions">
              <button className="btn btn-outline" onClick={() => { setShowPastePanel(false); setPasteJson(''); setPasteError(null) }}>Cancel</button>
              <button className="btn btn-primary" onClick={handlePasteJson}>Import JSON</button>
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-header">
          <h2>Uploaded Templates</h2>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {counts.messages > 0 && <span className="tag tag-messages">{counts.messages} Messages</span>}
            {counts.sms > 0 && <span className="tag tag-sms">{counts.sms} SMS</span>}
            {counts.email > 0 && <span className="tag tag-email">{counts.email} Email</span>}
            {counts.whatsapp > 0 && <span className="tag tag-whatsapp">{counts.whatsapp} WhatsApp</span>}
            <span className="badge">{templates.length} documents</span>
          </div>
        </div>

        {loading ? (
          <div className="empty-state">
            <p>Loading templates...</p>
          </div>
        ) : templates.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">📋</div>
            <p>No templates uploaded yet</p>
          </div>
        ) : (
          templates.map(t => (
            <div key={t.id} className="file-item">
              <div className="file-item-left">
                <span className="file-item-icon">📄</span>
                <div>
                  <div className="file-item-name">{t.name}</div>
                  <div className="file-item-size">{t.size}</div>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span className={`tag tag-${t.type}`}>{TYPE_LABELS[t.type] || t.type}</span>
                <button
                  className={`status-toggle ${t.isActive ? 'active' : 'inactive'}`}
                  onClick={() => toggleStatus(t)}
                  title="Toggle active status"
                >
                  {t.isActive ? 'Active' : 'Inactive'}
                </button>
                <button className="icon-btn danger" onClick={() => removeTemplate(t.id)} title="Remove">✕</button>
              </div>
            </div>
          ))
        )}
      </div>

      {showPreview && <PreviewModal onClose={() => setShowPreview(false)} />}
    </div>
  )
}
