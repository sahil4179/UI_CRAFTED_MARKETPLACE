import { useEffect, useState, useRef } from 'react'
import { api } from '../api'

export default function BrandGuidelines() {
  const [documents, setDocuments] = useState([])
  const [dragover, setDragover] = useState(false)
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
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
    const valid = Array.from(files).filter(f => f.name.toLowerCase().endsWith('.zip'))
    if (valid.length === 0) {
      setUploadStatus({ type: 'error', message: 'Only ZIP archives are accepted for brand guidelines.' })
      return
    }

    // Upload one zip at a time (take the first valid one)
    const file = valid[0]
    setUploading(true)
    try {
      const created = await api.uploadBrandGuidelineZip(file)
      setDocuments(prev => {
        // Deactivate existing docs locally if the new set has an active one
        const hasActive = created.some(d => d.isActive)
        const updated = hasActive ? prev.map(d => ({ ...d, isActive: false })) : prev
        return [...created, ...updated]
      })
      setUploadStatus({
        type: 'success',
        message: `Extracted ${created.length} file${created.length !== 1 ? 's' : ''} from ${file.name} successfully.`,
      })
    } catch (error) {
      setUploadStatus({ type: 'error', message: error.message || 'Failed to upload ZIP archive' })
    } finally {
      setUploading(false)
      // Reset input so the same file can be re-selected after deletion
      if (inputRef.current) inputRef.current.value = ''
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
        if (updated.isActive) return { ...item, isActive: false }
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
          <button className="btn btn-outline" onClick={() => api.downloadBrandGuidelineExample()}>
            ⬇ Download Example
          </button>
        </div>

        {uploadStatus && (
          <div className={`alert ${uploadStatus.type === 'success' ? 'alert-success' : 'alert-error'}`}>
            {uploadStatus.message}
          </div>
        )}

        <div
          className={`upload-zone${dragover ? ' dragover' : ''}${uploading ? ' uploading' : ''}`}
          onDragOver={e => { e.preventDefault(); setDragover(true) }}
          onDragLeave={() => setDragover(false)}
          onDrop={handleDrop}
          onClick={() => !uploading && inputRef.current.click()}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".zip"
            style={{ display: 'none' }}
            onChange={e => handleFiles(e.target.files)}
          />
          {uploading ? (
            <>
              <div className="upload-icon">⏳</div>
              <p>Uploading and extracting archive…</p>
            </>
          ) : (
            <>
              <div className="upload-icon">📁</div>
              <p>Drag and drop your ZIP file here, or <span>browse</span></p>
              <small>Supported format: ZIP · File must be named brand-guidelines.zip</small>
              <small>Expected files: colors.json, typography.json, spacing.json, borderRadius.json, shadows.json</small>
              <small>Also accepts: .txt, .md, .csv, .xml, .yaml, .yml inside the archive</small>
            </>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h2>Uploaded Documents</h2>
          <span className="badge">{documents.length} documents</span>
        </div>

        {loading ? (
          <div className="empty-state">
            <p>Loading documents…</p>
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
                  <div className="file-item-size">
                    {doc.size && `${doc.size} · `}
                    {(doc.fileType || 'zip').replace(/^\./, '').toUpperCase()}
                    {doc.sourceArchive && (
                      <span style={{ marginLeft: 6, opacity: 0.6 }}>from {doc.sourceArchive}</span>
                    )}
                  </div>
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
