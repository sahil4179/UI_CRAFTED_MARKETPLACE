import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'

export default function Login() {
  const [form, setForm] = useState({ email: '', password: '' })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()

  const set = (field) => (e) => setForm(prev => ({ ...prev, [field]: e.target.value }))

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const session = await api.login({ email: form.email, password: form.password })
      sessionStorage.setItem('tenant_session', JSON.stringify(session))
      navigate('/')
    } catch (err) {
      setError(err.message || 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">

        <div className="login-logo-wrap">
          <div className="login-logo-icon">✦</div>
        </div>
        <h1 className="login-title">Welcome back</h1>
        <p className="login-sub">Sign in to your AI workspace</p>

        <form onSubmit={submit} className="login-form">
          <div className="login-field">
            <label>Work Email</label>
            <input
              type="email"
              placeholder="you@company.com"
              value={form.email}
              onChange={set('email')}
              required
              autoFocus
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
            {loading ? 'Signing in…' : 'Sign In'}
          </button>
        </form>

        <p className="login-footer-note">
          Access is managed by your organization administrator.
        </p>

      </div>
    </div>
  )
}
