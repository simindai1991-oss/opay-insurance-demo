/** Demo runtime config. Pages workflow forces mode: 'static'. */
window.DEMO_CONFIG = {
  mode: 'auto', // 'auto' | 'api' | 'static'
  apiBase: '',
  seedBase: 'data/seed',
  storageKey: 'opay_insurance_demo_v4',
  modeOverrideKey: 'opay_insurance_demo_mode_override',
  payProcessingMs: 2000,
  activatePendingMs: 5000,
  demoLocation: { lat: 6.5244, lng: 3.3792, label: 'Lagos (demo)' },
  nearbyRadiusKm: 50,
};
