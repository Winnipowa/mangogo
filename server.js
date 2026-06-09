const express = require('express')
const http = require('http')
const { Server } = require('socket.io')
const Database = require('better-sqlite3')
const crypto = require('crypto')
const path = require('path')

const app = express()
const server = http.createServer(app)
const io = new Server(server)

// ─── BASE DE DONNÉES (SQLite — fichier local) ───────────────────
const db = new Database('chat.db')

db.exec(`
  CREATE TABLE IF NOT EXISTS bans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fingerprint TEXT,
    ip_hash TEXT,
    reason TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room TEXT,
    pseudo TEXT,
    content TEXT,
    fingerprint TEXT,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now'))
  );
`)

// ─── SALONS ─────────────────────────────────────────────────────
const ROOMS = [
  { slug: 'general',      name: 'Discussion générale', emoji: '💬', color: '#6366f1', desc: 'Parlez de tout et de rien' },
  { slug: 'gaming',       name: 'Jeux vidéo',          emoji: '🎮', color: '#10b981', desc: 'Tous les jeux, toutes les plateformes' },
  { slug: 'famille',      name: 'Famille',             emoji: '👨‍👩‍👧', color: '#f59e0b', desc: 'Parents, enfants, vie de famille' },
  { slug: 'ecole',        name: 'École',               emoji: '🎒', color: '#3b82f6', desc: 'Devoirs, orientation, études' },
  { slug: 'apprentissage',name: 'Apprentissage',       emoji: '📚', color: '#8b5cf6', desc: 'Langues, compétences, formations' },
  { slug: 'personnel',    name: 'Personnel',           emoji: '🙋', color: '#ec4899', desc: 'Confidences, questions perso' },
  { slug: 'expats',       name: 'Expats & Voyage',     emoji: '🌍', color: '#06b6d4', desc: 'Vivre à l\'étranger, bons plans' },
]

// ─── MESSAGES EN MÉMOIRE (100 derniers par salon) ────────────────
const messageHistory = {}
ROOMS.forEach(r => messageHistory[r.slug] = [])

function addMessage(slug, msg) {
  messageHistory[slug].push(msg)
  if (messageHistory[slug].length > 100) messageHistory[slug].shift()
}

// ─── PRÉSENCE EN MÉMOIRE ─────────────────────────────────────────
const presence = {} // slug → Set de socketIds
ROOMS.forEach(r => presence[r.slug] = new Set())

// ─── HELPERS ─────────────────────────────────────────────────────
const SALT = process.env.IP_SALT || 'chatlibresalt2024'

function hashIP(ip) {
  return crypto.createHash('sha256').update(ip + SALT).digest('hex').slice(0, 16)
}

function isBanned(fingerprint, ipHash) {
  const row = db.prepare(`
    SELECT id FROM bans 
    WHERE fingerprint = ? OR ip_hash = ?
    LIMIT 1
  `).get(fingerprint, ipHash)
  return !!row
}

function getIP(socket) {
  return (socket.handshake.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || socket.handshake.address
    || 'unknown'
}

// ─── STATIC ──────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')))
app.use(express.json())

// ─── API REST ─────────────────────────────────────────────────────
app.get('/api/rooms', (req, res) => {
  res.json(ROOMS.map(r => ({
    ...r,
    online: presence[r.slug]?.size || 0
  })))
})

// ─── ADMIN (protégé par header secret) ───────────────────────────
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'changeme123'

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'))
})

app.get('/api/admin/reports', (req, res) => {
  if (req.headers['x-secret'] !== ADMIN_SECRET) return res.status(401).json({ error: 'Non autorisé' })
  const rows = db.prepare(`SELECT * FROM reports WHERE status='pending' ORDER BY created_at DESC LIMIT 50`).all()
  res.json(rows)
})

app.post('/api/admin/ban', (req, res) => {
  if (req.headers['x-secret'] !== ADMIN_SECRET) return res.status(401).json({ error: 'Non autorisé' })
  const { fingerprint, ipHash, reason } = req.body
  db.prepare(`INSERT INTO bans (fingerprint, ip_hash, reason) VALUES (?, ?, ?)`).run(fingerprint, ipHash, reason || 'Banni par admin')

  // Kick la socket si connectée
  for (const [id, socket] of io.sockets.sockets.entries()) {
    if (socket.data.fingerprint === fingerprint) {
      socket.emit('banned')
      socket.disconnect(true)
    }
  }

  // Marquer les reports comme traités
  db.prepare(`UPDATE reports SET status='actioned' WHERE fingerprint=?`).run(fingerprint)
  res.json({ ok: true })
})

app.post('/api/admin/dismiss', (req, res) => {
  if (req.headers['x-secret'] !== ADMIN_SECRET) return res.status(401).json({ error: 'Non autorisé' })
  db.prepare(`UPDATE reports SET status='dismissed' WHERE id=?`).run(req.body.id)
  res.json({ ok: true })
})

// ─── SOCKET.IO ────────────────────────────────────────────────────
io.use((socket, next) => {
  const fingerprint = socket.handshake.auth.fingerprint
  if (!fingerprint) return next(new Error('fingerprint_required'))

  const ip = getIP(socket)
  const ipHash = hashIP(ip)

  if (isBanned(fingerprint, ipHash)) return next(new Error('banned'))

  socket.data.fingerprint = fingerprint
  socket.data.ipHash = ipHash
  next()
})

io.on('connection', (socket) => {

  socket.on('join', ({ slug, pseudo, avatar }) => {
    if (!ROOMS.find(r => r.slug === slug)) return

    // Quitter le salon précédent
    if (socket.data.room) {
      socket.leave(socket.data.room)
      presence[socket.data.room]?.delete(socket.id)
      io.to(socket.data.room).emit('presence', presence[socket.data.room]?.size || 0)
    }

    socket.data.room = slug
    socket.data.pseudo = pseudo
    socket.data.avatar = avatar
    socket.join(slug)
    presence[slug].add(socket.id)

    // Envoyer l'historique
    socket.emit('history', messageHistory[slug])

    // Mise à jour présence
    io.to(slug).emit('presence', presence[slug].size)
  })

  socket.on('message', ({ content }) => {
    const room = socket.data.room
    if (!room || !content?.trim()) return
    if (content.length > 500) return

    // Rate limit simple
    const now = Date.now()
    if (socket.data.lastMsg && now - socket.data.lastMsg < 1000) return
    socket.data.lastMsg = now

    const msg = {
      id: crypto.randomUUID(),
      pseudo: socket.data.pseudo,
      avatar: socket.data.avatar,
      content: content.trim(),
      time: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
      fingerprint: socket.data.fingerprint // stocké mais jamais envoyé au client
    }

    addMessage(room, msg)

    // Broadcast SANS le fingerprint
    const { fingerprint: _fp, ...publicMsg } = msg
    io.to(room).emit('message', publicMsg)
  })

  socket.on('report', ({ messageId, content, pseudo }) => {
    if (!socket.data.room) return
    const reported = Object.values(messageHistory).flat().find(m => m.id === messageId)
    if (!reported) return

    db.prepare(`
      INSERT INTO reports (room, pseudo, content, fingerprint)
      VALUES (?, ?, ?, ?)
    `).run(socket.data.room, reported.pseudo, reported.content, reported.fingerprint)

    socket.emit('reported')
  })

  socket.on('disconnect', () => {
    const room = socket.data.room
    if (room) {
      presence[room]?.delete(socket.id)
      io.to(room).emit('presence', presence[room]?.size || 0)
    }
  })
})

// ─── START ────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000
server.listen(PORT, () => {
  console.log(`✅ ChatLibre running → http://localhost:${PORT}`)
  console.log(`🔑 Admin → http://localhost:${PORT}/admin`)
})
