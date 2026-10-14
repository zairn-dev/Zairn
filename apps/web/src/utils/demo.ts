// Sample data is a dev/demo aid. In production a real user with no data yet
// must see their true (empty) state, not invented pins or cells — so demo
// data is off unless in dev mode or explicitly enabled via VITE_DEMO_DATA.
export const DEMO_DATA_ENABLED =
  import.meta.env.DEV || import.meta.env.VITE_DEMO_DATA === 'true'
