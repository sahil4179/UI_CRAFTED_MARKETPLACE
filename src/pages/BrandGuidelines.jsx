import { useEffect, useState, useRef } from 'react'
import { api } from '../api'

function generateExampleZip() {
  const content = 'colors.txt: primary=#4f46e5\ntypography.txt: font=Inter\nlogo.txt: url=https://example.com/logo.png'
  const blob = new Blob([content], { type: 'text/plain' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'brand-guidelines-example.txt'
  a.click()
  URL.revokeObjectURL(url)
}

function readFileText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}`))
    reader.readAsText(file)
  })
}

function parseBrandPayloadsFromJson(rawText, fileName) {
  let parsed
  try {
    parsed = JSON.parse(rawText)
  } catch {
    throw new Error(`${fileName}: invalid JSON format`)
  }

  let list = []
  if (Array.isArray(parsed)) list = parsed
  else if (Array.isArray(parsed?.documents)) list = parsed.documents
  else if (Array.isArray(parsed?.guidelines)) list = parsed.guidelines
  else if (parsed && typeof parsed === 'object') list = [parsed]

  const normalized = list
    .filter(item => item && typeof item === 'object')
    .map((item, idx) => {
      const name = String(item.name || item.filename || `${fileName} guideline ${idx + 1}`).trim()
      const fileType = String(item.fileType || item.type || 'json').toLowerCase()

      return {
        name,
        size: item.size ? String(item.size) : 'JSON import',
        fileType: fileType === 'rar' ? 'rar' : fileType === 'zip' ? 'zip' : 'json',
        content: item          // ← store the full guideline object as content
      }
    })

  if (normalized.length === 0) {
    throw new Error(`${fileName}: expected a guideline object or documents/guidelines array`)
  }

  return normalized
}

export default function BrandGuidelines() {
  const [documents, setDocuments] = useState([])
  const [dragover, setDragover] = useState(false)
  const [loading, setLoading] = useState(true)
  const [uploadStatus, setUploadStatus] = useState(null)
  const inputRef = useRef()

  useEffect(() => {
    const load = async () => {
      try {
        const data = await api.listBrandGuidelines()
        setDocuments(data)
      } catch (error) {
        alert(error.message || 'Failed to load brand guidelines')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  const handleFiles = async (files) => {
    setUploadStatus(null)
    const allowed = ['application/zip', 'application/x-rar-compressed', 'application/x-zip-compressed', 'application/octet-stream', 'application/json', 'text/json']
    const valid = Array.from(files).filter(f =>
      allowed.includes(f.type) || f.name.endsWith('.zip') || f.name.endsWith('.rar') || f.name.endsWith('.json')
    )
    if (valid.length === 0) {
      alert('Only ZIP, RAR and JSON files are supported.')
      return
    }

    try {
      const payloads = []

      for (const file of valid) {
        const lowerName = file.name.toLowerCase()
        if (lowerName.endsWith('.json')) {
          const rawText = await readFileText(file)
          payloads.push(...parseBrandPayloadsFromJson(rawText, file.name))
          continue
        }

        payloads.push({
          name: file.name,
          size: (file.size / 1024).toFixed(1) + ' KB',
          fileType: lowerName.endsWith('.rar') ? 'rar' : 'zip',
          content: { raw_content: null, file_type: lowerName.endsWith('.rar') ? 'rar' : 'zip' }
        })
      }

      if (payloads.length === 0) {
        setUploadStatus({ type: 'error', message: 'No brand guidelines found in uploaded files.' })
        return
      }

      const hasActive = documents.some(d => d.isActive)
      const created = []
      let shouldAssignActive = !hasActive

      for (const payload of payloads) {
        const next = await api.createBrandGuideline({
          ...payload,
          isActive: shouldAssignActive
        })
        if (shouldAssignActive) shouldAssignActive = false
        created.push(next)
      }

      const activeCreated = created.find(d => d.isActive)
      setDocuments(prev => {
        const nextPrev = activeCreated ? prev.map(d => ({ ...d, isActive: false })) : prev
        return [...created, ...nextPrev]
      })

      setUploadStatus({
        type: 'success',
        message: `Imported ${created.length} guideline${created.length > 1 ? 's' : ''} successfully.`
      })
    } catch (error) {
      setUploadStatus({ type: 'error', message: error.message || 'Failed to upload documents' })
    }
  }

  const handleDrop = (e) => {
    e.preventDefault()
    setDragover(false)
    handleFiles(e.dataTransfer.files)
  }

  const removeDoc = async (id) => {
    try {
      await api.deleteBrandGuideline(id)
      setDocuments(prev => prev.filter(d => d.id !== id))
    } catch (error) {
      alert(error.message || 'Failed to delete document')
    }
  }

  const toggleStatus = async (doc) => {
    try {
      const updated = await api.updateBrandGuideline(doc.id, { isActive: !doc.isActive })
      setDocuments(prev => prev.map(item => {
        if (item.id === doc.id) return updated
        if (updated.isActive) return { ...item, isActive: false }  // only one active
        return item
      }))
    } catch (error) {
      alert(error.message || 'Failed to update status')
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>Brand Guidelines</h1>
        <p>Upload and manage your brand documents</p>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-header">
          <h2>Upload Documents</h2>
          <button className="btn btn-outline" onClick={generateExampleZip}>
            ⬇ Download Example
          </button>
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
          onDrop={handleDrop}
          onClick={() => inputRef.current.click()}
        >
          <div className="upload-icon">📁</div>
          <p>Drag and drop your files here, or <span>browse</span></p>
          <small>Supported formats: ZIP, RAR, JSON</small>
          <small>Upload a ZIP file containing your brand token files (colors.txt, typography.txt, etc.)</small>
          <small>For JSON, upload an object, an array, or a documents/guidelines array.</small>
          <input
            ref={inputRef}
            type="file"
            accept=".zip,.rar,.json"
            multiple
            style={{ display: 'none' }}
            onChange={e => handleFiles(e.target.files)}
          />
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h2>Uploaded Documents</h2>
          <span className="badge">{documents.length} documents</span>
        </div>

        {loading ? (
          <div className="empty-state">
            <p>Loading documents...</p>
          </div>
        ) : documents.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">📋</div>
            <p>No documents uploaded yet</p>
          </div>
        ) : (
          documents.map(doc => (
            <div key={doc.id} className="file-item">
              <div className="file-item-left">
                <span className="file-item-icon">🗜</span>
                <div>
                  <div className="file-item-name">{doc.name}</div>
                  <div className="file-item-size">{doc.size} · {doc.fileType?.toUpperCase() || 'ZIP'}</div>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <button
                  className={`status-toggle ${doc.isActive ? 'active' : 'inactive'}`}
                  onClick={() => toggleStatus(doc)}
                  title="Toggle active status"
                >
                  {doc.isActive ? 'Active' : 'Inactive'}
                </button>
                <button className="icon-btn danger" onClick={() => removeDoc(doc.id)} title="Remove">✕</button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
