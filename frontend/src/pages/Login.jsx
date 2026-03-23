import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'

export default function Login() {
  const [mode, setMode] = useState('login')   // 'login' | 'register'
  const [form, setForm] = useState({ email: '', password: '', companyName: '' })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()

  const set = (field) => (e) => setForm(prev => ({ ...prev, [field]: e.target.value }))

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const session =
        mode === 'login'
          ? await api.login({ email: form.email, password: form.password })
          : await api.register({ email: form.email, password: form.password, companyName: form.companyName })
      sessionStorage.setItem('tenant_session', JSON.stringify(session))
      navigate('/')
    } catch (err) {
      setError(err.message || 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  const switchMode = (next) => {
    setMode(next)
    setError('')
    setForm({ email: '', password: '', companyName: '' })
  }

  return (
    <div className="login-page">
      <div className="login-card">

        <div className="login-logo">⚙</div>
        <h1 className="login-title">Marketplace Admin</h1>
        <p className="login-sub">
          {mode === 'login' ? 'Sign in to your company account' : 'Register your company to get started'}
        </p>

        {mode === 'register' && (
          <div className="tenant-badge">
            A unique Tenant ID will be created for your company
          </div>
        )}

        <form onSubmit={submit} className="login-form">
          {mode === 'register' && (
            <div className="login-field">
              <label>Company Name</label>
              <input
                type="text"
                placeholder="e.g. Indigo Airlines"
                value={form.companyName}
                onChange={set('companyName')}
                required
                autoFocus
              />
            </div>
          )}

          <div className="login-field">
            <label>Work Email</label>
            <input
              type="email"
              placeholder="you@company.com"
              value={form.email}
              onChange={set('email')}
              required
              autoFocus={mode === 'login'}
            />
          </div>

          <div className="login-field">
            <label>Password</label>
            <input
              type="password"
              placeholder="••••••••"
              value={form.password}
              onChange={set('password')}
              required
              minLength={6}
            />
          </div>

          {error && <div className="login-error">⚠ {error}</div>}

          <button type="submit" className="login-btn" disabled={loading}>
            {loading ? 'Please wait…' : mode === 'login' ? 'Sign In' : 'Create Account'}
          </button>
        </form>

        <div className="login-switch">
          {mode === 'login' ? (
            <>New company?{' '}
              <button type="button" onClick={() => switchMode('register')}>
                Create an account
              </button>
            </>
          ) : (
            <>Already registered?{' '}
              <button type="button" onClick={() => switchMode('login')}>
                Sign in
              </button>
            </>
          )}
        </div>

      </div>
    </div>
  )
}
