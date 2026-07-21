import { createContext, useContext, useMemo } from 'react'
import type { ReactNode } from 'react'
import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createGeoDrop } from '@zairn/geo-drop'
import type { GeoDropSDK } from '@zairn/geo-drop'

interface GeoDropContextValue {
  sdk: GeoDropSDK
  supabase: SupabaseClient
}

const GeoDropContext = createContext<GeoDropContextValue | null>(null)

export function GeoDropProvider({ children }: { children: ReactNode }) {
  const value = useMemo(() => {
    const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
    const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

    const supabase = createClient(supabaseUrl, supabaseAnonKey)
    const ipfsProxyUrl = import.meta.env.VITE_IPFS_PROXY_URL as string | undefined

    const sdk = createGeoDrop({
      supabaseUrl,
      supabaseAnonKey,
      ipfs: ipfsProxyUrl ? {
        gateway: 'https://gateway.pinata.cloud/ipfs',
        pinningService: 'custom' as const,
        customPinningUrl: ipfsProxyUrl,
        getCustomPinningHeaders: async () => {
          const { data: { session }, error } = await supabase.auth.getSession()
          if (error) throw error
          if (!session?.access_token) throw new Error('Sign in before uploading to IPFS')
          return {
            Authorization: `Bearer ${session.access_token}`,
            apikey: supabaseAnonKey,
          }
        },
      } : undefined,
      persistence: {
        level: ipfsProxyUrl ? 'ipfs' as const : 'db-only' as const,
      },
    })

    return { sdk, supabase }
  }, [])

  return (
    <GeoDropContext.Provider value={value}>{children}</GeoDropContext.Provider>
  )
}

export function useGeoDrop(): GeoDropContextValue {
  const ctx = useContext(GeoDropContext)
  if (!ctx) throw new Error('useGeoDrop must be used within a GeoDropProvider')
  return ctx
}
