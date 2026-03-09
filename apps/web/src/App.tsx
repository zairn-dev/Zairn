import { SdkProvider } from '@/contexts/SdkContext'
import { AuthProvider, useAuth } from '@/contexts/AuthContext'
import AuthForm from '@/components/auth/AuthForm'
import AppShell from '@/components/layout/AppShell'

function AppContent() {
  const { user, loading } = useAuth()

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

  return <AppShell />
}

export default function App() {
  return (
    <SdkProvider>
      <AuthProvider>
        <AppContent />
      </AuthProvider>
    </SdkProvider>
  )
}
