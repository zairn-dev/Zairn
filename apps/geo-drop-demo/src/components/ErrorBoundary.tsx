import { Component } from 'react'
import type { ReactNode, ErrorInfo } from 'react'

interface Props {
  children: ReactNode
  fallback?: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('ErrorBoundary caught:', error, info.componentStack)
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback
      return (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          height: '100%', padding: 24, textAlign: 'center',
          background: 'var(--md-error-container)', color: 'var(--md-on-error-container)',
          borderRadius: 16, margin: 8,
        }}>
          <h2 style={{ margin: '0 0 8px', fontSize: '1.1rem' }}>Something went wrong</h2>
          <p style={{ margin: '0 0 16px', fontSize: '0.85rem', opacity: 0.8 }}>
            {this.state.error?.message ?? 'An unexpected error occurred'}
          </p>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            style={{
              padding: '8px 20px', borderRadius: 12, border: 'none',
              background: 'var(--md-error)', color: 'var(--md-on-error)',
              fontSize: '0.85rem', fontWeight: 500, cursor: 'pointer',
            }}
          >
            Try Again
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
