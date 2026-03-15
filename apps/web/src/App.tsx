import { useState, useCallback } from 'react'
import { SdkProvider } from '@/contexts/SdkContext'
import { AuthProvider, useAuth } from '@/contexts/AuthContext'
import AuthForm from '@/components/auth/AuthForm'
import AppShell from '@/components/layout/AppShell'
import OnboardingFlow from '@/components/onboarding/OnboardingFlow'
import ErrorBoundary from '@/components/ErrorBoundary'

function AppContent() {
  const { user, loading } = useAuth()
  const [onboarded, setOnboarded] = useState<boolean | null>(null)

  // Check onboarding status when user changes
  const isOnboarded = useCallback(() => {
    if (!user) return false
    return localStorage.getItem(`zairn:onboarded:${user.id}`) === '1'
  }, [user])

  // Update onboarded state when user loads
  if (user && onboarded === null) {
    setOnboarded(isOnboarded())
  }
  if (!user && onboarded !== null) {
    setOnboarded(null)
  }

  if (loading) {
    return (
      <div
        className="flex items-center justify-center h-full"
        style={{ background: 'var(--md-surface)' }}
      >
        <div
          className="w-8 h-8 rounded-full border-3 border-t-transparent animate-spin"
          style={{ borderColor: 'var(--md-primary)', borderTopColor: 'transparent' }}
        />
      </div>
    )
  }

  if (!user) {
    return <AuthForm />
  }

  if (!onboarded) {
    return <OnboardingFlow onComplete={() => setOnboarded(true)} />
  }

  return <AppShell />
}

export default function App() {
  return (
    <ErrorBoundary>
      <SdkProvider>
        <AuthProvider>
          <AppContent />
        </AuthProvider>
      </SdkProvider>
    </ErrorBoundary>
  )
}
