// AquaInfinity Admin Console — connection config.
//
// These are the PUBLIC project URL + anon key (the same pair shipped inside the
// Flutter app). They are safe to expose in a browser: every table is protected
// by Row Level Security and admin-only operations go through `is_admin()` /
// `set_user_role`. A non-admin who signs in here can read/do nothing.
//
// To point this console at a different project, edit the two values below.
window.AQUA_CONFIG = {
  SUPABASE_URL: 'https://vrwwulzwtetrohmtruqo.supabase.co',
  SUPABASE_ANON_KEY:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZyd3d1bHp3dGV0cm9obXRydXFvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA3NDM4NjYsImV4cCI6MjA5NjMxOTg2Nn0.9pfTSY4A1sAVBAWsZcjP-llAcr-Y81LxoDD57ML74P8',
};
