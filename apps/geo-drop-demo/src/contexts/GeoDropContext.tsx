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

    // SECURITY: never read an IPFS pinning key from a VITE_* variable — Vite
    // inlines it into the client bundle, exposing the Pinata JWT to every
    // visitor (see apps/geo-drop-demo/.env.example warning). Pinning must run
    // server-side via the ipfs-proxy Edge Function, which holds the key in its
    // environment. This demo therefore uses db-only persistence; to enable
    // durable IPFS storage, deploy `supabase/functions/ipfs-proxy` and set
    // `ipfsProxyUrl` (defaults to `${supabaseUrl}/functions/v1/ipfs-proxy`).
    const sdk = createGeoDrop({
      supabaseUrl,
      supabaseAnonKey,
      persistence: {
        level: 'db-only' as const,
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
