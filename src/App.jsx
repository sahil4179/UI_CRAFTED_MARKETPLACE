import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import Sidebar from './components/Sidebar'
import Dashboard from './pages/Dashboard'
import BrandGuidelines from './pages/BrandGuidelines'
import PromptOverride from './pages/PromptOverride'
import MessageTemplate from './pages/MessageTemplate'
import ApiSettings from './pages/ApiSettings'
import Login from './pages/Login'

function getSession() {
  try { return JSON.parse(sessionStorage.getItem('tenant_session') || 'null') } catch { return null }
}

function ProtectedLayout() {
  const session = getSession()
  // session must have dbName — if missing it's an old/invalid session, force re-login
  if (!session?.dbName) {
    sessionStorage.removeItem('tenant_session')
    return <Navigate to="/login" replace />
  }
  return (
    <div className="app-layout">
      <Sidebar />
      <main className="main-content">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/brand-guidelines" element={<BrandGuidelines />} />
          <Route path="/prompt-override" element={<PromptOverride />} />
          <Route path="/message-template" element={<MessageTemplate />} />
          <Route path="/api-settings" element={<ApiSettings />} />
        </Routes>
      </main>
    </div>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/*" element={<ProtectedLayout />} />
      </Routes>
    </BrowserRouter>
  )
}
