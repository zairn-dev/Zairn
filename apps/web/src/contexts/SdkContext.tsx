import { createContext, useContext, useMemo } from 'react'
import type { ReactNode } from 'react'
import { createLocationCore } from '@zairn/sdk'
import type { LocationCore } from '@zairn/sdk'

const SdkContext = createContext<LocationCore | null>(null)

export function SdkProvider({ children }: { children: ReactNode }) {
  const core = useMemo(() => {
    const url = import.meta.env.VITE_SUPABASE_URL
    const key = import.meta.env.VITE_SUPABASE_ANON_KEY
    if (!url || !key) {
      throw new Error('Missing Supabase configuration. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.')
    }
    return createLocationCore({ supabaseUrl: url, supabaseAnonKey: key })
  }, [])

  return <SdkContext.Provider value={core}>{children}</SdkContext.Provider>
}

export function useSdk(): LocationCore {
  const ctx = useContext(SdkContext)
  if (!ctx) throw new Error('useSdk must be used within a SdkProvider')
  return ctx
}
