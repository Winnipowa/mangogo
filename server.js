const express = require('express')
const http = require('http')
const { Server } = require('socket.io')
const Database = require('better-sqlite3')
const crypto = require('crypto')

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

// ─── HTML INLINE ─────────────────────────────────────────────────
const INDEX_HTML = "<!DOCTYPE html>\n<html lang=\"fr\">\n<head>\n<meta charset=\"UTF-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n<title>ChatLibre</title>\n<script src=\"/socket.io/socket.io.js\"></script>\n<script src=\"https://cdn.jsdelivr.net/npm/@fingerprintjs/fingerprintjs@3/dist/fp.min.js\"></script>\n<style>\n  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }\n  html, body { height: 100%; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }\n\n  /* \u2500\u2500 LAYOUT \u2500\u2500 */\n  #app { display: flex; height: 100vh; background: #0f1117; color: #fff; overflow: hidden; }\n\n  /* \u2500\u2500 SIDEBAR \u2500\u2500 */\n  #sidebar {\n    width: 240px; flex-shrink: 0; display: flex; flex-direction: column;\n    background: #16181d; border-right: 1px solid rgba(255,255,255,0.07);\n  }\n  #sidebar-header { padding: 18px 16px 14px; border-bottom: 1px solid rgba(255,255,255,0.07); }\n  #sidebar-header h1 { font-size: 15px; font-weight: 700; color: #fff; }\n  #sidebar-header p { font-size: 10px; color: rgba(255,255,255,0.25); margin-top: 2px; }\n  #rooms-label { font-size: 9px; text-transform: uppercase; letter-spacing: .12em; color: rgba(255,255,255,0.22); padding: 12px 16px 6px; }\n  #rooms-list { flex: 1; overflow-y: auto; padding: 2px 8px; }\n  .room-btn {\n    width: 100%; display: flex; align-items: center; gap: 9px;\n    padding: 9px 10px; border: none; background: none; cursor: pointer;\n    border-radius: 10px; color: rgba(255,255,255,0.45); transition: all .12s;\n    text-align: left;\n  }\n  .room-btn:hover { background: rgba(255,255,255,0.05); color: rgba(255,255,255,0.75); }\n  .room-btn.active { background: rgba(255,255,255,0.09); color: #fff; }\n  .room-dot { width: 3px; height: 22px; border-radius: 2px; flex-shrink: 0; opacity: 0; transition: opacity .12s; }\n  .room-btn.active .room-dot { opacity: 1; }\n  .room-emoji { font-size: 18px; flex-shrink: 0; }\n  .room-name { font-size: 12.5px; font-weight: 500; flex: 1; }\n  .room-count { font-size: 9px; color: rgba(255,255,255,0.2); }\n  #user-bar {\n    border-top: 1px solid rgba(255,255,255,0.07); padding: 10px 12px;\n    display: flex; align-items: center; gap: 9px; cursor: pointer;\n    transition: background .12s;\n  }\n  #user-bar:hover { background: rgba(255,255,255,0.04); }\n  #user-bar-avatar { font-size: 24px; }\n  #user-bar-name { font-size: 12px; font-weight: 500; color: #fff; }\n  #user-bar-edit { font-size: 10px; color: rgba(255,255,255,0.25); }\n\n  /* \u2500\u2500 MAIN \u2500\u2500 */\n  #main { flex: 1; display: flex; flex-direction: column; min-width: 0; }\n\n  /* \u2500\u2500 HEADER \u2500\u2500 */\n  #chat-header {\n    display: flex; align-items: center; gap: 10px;\n    padding: 14px 18px; border-bottom: 1px solid rgba(255,255,255,0.07);\n    background: #0f1117; flex-shrink: 0;\n  }\n  #header-emoji { font-size: 22px; }\n  #header-title { font-size: 14px; font-weight: 600; color: #fff; }\n  #header-desc { font-size: 10px; color: rgba(255,255,255,0.3); margin-top: 1px; }\n  #header-online { margin-left: auto; display: flex; align-items: center; gap: 5px; font-size: 10px; color: rgba(255,255,255,0.3); }\n  .online-dot { width: 6px; height: 6px; border-radius: 50%; background: #10b981; }\n\n  /* \u2500\u2500 MESSAGES \u2500\u2500 */\n  #messages {\n    flex: 1; overflow-y: auto; padding: 14px 16px;\n    display: flex; flex-direction: column; gap: 3px;\n    scroll-behavior: smooth;\n  }\n  #messages::-webkit-scrollbar { width: 4px; }\n  #messages::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 2px; }\n  .msg { display: flex; align-items: flex-end; gap: 7px; }\n  .msg.own { flex-direction: row-reverse; }\n  .msg-av { width: 28px; height: 28px; font-size: 18px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }\n  .msg-av.hidden { visibility: hidden; }\n  .msg-body { max-width: 68%; display: flex; flex-direction: column; }\n  .own .msg-body { align-items: flex-end; }\n  .msg-pseudo { font-size: 10px; color: rgba(255,255,255,0.32); margin-bottom: 2px; margin-left: 3px; }\n  .msg-bubble {\n    padding: 8px 12px; border-radius: 18px; font-size: 13px; line-height: 1.45;\n    color: rgba(255,255,255,0.88); background: rgba(255,255,255,0.09);\n    border-bottom-left-radius: 4px; word-break: break-word; position: relative;\n  }\n  .own .msg-bubble { border-bottom-left-radius: 18px; border-bottom-right-radius: 4px; color: #fff; }\n  .msg-time { font-size: 9px; color: rgba(255,255,255,0.18); margin-top: 3px; margin-left: 3px; }\n  .own .msg-time { margin-right: 3px; }\n\n  /* Bouton signalement */\n  .report-btn {\n    position: absolute; right: -22px; top: 50%; transform: translateY(-50%);\n    background: none; border: none; cursor: pointer; color: rgba(255,255,255,0.15);\n    font-size: 12px; opacity: 0; transition: opacity .1s, color .1s;\n    padding: 4px;\n  }\n  .msg:hover .report-btn { opacity: 1; }\n  .report-btn:hover { color: #ef4444; }\n  .report-btn.done { color: #ef4444; opacity: 1; }\n\n  /* \u2500\u2500 EMPTY STATE \u2500\u2500 */\n  #empty { display: none; flex-direction: column; align-items: center; justify-content: center; flex: 1; color: rgba(255,255,255,0.2); }\n  #empty-emoji { font-size: 40px; margin-bottom: 10px; }\n  #empty p { font-size: 13px; }\n\n  /* \u2500\u2500 INPUT \u2500\u2500 */\n  #input-area { padding: 10px 14px 12px; border-top: 1px solid rgba(255,255,255,0.07); flex-shrink: 0; }\n  #input-wrap {\n    display: flex; align-items: center; gap: 10px;\n    background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.09);\n    border-radius: 18px; padding: 9px 14px; transition: border-color .15s;\n  }\n  #input-wrap:focus-within { border-color: rgba(255,255,255,0.18); }\n  #input-av { font-size: 20px; flex-shrink: 0; }\n  #msg-input {\n    flex: 1; background: none; border: none; outline: none;\n    color: rgba(255,255,255,0.85); font-size: 13px; font-family: inherit;\n  }\n  #msg-input::placeholder { color: rgba(255,255,255,0.2); }\n  #send-btn { background: none; border: none; cursor: pointer; font-size: 18px; color: rgba(255,255,255,0.25); transition: color .12s; flex-shrink: 0; }\n  #send-btn:hover { color: rgba(255,255,255,0.8); }\n  #input-hint { font-size: 9px; color: rgba(255,255,255,0.12); text-align: center; margin-top: 4px; }\n\n  /* \u2500\u2500 SETUP OVERLAY \u2500\u2500 */\n  #setup-overlay {\n    position: fixed; inset: 0; z-index: 100;\n    background: rgba(0,0,0,0.75); backdrop-filter: blur(6px);\n    display: flex; align-items: center; justify-content: center; padding: 20px;\n  }\n  #setup-modal {\n    background: #1c1e26; border-radius: 18px; width: 100%; max-width: 340px;\n    padding: 26px 24px; border: 1px solid rgba(255,255,255,0.1);\n  }\n  .setup-center { text-align: center; margin-bottom: 20px; }\n  .setup-big { font-size: 44px; }\n  .setup-title { font-size: 17px; font-weight: 600; color: #fff; margin-top: 8px; }\n  .setup-sub { font-size: 11px; color: rgba(255,255,255,0.35); margin-top: 3px; }\n  .setup-label { font-size: 9px; text-transform: uppercase; letter-spacing: .1em; color: rgba(255,255,255,0.28); margin-bottom: 8px; }\n  #avatar-grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 6px; margin-bottom: 16px; }\n  .av-btn {\n    background: rgba(255,255,255,0.05); border: 1.5px solid transparent;\n    border-radius: 9px; padding: 5px 2px; font-size: 22px; cursor: pointer;\n    transition: all .12s; line-height: 1;\n  }\n  .av-btn:hover { background: rgba(255,255,255,0.1); }\n  .av-btn.sel { background: rgba(99,102,241,0.2); border-color: #6366f1; transform: scale(1.08); }\n  #pseudo-input {\n    width: 100%; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1);\n    border-radius: 11px; padding: 11px 14px; color: #fff; font-size: 13px;\n    font-family: inherit; outline: none; margin-bottom: 14px; transition: border-color .15s;\n  }\n  #pseudo-input:focus { border-color: rgba(99,102,241,0.5); }\n  #pseudo-input::placeholder { color: rgba(255,255,255,0.2); }\n  #join-btn {\n    width: 100%; background: #6366f1; border: none; border-radius: 11px;\n    padding: 12px; color: #fff; font-size: 13px; font-weight: 600;\n    cursor: pointer; transition: background .12s, transform .08s; font-family: inherit;\n  }\n  #join-btn:hover:not(:disabled) { background: #5254cc; }\n  #join-btn:active { transform: scale(.98); }\n  #join-btn:disabled { opacity: .3; cursor: default; }\n  #join-err { font-size: 11px; color: #f87171; text-align: center; min-height: 16px; margin-bottom: 6px; }\n\n  /* \u2500\u2500 SPLASH (aucun salon s\u00e9lectionn\u00e9) \u2500\u2500 */\n  #splash {\n    flex: 1; display: flex; flex-direction: column;\n    align-items: center; justify-content: center;\n    color: rgba(255,255,255,0.18); text-align: center;\n  }\n  #splash-emoji { font-size: 48px; margin-bottom: 12px; }\n  #splash h2 { font-size: 16px; font-weight: 500; color: rgba(255,255,255,0.5); }\n  #splash p { font-size: 12px; margin-top: 6px; }\n</style>\n</head>\n<body>\n<div id=\"app\">\n\n  <!-- SIDEBAR -->\n  <div id=\"sidebar\">\n    <div id=\"sidebar-header\">\n      <h1>\ud83d\udcac ChatLibre</h1>\n      <p>Discussion anonyme & libre</p>\n    </div>\n    <div id=\"rooms-label\">Salons</div>\n    <div id=\"rooms-list\"></div>\n    <div id=\"user-bar\" onclick=\"openSetup()\">\n      <div id=\"user-bar-avatar\">\ud83d\ude42</div>\n      <div>\n        <div id=\"user-bar-name\">\u2014</div>\n        <div id=\"user-bar-edit\">Modifier le profil</div>\n      </div>\n    </div>\n  </div>\n\n  <!-- MAIN -->\n  <div id=\"main\">\n\n    <!-- Splash (aucun salon) -->\n    <div id=\"splash\">\n      <div id=\"splash-emoji\">\ud83d\udcac</div>\n      <h2>Choisis un salon</h2>\n      <p>S\u00e9lectionne un salon dans la liste pour commencer</p>\n    </div>\n\n    <!-- Chat (cach\u00e9 jusqu'\u00e0 s\u00e9lection) -->\n    <div id=\"chat-view\" style=\"display:none; flex:1; flex-direction:column; min-height:0;\">\n      <div id=\"chat-header\">\n        <div id=\"header-emoji\">\ud83d\udcac</div>\n        <div>\n          <div id=\"header-title\">Salon</div>\n          <div id=\"header-desc\">\u2026</div>\n        </div>\n        <div id=\"header-online\">\n          <div class=\"online-dot\"></div>\n          <span id=\"online-count\">0 en ligne</span>\n        </div>\n      </div>\n      <div id=\"messages\"></div>\n      <div id=\"input-area\">\n        <div id=\"input-wrap\">\n          <div id=\"input-av\">\ud83d\ude42</div>\n          <input id=\"msg-input\" placeholder=\"\u00c9crire ici\u2026\" maxlength=\"500\" autocomplete=\"off\" />\n          <button id=\"send-btn\">\u2191</button>\n        </div>\n        <div id=\"input-hint\">Entr\u00e9e pour envoyer</div>\n      </div>\n    </div>\n\n  </div>\n</div>\n\n<!-- SETUP OVERLAY -->\n<div id=\"setup-overlay\">\n  <div id=\"setup-modal\">\n    <div class=\"setup-center\">\n      <div class=\"setup-big\">\ud83d\udcac</div>\n      <div class=\"setup-title\">Rejoindre le chat</div>\n      <div class=\"setup-sub\">Aucune inscription requise</div>\n    </div>\n\n    <div class=\"setup-label\">Choisis ton avatar</div>\n    <div id=\"avatar-grid\"></div>\n\n    <div class=\"setup-label\">Ton pseudo</div>\n    <input id=\"pseudo-input\" placeholder=\"Ex : Shadow42, Lune, Nomad\u2026\" maxlength=\"20\" />\n\n    <div id=\"join-err\"></div>\n    <button id=\"join-btn\" disabled>Entrer\u2026</button>\n  </div>\n</div>\n\n<script>\n// \u2500\u2500 CONFIG \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nconst AVATARS = ['\ud83e\udd8a','\ud83d\udc3a','\ud83d\udc31','\ud83e\udd81','\ud83d\udc38','\ud83d\udc27','\ud83e\udd8b','\ud83d\udc19','\ud83e\udd9c','\ud83e\udd85','\ud83d\udc3b','\ud83c\udfad']\nconst ROOMS_COLORS = {\n  general:'#6366f1', gaming:'#10b981', famille:'#f59e0b',\n  ecole:'#3b82f6', apprentissage:'#8b5cf6', personnel:'#ec4899', expats:'#06b6d4'\n}\n\n// \u2500\u2500 STATE \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nlet socket = null\nlet fingerprint = null\nlet user = JSON.parse(localStorage.getItem('chatuser') || 'null')\nlet activeRoom = null\nlet selectedAvatar = AVATARS[Math.floor(Math.random() * AVATARS.length)]\nlet reportedSet = new Set()\n\n// \u2500\u2500 FINGERPRINT \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nFingerprintJS.load().then(fp => fp.get()).then(r => {\n  fingerprint = r.visitorId\n  initSocket()\n})\n\n// \u2500\u2500 SOCKET \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nfunction initSocket() {\n  socket = io({ auth: { fingerprint } })\n\n  socket.on('connect_error', err => {\n    if (err.message === 'banned') {\n      localStorage.removeItem('chatuser')\n      alert('Tu as \u00e9t\u00e9 banni de la plateforme.')\n      location.reload()\n    }\n  })\n\n  socket.on('history', msgs => {\n    const container = document.getElementById('messages')\n    container.innerHTML = ''\n    msgs.forEach(renderMessage)\n    container.scrollTop = container.scrollHeight\n  })\n\n  socket.on('message', msg => {\n    renderMessage(msg)\n    const c = document.getElementById('messages')\n    c.scrollTop = c.scrollHeight\n  })\n\n  socket.on('presence', count => {\n    document.getElementById('online-count').textContent = count + ' en ligne'\n    const roomBtn = document.querySelector(`.room-btn[data-slug=\"${activeRoom}\"]`)\n    if (roomBtn) roomBtn.querySelector('.room-count').textContent = count\n  })\n\n  socket.on('banned', () => {\n    localStorage.removeItem('chatuser')\n    alert('Tu as \u00e9t\u00e9 banni.')\n    location.reload()\n  })\n\n  socket.on('reported', () => {\n    // Confirmation silencieuse\n  })\n\n  // Charger les salons\n  loadRooms()\n\n  // Si user d\u00e9j\u00e0 enregistr\u00e9, skip le setup\n  if (user) {\n    closeSetup()\n    updateUserBar()\n  }\n}\n\n// \u2500\u2500 ROOMS \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nfunction loadRooms() {\n  fetch('/api/rooms').then(r => r.json()).then(rooms => {\n    const list = document.getElementById('rooms-list')\n    list.innerHTML = ''\n    rooms.forEach(room => {\n      const btn = document.createElement('button')\n      btn.className = 'room-btn'\n      btn.dataset.slug = room.slug\n      btn.dataset.color = room.color\n      btn.innerHTML = `\n        <div class=\"room-dot\" style=\"background:${room.color}\"></div>\n        <div class=\"room-emoji\">${room.emoji}</div>\n        <div class=\"room-name\">${room.name}</div>\n        <div class=\"room-count\">${room.online || ''}</div>\n      `\n      btn.addEventListener('click', () => joinRoom(room))\n      list.appendChild(btn)\n    })\n  })\n}\n\nfunction joinRoom(room) {\n  if (!user) { openSetup(); return }\n\n  document.querySelectorAll('.room-btn').forEach(b => b.classList.remove('active'))\n  document.querySelector(`.room-btn[data-slug=\"${room.slug}\"]`)?.classList.add('active')\n\n  activeRoom = room.slug\n  document.getElementById('header-emoji').textContent = room.emoji\n  document.getElementById('header-title').textContent = room.name\n  document.getElementById('header-desc').textContent = room.desc\n  document.getElementById('msg-input').placeholder = `\u00c9crire dans ${room.name}\u2026`\n\n  document.getElementById('splash').style.display = 'none'\n  document.getElementById('chat-view').style.display = 'flex'\n  document.getElementById('messages').innerHTML = ''\n\n  socket.emit('join', { slug: room.slug, pseudo: user.pseudo, avatar: user.avatar })\n}\n\n// \u2500\u2500 MESSAGES \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nfunction renderMessage(msg) {\n  const isOwn = msg.pseudo === user?.pseudo\n  const container = document.getElementById('messages')\n  const msgs = container.querySelectorAll('.msg')\n  const last = msgs[msgs.length - 1]\n  const lastPseudo = last?.dataset.pseudo\n  const showAvatar = !isOwn && lastPseudo !== msg.pseudo\n\n  const div = document.createElement('div')\n  div.className = 'msg' + (isOwn ? ' own' : '')\n  div.dataset.pseudo = msg.pseudo\n\n  const color = ROOMS_COLORS[activeRoom] || '#6366f1'\n  const bubbleStyle = isOwn ? `style=\"background:${color}\"` : ''\n\n  div.innerHTML = `\n    ${!isOwn ? `<div class=\"msg-av ${showAvatar ? '' : 'hidden'}\">${msg.avatar || '\ud83d\ude42'}</div>` : ''}\n    <div class=\"msg-body\">\n      ${showAvatar && !isOwn ? `<div class=\"msg-pseudo\">${msg.pseudo}</div>` : ''}\n      <div class=\"msg-bubble\" ${bubbleStyle}>\n        ${escapeHtml(msg.content)}\n        ${!isOwn ? `<button class=\"report-btn ${reportedSet.has(msg.id) ? 'done' : ''}\" data-id=\"${msg.id}\" title=\"Signaler\">\u2691</button>` : ''}\n      </div>\n      <div class=\"msg-time\">${msg.time}</div>\n    </div>\n  `\n\n  if (!isOwn) {\n    div.querySelector('.report-btn')?.addEventListener('click', () => {\n      if (reportedSet.has(msg.id)) return\n      reportedSet.add(msg.id)\n      div.querySelector('.report-btn').classList.add('done')\n      socket.emit('report', { messageId: msg.id })\n    })\n  }\n\n  container.appendChild(div)\n}\n\nfunction escapeHtml(str) {\n  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')\n}\n\n// \u2500\u2500 SEND \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nfunction sendMessage() {\n  const input = document.getElementById('msg-input')\n  const content = input.value.trim()\n  if (!content || !activeRoom) return\n  socket.emit('message', { content })\n  input.value = ''\n}\n\ndocument.getElementById('send-btn').addEventListener('click', sendMessage)\ndocument.getElementById('msg-input').addEventListener('keydown', e => {\n  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() }\n})\n\n// \u2500\u2500 SETUP \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nconst avatarGrid = document.getElementById('avatar-grid')\nAVATARS.forEach(av => {\n  const btn = document.createElement('button')\n  btn.className = 'av-btn' + (av === selectedAvatar ? ' sel' : '')\n  btn.textContent = av\n  btn.addEventListener('click', () => {\n    selectedAvatar = av\n    document.querySelectorAll('.av-btn').forEach(b => b.classList.remove('sel'))\n    btn.classList.add('sel')\n    updateJoinBtn()\n  })\n  avatarGrid.appendChild(btn)\n})\n\nconst pseudoInput = document.getElementById('pseudo-input')\nconst joinBtn = document.getElementById('join-btn')\n\nfunction updateJoinBtn() {\n  const p = pseudoInput.value.trim()\n  joinBtn.disabled = p.length < 2\n  joinBtn.textContent = p.length >= 2 ? `Entrer comme ${p} ${selectedAvatar}` : 'Entrer\u2026'\n}\n\npseudoInput.addEventListener('input', updateJoinBtn)\npseudoInput.addEventListener('keydown', e => { if (e.key === 'Enter') joinBtn.click() })\n\njoinBtn.addEventListener('click', () => {\n  const p = pseudoInput.value.trim()\n  if (p.length < 2) return\n  user = { pseudo: p, avatar: selectedAvatar }\n  localStorage.setItem('chatuser', JSON.stringify(user))\n  closeSetup()\n  updateUserBar()\n})\n\nfunction openSetup() {\n  pseudoInput.value = user?.pseudo || ''\n  updateJoinBtn()\n  document.getElementById('setup-overlay').style.display = 'flex'\n}\nfunction closeSetup() { document.getElementById('setup-overlay').style.display = 'none' }\nfunction updateUserBar() {\n  document.getElementById('user-bar-avatar').textContent = user?.avatar || '\ud83d\ude42'\n  document.getElementById('user-bar-name').textContent = user?.pseudo || '\u2014'\n  document.getElementById('input-av').textContent = user?.avatar || '\ud83d\ude42'\n}\n</script>\n</body>\n</html>\n";
const ADMIN_HTML = "<!DOCTYPE html>\n<html lang=\"fr\">\n<head>\n<meta charset=\"UTF-8\">\n<title>Admin \u2014 ChatLibre</title>\n<style>\n  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }\n  body { font-family: system-ui, sans-serif; background: #0f1117; color: #fff; padding: 24px; }\n  h1 { font-size: 18px; margin-bottom: 6px; }\n  p { color: rgba(255,255,255,0.4); font-size: 12px; margin-bottom: 20px; }\n  #login { max-width: 320px; }\n  input { width: 100%; background: rgba(255,255,255,0.07); border: 1px solid rgba(255,255,255,0.12); border-radius: 9px; padding: 10px 12px; color: #fff; font-size: 13px; outline: none; margin-bottom: 10px; font-family: inherit; }\n  button { background: #6366f1; border: none; border-radius: 9px; padding: 10px 20px; color: #fff; font-size: 13px; font-weight: 600; cursor: pointer; font-family: inherit; }\n  button:hover { background: #5254cc; }\n  button.danger { background: #dc2626; }\n  button.muted { background: rgba(255,255,255,0.1); }\n  #reports { display: none; }\n  .report-card { background: #16181d; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 14px 16px; margin-bottom: 10px; }\n  .report-meta { font-size: 11px; color: rgba(255,255,255,0.3); margin-bottom: 6px; }\n  .report-content { font-size: 13px; color: rgba(255,255,255,0.8); margin-bottom: 10px; background: rgba(255,255,255,0.04); padding: 8px 10px; border-radius: 7px; }\n  .report-actions { display: flex; gap: 8px; }\n  #empty-msg { color: rgba(255,255,255,0.25); font-size: 13px; text-align: center; padding: 40px; }\n</style>\n</head>\n<body>\n\n<h1>\ud83d\udee1\ufe0f Admin \u2014 ChatLibre</h1>\n<p>Gestion des signalements</p>\n\n<div id=\"login\">\n  <input type=\"password\" id=\"secret-input\" placeholder=\"Mot de passe admin\" />\n  <button onclick=\"loadReports()\">Connexion</button>\n</div>\n\n<div id=\"reports\">\n  <h2 style=\"font-size:15px; margin-bottom:14px; color:rgba(255,255,255,0.7);\">Signalements en attente</h2>\n  <div id=\"reports-list\"></div>\n</div>\n\n<script>\nlet secret = ''\n\nasync function loadReports() {\n  secret = document.getElementById('secret-input').value\n  const res = await fetch('/api/admin/reports', { headers: { 'x-secret': secret } })\n  if (!res.ok) { alert('Mot de passe incorrect'); return }\n\n  const data = await res.json()\n  document.getElementById('login').style.display = 'none'\n  document.getElementById('reports').style.display = 'block'\n\n  const list = document.getElementById('reports-list')\n  if (data.length === 0) {\n    list.innerHTML = '<div id=\"empty-msg\">\u2705 Aucun signalement en attente</div>'\n    return\n  }\n\n  list.innerHTML = ''\n  data.forEach(r => {\n    const card = document.createElement('div')\n    card.className = 'report-card'\n    card.id = 'r-' + r.id\n    card.innerHTML = `\n      <div class=\"report-meta\">\n        Salon : <b>${r.room}</b> \u00b7 Auteur : <b>${r.pseudo}</b> \u00b7 ${r.created_at}\n      </div>\n      <div class=\"report-content\">${r.content}</div>\n      <div class=\"report-actions\">\n        <button class=\"danger\" onclick=\"banUser('${r.fingerprint}', ${r.id})\">\ud83d\udeab Bannir</button>\n        <button class=\"muted\" onclick=\"dismiss(${r.id})\">Ignorer</button>\n      </div>\n    `\n    list.appendChild(card)\n  })\n}\n\nasync function banUser(fingerprint, reportId) {\n  if (!confirm('Bannir cet utilisateur ?')) return\n  const reason = prompt('Raison du ban :') || 'Comportement inappropri\u00e9'\n  await fetch('/api/admin/ban', {\n    method: 'POST',\n    headers: { 'Content-Type': 'application/json', 'x-secret': secret },\n    body: JSON.stringify({ fingerprint, ipHash: '', reason })\n  })\n  document.getElementById('r-' + reportId)?.remove()\n  if (!document.querySelector('.report-card')) {\n    document.getElementById('reports-list').innerHTML = '<div id=\"empty-msg\">\u2705 Aucun signalement en attente</div>'\n  }\n}\n\nasync function dismiss(id) {\n  await fetch('/api/admin/dismiss', {\n    method: 'POST',\n    headers: { 'Content-Type': 'application/json', 'x-secret': secret },\n    body: JSON.stringify({ id })\n  })\n  document.getElementById('r-' + id)?.remove()\n  if (!document.querySelector('.report-card')) {\n    document.getElementById('reports-list').innerHTML = '<div id=\"empty-msg\">\u2705 Aucun signalement en attente</div>'\n  }\n}\n</script>\n</body>\n</html>\n";

app.use(express.json())
app.get('/', (_req, res) => res.setHeader('Content-Type','text/html').end(INDEX_HTML))
app.get('/admin', (_req, res) => res.setHeader('Content-Type','text/html').end(ADMIN_HTML))

// ─── API REST ─────────────────────────────────────────────────────
app.get('/api/rooms', (req, res) => {
  res.json(ROOMS.map(r => ({
    ...r,
    online: presence[r.slug]?.size || 0
  })))
})

// ─── ADMIN (protégé par header secret) ───────────────────────────
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'changeme123'

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
