import { useState } from 'react'
import type { FormEvent } from 'react'
import { useAuth } from '@/contexts/AuthContext'

export default function AuthForm() {
  const { signIn, signUp } = useAuth()
  const [isSignUp, setIsSignUp] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    setSubmitting(true)

    try {
      if (isSignUp) {
        await signUp(email, password)
      } else {
        await signIn(email, password)
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="flex items-center justify-center h-full px-4"
      style={{ background: 'var(--md-surface)' }}
    >
      <div
        className="w-full max-w-sm rounded-2xl p-8"
        style={{
          background: 'var(--md-surface-container)',
          boxShadow: '0 4px 24px var(--md-shadow)',
        }}
      >
        <h1
          className="text-2xl font-bold text-center mb-1"
          style={{ color: 'var(--md-primary)' }}
        >
          GeoDrop
        </h1>
        <p
          className="text-sm text-center mb-6"
          style={{ color: 'var(--md-on-surface-variant)' }}
        >
          {isSignUp ? 'Create your account' : 'Location-bound encrypted content'}
        </p>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="rounded-xl px-4 py-3 text-sm border-none outline-none"
            style={{
              background: 'var(--md-surface-container-high)',
              color: 'var(--md-on-surface)',
            }}
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={6}
            className="rounded-xl px-4 py-3 text-sm border-none outline-none"
            style={{
              background: 'var(--md-surface-container-high)',
              color: 'var(--md-on-surface)',
            }}
          />

          {error && (
            <p
              className="text-xs m-0 px-1"
              style={{ color: 'var(--md-error)' }}
            >
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="rounded-xl py-3 text-sm font-semibold border-none cursor-pointer transition-opacity disabled:opacity-60"
            style={{
              background: 'var(--md-primary)',
              color: 'var(--md-on-primary)',
            }}
          >
            {submitting ? '...' : isSignUp ? 'Sign Up' : 'Sign In'}
          </button>
        </form>

        <p
          className="text-xs text-center mt-4 mb-0"
          style={{ color: 'var(--md-on-surface-variant)' }}
        >
          {isSignUp ? 'Already have an account?' : "Don't have an account?"}{' '}
          <button
            onClick={() => {
              setIsSignUp(!isSignUp)
              setError(null)
            }}
            className="bg-transparent border-none cursor-pointer underline p-0 text-xs"
            style={{ color: 'var(--md-primary)' }}
          >
            {isSignUp ? 'Sign In' : 'Sign Up'}
          </button>
        </p>
      </div>
    </div>
  )
}
