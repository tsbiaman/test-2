import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import './App.css'

type Message = {
  id: string
  author: string
  content: string
  timestamp: string
}

type Presence = {
  clients: number
  authorized: number
}

type SocketEnvelope = {
  event: string
  payload?: Record<string, unknown>
}

const storageKey = 'realtime-app-token'

const safeReadStorage = (key: string): string | null => {
  try {
    return typeof window !== 'undefined' ? window.localStorage.getItem(key) : null
  } catch (_error) {
    return null
  }
}

const safeWriteStorage = (key: string, value: string) => {
  try {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(key, value)
    }
  } catch (_error) {
    /* ignore storage failures */
  }
}

const deriveApiBase = () => {
  const configured = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim()
  if (configured) {
    return configured
  }

  if (typeof window === 'undefined') {
    return 'http://localhost:4000'
  }

  const { protocol, host, hostname } = window.location
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return 'http://localhost:4000'
  }

  const scheme = protocol === 'https:' ? 'https' : 'http'
  if (host.startsWith('api.')) {
    return `${scheme}://${host}`
  }

  return `${scheme}://api.${host}`
}

const deriveWsUrl = (apiBase: string) => {
  const configured = (import.meta.env.VITE_WS_URL as string | undefined)?.trim()
  if (configured) {
    return configured
  }

  const wsPath = (import.meta.env.VITE_WS_PATH as string | undefined)?.trim() || '/ws'
  try {
    const url = new URL(apiBase)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.pathname = wsPath.startsWith('/') ? wsPath : `/${wsPath}`
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch (_error) {
    return apiBase.replace(/^http/, 'ws').replace(/\/$/, '') + wsPath
  }
}

const useInitialToken = () => {
  const stored = safeReadStorage(storageKey)
  if (stored) {
    return stored.trim()
  }

  const fallback = (import.meta.env.VITE_APP_DEFAULT_TOKEN as string | undefined)?.trim()
  if (fallback) {
    safeWriteStorage(storageKey, fallback)
    return fallback
  }

  return ''
}

const formatTimestamp = (input: string, formatter: Intl.DateTimeFormat) => {
  try {
    return formatter.format(new Date(input))
  } catch (_error) {
    return input
  }
}

const sortMessages = (items: Message[]) =>
  [...items].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  )

const App = () => {
  const apiBase = useMemo(() => deriveApiBase(), [])
  const wsUrl = useMemo(() => deriveWsUrl(apiBase), [apiBase])
  const timeFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(undefined, {
        dateStyle: 'short',
        timeStyle: 'medium',
      }),
    [],
  )

  const wsRef = useRef<WebSocket | null>(null)
  const reconnectRef = useRef(true)
  const reconnectTimer = useRef<number | null>(null)

  const [messages, setMessages] = useState<Message[]>([])
  const [wsStatus, setWsStatus] = useState<'connecting' | 'connected' | 'disconnected'>(
    'disconnected',
  )
  const [presence, setPresence] = useState<Presence>({ clients: 0, authorized: 0 })
  const [requiresAuth, setRequiresAuth] = useState(false)
  const [authorized, setAuthorized] = useState(false)
  const [author, setAuthor] = useState('')
  const [content, setContent] = useState('')
  const [postPending, setPostPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [token, setToken] = useState(() => useInitialToken())

  const clearTimers = () => {
    if (reconnectTimer.current) {
      window.clearTimeout(reconnectTimer.current)
      reconnectTimer.current = null
    }
  }

  const upsertMessages = useCallback((incoming: Message | Message[]) => {
    const payloadArray = Array.isArray(incoming) ? incoming : [incoming]
    setMessages((prev: Message[]) => {
      const next = [...prev]
      let mutated = false

      for (const message of payloadArray) {
        const index = next.findIndex((item) => item.id === message.id)
        if (index >= 0) {
          next[index] = message
          mutated = true
        } else {
          next.push(message)
          mutated = true
        }
      }

      return mutated ? sortMessages(next) : prev
    })
  }, [])

  const handleSocketMessage = useCallback(
    (event: MessageEvent<string>) => {
      try {
        const data = JSON.parse(event.data) as SocketEnvelope
        switch (data.event) {
          case 'connection:ack': {
            const history = (data.payload?.history as Message[]) || []
            if (history.length > 0) {
              upsertMessages(history)
            }
            setRequiresAuth(Boolean(data.payload?.requiresAuth))
            const authorizedFlag = Boolean(data.payload?.authorized)
            setAuthorized(authorizedFlag)
            const presencePayload = data.payload?.presence as Presence | undefined
            if (presencePayload) {
              setPresence(presencePayload)
            }
            setInfo('Connected to realtime gateway')
            setError(null)
            break
          }
          case 'auth:ok': {
            setAuthorized(true)
            const presencePayload = data.payload?.presence as Presence | undefined
            if (presencePayload) {
              setPresence(presencePayload)
            }
            setInfo('Authentication accepted')
            break
          }
          case 'auth:error': {
            setAuthorized(false)
            setError('Authentication failed for WebSocket connection')
            break
          }
          case 'message:created': {
            const message = data.payload as Message
            if (message?.id) {
              upsertMessages(message)
            }
            break
          }
          case 'message:ack': {
            const message = data.payload as Message
            if (message?.id) {
              upsertMessages(message)
            }
            break
          }
          case 'presence:update': {
            const presencePayload = data.payload as Presence
            if (presencePayload?.clients !== undefined) {
              setPresence(presencePayload)
            }
            break
          }
          case 'error': {
            const message = (data.payload?.message as string) || 'Unknown websocket error'
            setError(message)
            break
          }
          default:
            break
        }
      } catch (err) {
        setError(`Failed to parse websocket message: ${(err as Error).message}`)
      }
    },
    [upsertMessages],
  )

  useEffect(() => {
    let cancelled = false
    reconnectRef.current = true

    const connect = (attempt = 0) => {
      if (cancelled) {
        return
      }

      clearTimers()
      setWsStatus('connecting')

      const sanitizedToken = token.trim()
      const tokenSuffix = sanitizedToken
        ? `${wsUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(sanitizedToken)}`
        : ''
      const socket = new WebSocket(`${wsUrl}${tokenSuffix}`)
      wsRef.current = socket

      socket.addEventListener('open', () => {
        if (cancelled) {
          return
        }
        setWsStatus('connected')
        setInfo('WebSocket connected')
      })

      socket.addEventListener('message', handleSocketMessage)

      socket.addEventListener('close', () => {
        if (cancelled) {
          return
        }

        setWsStatus('disconnected')
        setAuthorized(false)

        if (!reconnectRef.current) {
          return
        }

        const nextAttempt = attempt + 1
        const delay = Math.min(10000, 1000 * 2 ** nextAttempt)
        reconnectTimer.current = window.setTimeout(() => connect(nextAttempt), delay)
      })

      socket.addEventListener('error', () => {
        setError('WebSocket connection error')
      })
    }

    connect()

    return () => {
      cancelled = true
      reconnectRef.current = false
      clearTimers()
      wsRef.current?.removeEventListener('message', handleSocketMessage)
      wsRef.current?.close(1000, 'Client navigation')
      wsRef.current = null
    }
  }, [handleSocketMessage, token, wsUrl])

  useEffect(() => {
    const socket = wsRef.current
    const sanitizedToken = token.trim()
    if (!socket || socket.readyState !== WebSocket.OPEN || !sanitizedToken) {
      return
    }

    socket.send(
      JSON.stringify({
        event: 'auth',
        payload: { token: sanitizedToken },
      }),
    )
  }, [token])

  useEffect(() => {
    let aborted = false

    const fetchInitialData = async () => {
      try {
        const [healthResponse, messagesResponse] = await Promise.all([
          fetch(`${apiBase}/api/health`, { cache: 'no-store' }),
          fetch(`${apiBase}/api/messages`, { cache: 'no-store' }),
        ])

        if (!aborted && healthResponse.ok) {
          const health = await healthResponse.json()
          setRequiresAuth(Boolean(health.requiresAuth))
          if (health.clients !== undefined) {
            setPresence({
              clients: Number(health.clients) || 0,
              authorized: Number(health.authorized || 0),
            })
          }
        }

        if (!aborted && messagesResponse.ok) {
          const result = await messagesResponse.json()
          const incoming = (result.messages as Message[]) || []
          if (incoming.length > 0) {
            upsertMessages(incoming)
          }
        }
      } catch (err) {
        if (!aborted) {
          setError(`Failed to fetch initial data: ${(err as Error).message}`)
        }
      }
    }

    fetchInitialData()

    return () => {
      aborted = true
    }
  }, [apiBase, upsertMessages])

  useEffect(() => {
    safeWriteStorage(storageKey, token.trim())
  }, [token])

  const handleRestSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    const sanitizedToken = token.trim()

    if (!content.trim()) {
      setError('Message body cannot be empty')
      return
    }

    if (requiresAuth && !sanitizedToken) {
      setError('Authentication token required to publish')
      return
    }

    setPostPending(true)
    setError(null)
    setInfo(null)

    try {
      const response = await fetch(`${apiBase}/api/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(sanitizedToken ? { 'X-API-KEY': sanitizedToken } : {}),
        },
        body: JSON.stringify({
          author: author.trim() || undefined,
          content,
        }),
      })

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}))
        throw new Error(payload.message || 'Failed to post message')
      }

      setContent('')
      setInfo('Message submitted via REST API')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setPostPending(false)
    }
  }

  const handleWebSocketPublish = () => {
    const sanitizedToken = token.trim()

    if (!content.trim()) {
      setError('Message body cannot be empty')
      return
    }

    if (requiresAuth && !sanitizedToken) {
      setError('Authentication token required to publish')
      return
    }

    const socket = wsRef.current
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setError('WebSocket is not connected')
      return
    }

    socket.send(
      JSON.stringify({
        event: 'message:create',
        payload: {
          author: author.trim() || undefined,
          content,
            token: sanitizedToken || undefined,
        },
      }),
    )

    setContent('')
    setInfo('Message sent via WebSocket')
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <h1>Realtime Messaging Console</h1>
          <p className="subtitle">
            Observability dashboard for the REST and WebSocket messaging service.
          </p>
        </div>
        <dl className="status-grid" aria-label="Connection status">
          <div>
            <dt>WebSocket</dt>
            <dd className={`status-pill status-${wsStatus}`}>{wsStatus}</dd>
          </div>
          <div>
            <dt>Clients</dt>
            <dd>{presence.clients}</dd>
          </div>
          <div>
            <dt>Authorized</dt>
            <dd>{presence.authorized}</dd>
          </div>
          <div>
            <dt>Auth Required</dt>
            <dd>{requiresAuth ? 'yes' : 'no'}</dd>
          </div>
        </dl>
      </header>

      <section className="token-panel">
        <label htmlFor="token-input">Shared token</label>
        <div className="token-input">
          <input
            id="token-input"
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder={requiresAuth ? 'Required to publish messages' : 'Optional'}
            autoComplete="off"
          />
          <button
            type="button"
            className="secondary"
            onClick={() => setToken('')}
            disabled={!token.trim()}
          >
            Clear
          </button>
        </div>
        <p className="token-help">
          Token is persisted locally for convenience. REST requests send it via <code>X-API-KEY</code>.
        </p>
        <p className={`authorization-flag ${authorized ? 'authorized' : 'unauthorized'}`}>
          {authorized ? 'WebSocket stream authorized' : 'WebSocket stream not yet authorized'}
        </p>
      </section>

      <section className="messages-section">
        <header className="section-header">
          <h2>Live Message Stream</h2>
          <span>{messages.length} stored</span>
        </header>
        <ul className="message-list">
          {messages.map((message) => (
            <li key={message.id} className="message-card">
              <div className="message-meta">
                <span className="message-author">{message.author || 'anonymous'}</span>
                <time dateTime={message.timestamp}>
                  {formatTimestamp(message.timestamp, timeFormatter)}
                </time>
              </div>
              <p>{message.content}</p>
            </li>
          ))}
          {messages.length === 0 && (
            <li className="message-empty">No messages yet — be the first to publish something!</li>
          )}
        </ul>
      </section>

      <section className="composer-section">
        <header className="section-header">
          <h2>Publish Message</h2>
          <span>REST or WebSocket delivery</span>
        </header>

        <form className="composer-form" onSubmit={handleRestSubmit}>
          <label className="field">
            <span>Display name</span>
            <input
              type="text"
              value={author}
              placeholder="Defaults to anonymous"
              onChange={(event) => setAuthor(event.target.value)}
            />
          </label>

          <label className="field">
            <span>Message</span>
            <textarea
              value={content}
              onChange={(event) => setContent(event.target.value)}
              rows={4}
              placeholder="Share status updates, alerts, or test payloads"
            />
          </label>

          <div className="composer-actions">
            <button type="submit" disabled={postPending}>
              {postPending ? 'Publishing…' : 'Send via REST'}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={handleWebSocketPublish}
            >
              Send via WebSocket
            </button>
          </div>
        </form>
      </section>

      <footer className="feedback-bar" role="status">
        {error && <p className="error">{error}</p>}
        {!error && info && <p className="info">{info}</p>}
        {!error && !info && <p className="muted">Ready</p>}
      </footer>
    </div>
  )
}

export default App
