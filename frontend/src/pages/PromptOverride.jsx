import { useEffect, useState } from 'react'
import { api } from '../api'

function PromptModal({ initial, onSave, onClose, fixedSystemPrompt }) {
  const [title, setTitle] = useState(initial?.title || '')
  const systemPrompt = initial?.systemPrompt || fixedSystemPrompt || ''
  const [content, setContent] = useState(initial?.content || '')

  const handleSubmit = (e) => {
    e.preventDefault()
    if (!title.trim()) { alert('Title is required'); return }
    if (!content.trim()) { alert('User Prompt is required'); return }
    onSave({ title: title.trim(), content: content.trim() })
  }

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 640 }}>
        <h3>{initial ? 'Edit Prompt' : 'Add New Prompt'}</h3>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Title</label>
            <input
              type="text"
              placeholder="Enter prompt title"
              value={title}
              onChange={e => setTitle(e.target.value)}
              autoFocus
            />
          </div>
          <div className="form-group">
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              System Prompt
              <span style={{ fontSize: 11, color: '#9ca3af', fontWeight: 400 }}>(read-only)</span>
            </label>
            <textarea
              value={systemPrompt}
              readOnly
              placeholder="No system prompt set"
              style={{ minHeight: 90, background: '#f3f4f6', color: '#6b7280', cursor: 'not-allowed', resize: 'none' }}
            />
          </div>
          <div className="form-group">
            <label>User Prompt</label>
            <textarea
              placeholder="Enter user prompt / task instructions..."
              value={content}
              onChange={e => setContent(e.target.value)}
              style={{ minHeight: 90 }}
            />
          </div>
          <div className="modal-actions">
            <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary">{initial ? 'Save Changes' : 'Add Prompt'}</button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default function PromptOverride() {
  const [prompts, setPrompts] = useState([])
  const [fixedSystemPrompt, setFixedSystemPrompt] = useState('')
  const [showModal, setShowModal] = useState(false)
  const [editingPrompt, setEditingPrompt] = useState(null)

  useEffect(() => {
    const load = async () => {
      try {
        const [data, systemPromptPayload] = await Promise.all([
          api.listPrompts(),
          api.getSystemPrompt(),
        ])
        setPrompts(data)
        setFixedSystemPrompt(systemPromptPayload?.systemPrompt || '')
      } catch (error) {
        alert(error.message || 'Failed to load prompts')
      }
    }
    load()
  }, [])

  const openAdd = () => { setEditingPrompt(null); setShowModal(true) }
  const openEdit = (p) => { setEditingPrompt(p); setShowModal(true) }

  const handleSave = async (data) => {
    try {
      if (editingPrompt) {
        const updated = await api.updatePrompt(editingPrompt.id, data)
        setPrompts(prev => prev.map(p => {
          if (p.id === editingPrompt.id) return updated
          if (updated.isActive) return { ...p, isActive: false }
          return p
        }))
      } else {
        const created = await api.createPrompt({ ...data, isActive: true })
        setPrompts(prev => [created, ...prev.map(p => (created.isActive ? { ...p, isActive: false } : p))])
      }
      setShowModal(false)
    } catch (error) {
      alert(error.message || 'Failed to save prompt')
    }
  }

  const deletePrompt = async (id) => {
    if (window.confirm('Delete this prompt?')) {
      try {
        await api.deletePrompt(id)
        setPrompts(prev => prev.filter(p => p.id !== id))
      } catch (error) {
        alert(error.message || 'Failed to delete prompt')
      }
    }
  }

  const toggleStatus = async (prompt) => {
    try {
      const updated = await api.updatePrompt(prompt.id, { isActive: !prompt.isActive })
      setPrompts(prev => prev.map(p => {
        if (p.id === prompt.id) return updated
        if (updated.isActive) return { ...p, isActive: false }  // only one active
        return p
      }))
    } catch (error) {
      alert(error.message || 'Failed to update status')
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>Prompt Override</h1>
        <p>Add and manage custom prompts and instructions</p>
      </div>

      <div className="card">
        <div className="card-header">
          <h2>Prompts</h2>
          <button className="btn btn-primary" onClick={openAdd}>+ Add Prompt</button>
        </div>

        {prompts.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">✎</div>
            <p>No prompts created yet</p>
            <button className="btn btn-primary" onClick={openAdd}>Create Your First Prompt</button>
          </div>
        ) : (
          prompts.map(p => (
            <div key={p.id} className="prompt-card">
              <div className="prompt-card-body">
                <h4>{p.title}</h4>
                {p.systemPrompt && (
                  <div style={{ marginBottom: 6 }}>
                    <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', color: '#6366f1', letterSpacing: 0.5 }}>System Prompt</span>
                    <p style={{ margin: '2px 0 0', whiteSpace: 'pre-wrap', color: '#374151' }}>{p.systemPrompt}</p>
                  </div>
                )}
                {p.content && (
                  <div>
                    <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', color: '#10b981', letterSpacing: 0.5 }}>User Prompt</span>
                    <p style={{ margin: '2px 0 0', whiteSpace: 'pre-wrap', color: '#374151' }}>{p.content}</p>
                  </div>
                )}
              </div>
              <div className="prompt-actions">
                <button
                  className={`status-toggle ${p.isActive ? 'active' : 'inactive'}`}
                  onClick={() => toggleStatus(p)}
                  title="Toggle active status"
                >
                  {p.isActive ? 'Active' : 'Inactive'}
                </button>
                <button className="icon-btn" onClick={() => openEdit(p)} title="Edit">✏</button>
                <button className="icon-btn danger" onClick={() => deletePrompt(p.id)} title="Delete">🗑</button>
              </div>
            </div>
          ))
        )}
      </div>

      {showModal && (
        <PromptModal
          initial={editingPrompt}
          fixedSystemPrompt={fixedSystemPrompt}
          onSave={handleSave}
          onClose={() => setShowModal(false)}
        />
      )}
    </div>
  )
}
