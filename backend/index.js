const http = require('http')
const fs = require('node:fs')
const crypto = require('node:crypto')
const express = require('express')
const cors = require('cors')
const { WebSocketServer } = require('ws')

const PORT = Number(process.env.PORT || 4000)
const WS_PATH = process.env.WS_PATH || '/ws'
const HISTORY_LIMIT = Number(process.env.HISTORY_LIMIT || 100)
const HEARTBEAT_INTERVAL = Number(process.env.HEARTBEAT_INTERVAL || 30000)

const app = express()

const allowedOrigins = process.env.CORS_ORIGIN
	? process.env.CORS_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean)
	: null

app.use(
	cors(
		allowedOrigins && allowedOrigins.length > 0
			? { origin: allowedOrigins, credentials: false }
			: undefined,
	),
)
app.use(express.json())

const loadSecret = () => {
	const direct = (process.env.MESSAGE_SECRET || '').trim()
	if (direct) {
		return direct
	}

	const secretFile = (process.env.MESSAGE_SECRET_FILE || '').trim()
	if (!secretFile) {
		return null
	}

	try {
		const value = fs.readFileSync(secretFile, 'utf8').trim()
		return value || null
	} catch (error) {
		console.warn(
			`[realtime] Unable to read MESSAGE_SECRET_FILE ${secretFile}: ${error.message}`,
		)
		return null
	}
}

const messageSecret = loadSecret()
const secretBuffer = messageSecret ? Buffer.from(messageSecret) : null
const requiresSecret = Boolean(secretBuffer && secretBuffer.length > 0)

const verifyToken = (candidate) => {
	if (!requiresSecret) {
		return true
	}

	const providedRaw = typeof candidate === 'string' ? candidate.trim() : ''
	if (!providedRaw) {
		return false
	}

	const providedValue = providedRaw.startsWith('Bearer ')
		? providedRaw.slice(7).trim()
		: providedRaw

	if (!secretBuffer || !providedValue) {
		return false
	}

	const providedBuffer = Buffer.from(providedValue)
	if (providedBuffer.length !== secretBuffer.length) {
		return false
	}

	try {
		return crypto.timingSafeEqual(providedBuffer, secretBuffer)
	} catch (error) {
		console.warn('[realtime] Failed to compare secrets securely:', error.message)
		return false
	}
}

const getRequestToken = (req) => req.get('x-api-key') || req.get('authorization') || ''

const ensureRestAuthorized = (req) => {
	if (verifyToken(getRequestToken(req))) {
		return
	}

	const error = new Error('Unauthorized request')
	error.statusCode = 401
	throw error
}

const server = http.createServer(app)
const wss = new WebSocketServer({ server, path: WS_PATH })

const clients = new Map()
let messages = []

const serializeMessage = (message) => ({
	id: message.id,
	author: message.author,
	content: message.content,
	timestamp: message.timestamp,
})

const broadcast = (event, payload) => {
	const body = JSON.stringify({ event, payload })
	for (const socket of wss.clients) {
		if (socket.readyState === socket.OPEN) {
			socket.send(body)
		}
	}
}

const pruneHistory = () => {
	if (messages.length > HISTORY_LIMIT) {
		messages = messages.slice(messages.length - HISTORY_LIMIT)
	}
}

const createMessage = ({ author, content, source }) => {
	const trimmedAuthor = author?.trim() || 'anonymous'
	const trimmedContent = content?.trim() || ''

	if (!trimmedContent) {
		const error = new Error('Message content cannot be empty')
		error.statusCode = 400
		throw error
	}

	const message = {
		id: crypto.randomUUID(),
		author: trimmedAuthor,
		content: trimmedContent,
		timestamp: new Date().toISOString(),
		source,
	}

	messages.push(message)
	pruneHistory()

	const payload = serializeMessage(message)
	broadcast('message:created', payload)

	return payload
}

const getPresenceSnapshot = () => {
	let authorized = 0
	for (const socket of wss.clients) {
		if (socket.authorized) {
			authorized += 1
		}
	}

	return {
		clients: wss.clients.size,
		authorized,
	}
}

app.get('/api/health', (_req, res) => {
	const presence = getPresenceSnapshot()
	res.json({
		status: 'ok',
		uptime: process.uptime(),
		timestamp: new Date().toISOString(),
		clients: presence.clients,
		authorized: presence.authorized,
		historySize: messages.length,
		requiresAuth: requiresSecret,
		presence,
	})
})

app.get('/api/messages', (_req, res) => {
	res.json({ messages: messages.map(serializeMessage) })
})

app.post('/api/messages', (req, res, next) => {
	try {
		ensureRestAuthorized(req)

		const payload = createMessage({
			author: req.body?.author,
			content: req.body?.content,
			source: 'rest',
		})

		res.status(201).json({ message: payload })
	} catch (error) {
		next(error)
	}
})

app.get('/', (_req, res) => {
	res.json({
		message: 'Realtime messaging API with WebSocket support',
		rest: ['/api/health', '/api/messages'],
		websocket: WS_PATH,
		requiresAuth: requiresSecret,
		presence: getPresenceSnapshot(),
	})
})

app.use((error, _req, res, _next) => {
	const status = error.statusCode || 500
	res.status(status).json({
		error: true,
		message: error.message || 'Unexpected error',
	})
})

const heartbeat = () => {
	for (const socket of wss.clients) {
		if (socket.isAlive === false) {
			clients.delete(socket)
			socket.terminate()
			continue
		}

		socket.isAlive = false
		socket.ping()
	}
}

const ensureWebSocketAuthorized = (socket, token) => {
	if (!requiresSecret) {
		return true
	}

	if (socket.authorized) {
		return true
	}

	if (verifyToken(token)) {
		socket.authorized = true
		return true
	}

	return false
}

wss.on('connection', (socket, request) => {
	const clientId = crypto.randomUUID()
	socket.isAlive = true

	const resolveTokenFromQuery = () => {
		try {
			const url = new URL(request.url, `http://${request.headers.host}`)
			return url.searchParams.get('token')
		} catch (_error) {
			return null
		}
	}

	socket.authorized = verifyToken(resolveTokenFromQuery())

	socket.on('pong', () => {
		socket.isAlive = true
	})

	clients.set(socket, {
		id: clientId,
		connectedAt: new Date().toISOString(),
		address: request.socket.remoteAddress,
		authorized: socket.authorized,
	})

	socket.send(
		JSON.stringify({
			event: 'connection:ack',
			payload: {
				id: clientId,
				wsPath: WS_PATH,
				connectedAt: new Date().toISOString(),
				history: messages.map(serializeMessage),
				requiresAuth: requiresSecret,
				authorized: socket.authorized || !requiresSecret,
				presence: getPresenceSnapshot(),
			},
		}),
	)

	broadcast('presence:update', getPresenceSnapshot())

	socket.on('message', (raw) => {
		try {
			const data = JSON.parse(raw.toString())

			if (data?.event === 'auth') {
				if (ensureWebSocketAuthorized(socket, data.payload?.token)) {
					socket.send(
						JSON.stringify({
							event: 'auth:ok',
							payload: {
								authorized: true,
								presence: getPresenceSnapshot(),
							},
						}),
					)
					broadcast('presence:update', getPresenceSnapshot())
				} else {
					socket.send(
						JSON.stringify({
							event: 'auth:error',
							payload: {
								message: 'Invalid authentication token',
							},
						}),
					)
				}
				return
			}

			if (data?.event === 'message:create') {
				if (!ensureWebSocketAuthorized(socket, data.payload?.token)) {
					socket.send(
						JSON.stringify({
							event: 'error',
							payload: {
								message: 'Authorization required to publish',
							},
						}),
					)
					return
				}

				const payload = createMessage({
					author: data.payload?.author,
					content: data.payload?.content,
					source: 'websocket',
				})

				socket.send(JSON.stringify({ event: 'message:ack', payload }))
			}
		} catch (error) {
			socket.send(
				JSON.stringify({
					event: 'error',
					payload: {
						message: error.message || 'Malformed message payload',
					},
				}),
			)
		}
	})

	socket.on('close', () => {
		clients.delete(socket)
		broadcast('presence:update', getPresenceSnapshot())
	})
})

const interval = setInterval(heartbeat, HEARTBEAT_INTERVAL)

server.listen(PORT, () => {
	console.log(`Realtime API listening on port ${PORT}`)
	console.log(`WebSocket endpoint available at ${WS_PATH}`)
	if (allowedOrigins) {
		console.log(`CORS restricted to: ${allowedOrigins.join(', ')}`)
	} else {
		console.log('CORS enabled for all origins')
	}
	if (requiresSecret) {
		console.log('Message publishing requires shared secret token')
	}
})

const gracefulShutdown = () => {
	clearInterval(interval)
	wss.clients.forEach((socket) => socket.terminate())
	server.close(() => process.exit(0))
}

process.on('SIGINT', gracefulShutdown)
process.on('SIGTERM', gracefulShutdown)
