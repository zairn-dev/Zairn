import { createContext, useContext, useMemo } from 'react'
import type { ReactNode } from 'react'
import { createLocationCore } from '@zairn/sdk'
import type { LocationCore } from '@zairn/sdk'

const SdkContext = createContext<LocationCore | null>(null)

export function SdkProvider({ children }: { children: ReactNode }) {
  const core = useMemo(() => {
    return createLocationCore({
      supabaseUrl: import.meta.env.VITE_SUPABASE_URL,
      supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY,
    })
  }, [])

  return <SdkContext.Provider value={core}>{children}</SdkContext.Provider>
}

export function useSdk(): LocationCore {
  const ctx = useContext(SdkContext)
  if (!ctx) throw new Error('useSdk must be used within a SdkProvider')
  return ctx
}
