import 'vite/client'

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string
  readonly VITE_WS_URL?: string
  readonly VITE_WS_PATH?: string
  readonly VITE_APP_DEFAULT_TOKEN?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
