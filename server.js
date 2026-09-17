require("dotenv").config();

const express = require("express");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");
const session = require("express-session");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();

// Render sits behind a reverse proxy. Trust the proxy so secure
// session cookies work correctly on the HTTPS live site.
app.set("trust proxy", 1);

const PORT = Number(process.env.PORT || 3000);

const VIDEO_DIR = path.join(__dirname, "videos");
const POSTER_DIR = path.join(__dirname, "posters");
const PUBLIC_DIR = path.join(__dirname, "public");

for (const dir of [VIDEO_DIR, POSTER_DIR, PUBLIC_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ===============================
// DATABASE
// ===============================

const db = new Database(path.join(__dirname, "database.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    phone TEXT,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS movies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    filename TEXT NOT NULL,
    poster TEXT,
    category_id INTEGER,
    year INTEGER,
    duration TEXT,
    views INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (category_id) REFERENCES categories(id)
);

CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    plan TEXT NOT NULL,
    amount INTEGER NOT NULL,
    provider TEXT,
    transaction_id TEXT,
    starts_at DATETIME,
    expires_at DATETIME,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    provider TEXT NOT NULL,
    transaction_id TEXT,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);
`);

// Safe migrations for payment gateway fields.
try { db.exec("ALTER TABLE payments ADD COLUMN gateway_transaction_id TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE payments ADD COLUMN plan TEXT"); } catch (e) {}

db.exec(`CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT
)`);

const defaultAdminUsername = "admin";
const defaultAdminPassword = "admin123";

if (!db.prepare("SELECT id FROM admins WHERE username = ?").get(defaultAdminUsername)) {
    db.prepare(`
        INSERT INTO admins (username, password_hash)
        VALUES (?, ?)
    `).run(defaultAdminUsername, bcrypt.hashSync(defaultAdminPassword, 12));
}

for (const name of [
    "Action", "Comedy", "Drama", "Horror",
    "Romance", "Animation", "Documentary"
]) {
    db.prepare("INSERT OR IGNORE INTO categories (name) VALUES (?)").run(name);
}

// ===============================
// MIDDLEWARE
// ===============================

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
    secret: process.env.SESSION_SECRET || "CHANGE_THIS_SECRET_BEFORE_PRODUCTION",
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 24 * 60 * 60 * 1000
    }
}));

app.use("/posters", express.static(POSTER_DIR));
app.use("/public", express.static(PUBLIC_DIR));

// ===============================
// HELPERS
// ===============================

function escapeHtml(value) {
    if (value === null || value === undefined) return "";
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function getVideoContentType(filename) {
    const ext = path.extname(filename).toLowerCase();
    return {
        ".mp4": "video/mp4",
        ".webm": "video/webm",
        ".mov": "video/quicktime",
        ".m4v": "video/mp4"
    }[ext] || "application/octet-stream";
}

function getActiveSubscription(userId) {
    return db.prepare(`
        SELECT *
        FROM subscriptions
        WHERE user_id = ?
          AND status = 'active'
          AND datetime(expires_at) > datetime('now')
        ORDER BY datetime(expires_at) DESC
        LIMIT 1
    `).get(userId);
}

function requireUser(req, res, next) {
    if (!req.session.userId) return res.redirect("/login");
    next();
}

function requireSubscription(req, res, next) {
    if (!req.session.userId) return res.redirect("/login");

    const subscription = getActiveSubscription(req.session.userId);

    if (!subscription) return res.redirect("/subscribe");

    req.subscription = subscription;
    next();
}

function requireAdmin(req, res, next) {
    if (!req.session.adminId) return res.redirect("/admin");
    next();
}

function formatMoney(amount) {
    return "UGX " + Number(amount).toLocaleString("en-UG");
}

function getPlan(plan) {
    const plans = {
        "16_hours": { name: "16 Hours", amount: 1000, hours: 16 },
        "7_days": { name: "7 Days", amount: 6000, hours: 24 * 7 },
        "30_days": { name: "30 Days", amount: 25000, hours: 24 * 30 }
    };
    return plans[plan] || null;
}

function page(req, title, body, extraHead = "") {
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} - MyStream</title>
${extraHead}
<style>
*{box-sizing:border-box}
body{margin:0;background:#080808;color:#fff;font-family:Arial,sans-serif}
a{color:#fff;text-decoration:none}
header{background:#151515;padding:16px 5%;display:flex;justify-content:space-between;align-items:center;gap:20px;flex-wrap:wrap}
.logo{font-size:25px;font-weight:bold}
nav{display:flex;gap:15px;align-items:center;flex-wrap:wrap}
nav a{color:#ddd}
.container{width:92%;max-width:1200px;margin:35px auto}
.card{background:#171717;border-radius:12px;padding:22px}
button,.button{display:inline-block;background:#e50914;color:#fff;border:0;border-radius:7px;padding:12px 18px;cursor:pointer;font-weight:bold;text-decoration:none}
.secondary{background:#333}
.danger{background:#8b0000}
input,textarea,select{width:100%;padding:12px;margin:7px 0 14px;background:#111;color:#fff;border:1px solid #444;border-radius:6px}
label{display:block;color:#ccc;margin-top:8px}
.notice{background:#202020;border-radius:8px;padding:15px;margin:15px 0}
.success{background:#123d20}
.error{background:#4a1515}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:22px}
.movie-card{background:#171717;border-radius:12px;overflow:hidden}
.movie-card img,.no-poster{width:100%;height:300px;object-fit:cover}
.no-poster{display:flex;align-items:center;justify-content:center;background:#252525;font-size:60px}
.movie-info{padding:17px}
.muted{color:#aaa}
.price{font-size:30px;font-weight:bold;margin:15px 0}
table{width:100%;border-collapse:collapse;background:#171717}
th,td{text-align:left;padding:12px;border-bottom:1px solid #333}
.hero{padding:65px 5%;background:linear-gradient(135deg,#181818,#050505)}
.hero h1{font-size:44px;margin:0 0 10px}
.poster{max-width:320px;width:100%;border-radius:10px}
video{width:100%;max-height:75vh;background:#000}
.row{display:flex;gap:10px;flex-wrap:wrap}
@media(max-width:600px){.hero h1{font-size:32px}.movie-card img,.no-poster{height:260px}}
</style>
</head>
<body>
<header>
<div class="logo">🎬 MyStream</div>
<nav>
<a href="/">Home</a>
${req.session.userId
    ? `<a href="/account">My Account</a><a href="/subscribe">Subscribe</a><a href="/logout">Logout</a>`
    : `<a href="/register">Register</a><a href="/login">Login</a>`}
<a href="/admin">Admin</a>
</nav>
</header>
${body}
</body>
</html>`;
}

// ===============================
// HOME
// ===============================

app.get("/", (req, res) => {
    const search = String(req.query.search || "").trim();
    const categoryId = Number(req.query.category || 0);

    let movies;

    if (search && categoryId) {
        movies = db.prepare(`
            SELECT movies.*, categories.name AS category_name
            FROM movies
            LEFT JOIN categories ON movies.category_id = categories.id
            WHERE (movies.title LIKE ? OR movies.description LIKE ?)
              AND movies.category_id = ?
            ORDER BY movies.id DESC
        `).all(`%${search}%`, `%${search}%`, categoryId);
    } else if (search) {
        movies = db.prepare(`
            SELECT movies.*, categories.name AS category_name
            FROM movies
            LEFT JOIN categories ON movies.category_id = categories.id
            WHERE movies.title LIKE ? OR movies.description LIKE ?
            ORDER BY movies.id DESC
        `).all(`%${search}%`, `%${search}%`);
    } else if (categoryId) {
        movies = db.prepare(`
            SELECT movies.*, categories.name AS category_name
            FROM movies
            LEFT JOIN categories ON movies.category_id = categories.id
            WHERE movies.category_id = ?
            ORDER BY movies.id DESC
        `).all(categoryId);
    } else {
        movies = db.prepare(`
            SELECT movies.*, categories.name AS category_name
            FROM movies
            LEFT JOIN categories ON movies.category_id = categories.id
            ORDER BY movies.id DESC
        `).all();
    }

    const categories = db.prepare("SELECT * FROM categories ORDER BY name").all();

    const cards = movies.length
        ? movies.map(movie => `
<div class="movie-card">
${movie.poster
    ? `<img src="/posters/${encodeURIComponent(movie.poster)}" alt="${escapeHtml(movie.title)}">`
    : `<div class="no-poster">🎬</div>`}
<div class="movie-info">
<h3>${escapeHtml(movie.title)}</h3>
<p class="muted">${escapeHtml(movie.category_name || "Uncategorized")}${movie.year ? " • " + movie.year : ""}</p>
<p class="muted">${movie.views || 0} views</p>
<a class="button" href="/movie/${movie.id}">View Movie</a>
</div>
</div>`).join("")
        : `<div class="card"><h2>No movies found</h2><p class="muted">Try another search or category.</p></div>`;

    const body = `
<section class="hero">
<h1>Watch your favorite movies</h1>
<p class="muted">Subscribe to MyStream and enjoy authorized movies from anywhere.</p>
</section>
<div class="container">
<div class="card">
<form method="GET" action="/">
<div class="row">
<div style="flex:2;min-width:220px">
<input name="search" value="${escapeHtml(search)}" placeholder="Search movies...">
</div>
<div style="flex:1;min-width:180px">
<select name="category">
<option value="0">All categories</option>
${categories.map(c => `<option value="${c.id}" ${categoryId === c.id ? "selected" : ""}>${escapeHtml(c.name)}</option>`).join("")}
</select>
</div>
<div style="min-width:120px">
<button type="submit">Search</button>
</div>
</div>
</form>
</div>
<h2>Movies</h2>
<div class="grid">${cards}</div>
</div>`;

    res.send(page(req, "Home", body));
});

// ===============================
// MOVIE DETAILS
// ===============================

app.get("/movie/:id", (req, res) => {
    const movie = db.prepare(`
        SELECT movies.*, categories.name AS category_name
        FROM movies
        LEFT JOIN categories ON movies.category_id = categories.id
        WHERE movies.id = ?
    `).get(req.params.id);

    if (!movie) return res.status(404).send("Movie not found.");

    const subscription = req.session.userId
        ? getActiveSubscription(req.session.userId)
        : null;

    let action;

    if (!req.session.userId) {
        action = `<a class="button" href="/login">Login to Watch</a>`;
    } else if (!subscription) {
        action = `<a class="button" href="/subscribe">Subscribe to Watch</a>`;
    } else {
        action = `<a class="button" href="/watch/${movie.id}">▶ Watch Movie</a>`;
    }

    const body = `
<div class="container">
<a class="muted" href="/">← Back to movies</a>
<div class="card" style="margin-top:20px">
${movie.poster ? `<img class="poster" src="/posters/${encodeURIComponent(movie.poster)}" alt="${escapeHtml(movie.title)}">` : ""}
<h1>${escapeHtml(movie.title)}</h1>
<p class="muted">${escapeHtml(movie.category_name || "Uncategorized")}${movie.year ? " • " + movie.year : ""}${movie.duration ? " • " + escapeHtml(movie.duration) : ""}</p>
<p>${escapeHtml(movie.description || "")}</p>
${action}
</div>
</div>`;

    res.send(page(req, movie.title, body));
});

// ===============================
// PROTECTED STREAM
// ===============================

app.get("/stream/:id", requireSubscription, (req, res) => {
    const movie = db.prepare("SELECT * FROM movies WHERE id = ?").get(req.params.id);

    if (!movie) return res.status(404).send("Movie not found.");

    const safeFilename = path.basename(movie.filename);
    const videoPath = path.join(VIDEO_DIR, safeFilename);

    if (!fs.existsSync(videoPath)) return res.status(404).send("Video file not found.");

    const stat = fs.statSync(videoPath);
    const fileSize = stat.size;
    const contentType = getVideoContentType(movie.filename);
    const range = req.headers.range;

    if (!range) {
        res.writeHead(200, {
            "Content-Length": fileSize,
            "Content-Type": contentType,
            "Accept-Ranges": "bytes"
        });
        return fs.createReadStream(videoPath).pipe(res);
    }

    const match = range.match(/bytes=(\d*)-(\d*)/);
    if (!match) return res.status(416).send("Invalid range.");

    const start = match[1] ? Number(match[1]) : Math.max(0, fileSize - Number(match[2] || 0));
    const requestedEnd = match[2] ? Number(match[2]) : fileSize - 1;
    const end = Math.min(requestedEnd, fileSize - 1);

    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end || start >= fileSize) {
        res.setHeader("Content-Range", `bytes */${fileSize}`);
        return res.status(416).send("Invalid video range.");
    }

    const chunkSize = end - start + 1;

    res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunkSize,
        "Content-Type": contentType
    });

    fs.createReadStream(videoPath, { start, end }).pipe(res);
});

// ===============================
// WATCH PAGE
// ===============================

app.get("/watch/:id", requireSubscription, (req, res) => {
    const movie = db.prepare(`
        SELECT movies.*, categories.name AS category_name
        FROM movies
        LEFT JOIN categories ON movies.category_id = categories.id
        WHERE movies.id = ?
    `).get(req.params.id);

    if (!movie) return res.status(404).send("Movie not found.");

    db.prepare("UPDATE movies SET views = views + 1 WHERE id = ?").run(movie.id);

    const body = `
<div class="container">
<a class="muted" href="/movie/${movie.id}">← Back to movie</a>
<h1>${escapeHtml(movie.title)}</h1>
<p class="muted">Subscription active until ${escapeHtml(req.subscription.expires_at)}</p>
<video controls autoplay playsinline>
<source src="/stream/${movie.id}" type="${getVideoContentType(movie.filename)}">
Your browser does not support video playback.
</video>
<p>${escapeHtml(movie.description || "")}</p>
</div>`;

    res.send(page(req, "Watching " + movie.title, body));
});

// ===============================
// REGISTER
// ===============================

app.get("/register", (req, res) => {
    const body = `
<div class="container" style="max-width:500px">
<div class="card">
<h1>Create Account</h1>
<form method="POST" action="/api/register">
<label>Full name</label>
<input name="name" required>
<label>Email</label>
<input name="email" type="email" required>
<label>Phone number</label>
<input name="phone" placeholder="MTN or Airtel number">
<label>Password</label>
<input name="password" type="password" minlength="6" required>
<button type="submit">Create Account</button>
</form>
<p class="muted">Already have an account? <a href="/login">Login</a></p>
</div>
</div>`;
    res.send(page(req, "Create Account", body));
});

app.post("/api/register", (req, res) => {
    const name = String(req.body.name || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const phone = String(req.body.phone || "").trim();
    const password = String(req.body.password || "");

    if (!name || !email || password.length < 6) {
        return res.status(400).send("Name, valid email and a password of at least 6 characters are required.");
    }

    if (db.prepare("SELECT id FROM users WHERE email = ?").get(email)) {
        return res.status(400).send("An account with that email already exists.");
    }

    db.prepare(`
        INSERT INTO users (name, email, phone, password_hash)
        VALUES (?, ?, ?, ?)
    `).run(name, email, phone, bcrypt.hashSync(password, 12));

    res.redirect("/login?registered=1");
});

// ===============================
// LOGIN / LOGOUT
// ===============================

app.get("/login", (req, res) => {
    const message = req.query.registered ? `<div class="notice success">Account created. You can now log in.</div>` : "";

    const body = `
<div class="container" style="max-width:500px">
<div class="card">
<h1>Login</h1>
${message}
<form method="POST" action="/api/login">
<label>Email</label>
<input name="email" type="email" required>
<label>Password</label>
<input name="password" type="password" required>
<button type="submit">Login</button>
</form>
<p class="muted">Don't have an account? <a href="/register">Register</a></p>
</div>
</div>`;
    res.send(page(req, "Login", body));
});

app.post("/api/login", (req, res) => {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);

    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
        return res.status(401).send("Invalid email or password.");
    }

    req.session.userId = user.id;
    req.session.userName = user.name;
    res.redirect("/");
});

app.get("/logout", (req, res) => {
    req.session.destroy(() => res.redirect("/"));
});

// ===============================
// USER ACCOUNT
// ===============================

app.get("/account", requireUser, (req, res) => {
    const user = db.prepare("SELECT id,name,email,phone,created_at FROM users WHERE id = ?").get(req.session.userId);
    const subscription = getActiveSubscription(user.id);

    const payments = db.prepare(`
        SELECT * FROM payments
        WHERE user_id = ?
        ORDER BY id DESC
        LIMIT 20
    `).all(user.id);

    const body = `
<div class="container">
<h1>My Account</h1>
<div class="card">
<h2>${escapeHtml(user.name)}</h2>
<p>${escapeHtml(user.email)}</p>
<p>${escapeHtml(user.phone || "No phone number added")}</p>
</div>

<div class="card" style="margin-top:20px">
<h2>Subscription</h2>
${subscription
    ? `<div class="notice success">Active: ${escapeHtml(subscription.plan)} — expires ${escapeHtml(subscription.expires_at)}</div>`
    : `<div class="notice">No active subscription. <a href="/subscribe">Choose a plan</a>.</div>`}
</div>

<div class="card" style="margin-top:20px">
<h2>Payment History</h2>
${payments.length ? `<table><tr><th>Amount</th><th>Provider</th><th>Status</th><th>Date</th></tr>${payments.map(p => `
<tr><td>${formatMoney(p.amount)}</td><td>${escapeHtml(p.provider)}</td><td>${escapeHtml(p.status)}</td><td>${escapeHtml(p.created_at)}</td></tr>`).join("")}</table>` : `<p class="muted">No payments yet.</p>`}
</div>
</div>`;

    res.send(page(req, "My Account", body));
});

// ===============================
// SUBSCRIPTION PAGE
// ===============================

app.get("/subscribe", requireUser, (req, res) => {
    const active = getActiveSubscription(req.session.userId);

    const plans = [
        ["16_hours", "16 Hours", 1000, "Access for 16 hours"],
        ["7_days", "7 Days", 6000, "Access for 7 days"],
        ["30_days", "30 Days", 25000, "Access for 30 days"]
    ];

    const body = `
<div class="container">
<h1>Choose Your Subscription</h1>
${active ? `<div class="notice success">Your subscription is active until <strong>${escapeHtml(active.expires_at)}</strong>.</div>` : ""}
<div class="grid">
${plans.map(([id,name,amount,description]) => `
<div class="card">
<h2>${name}</h2>
<div class="price">${formatMoney(amount)}</div>
<p class="muted">${description}</p>
${active
    ? `<p class="muted">You already have an active subscription.</p>`
    : `<a class="button" href="/pay?plan=${id}">Choose ${name}</a>`}
</div>`).join("")}
</div>
</div>`;

    res.send(page(req, "Subscription", body));
});

// ===============================
// PESAPAL PAYMENT HELPERS
// ===============================

function pesapalBaseUrl() {
    const env = String(process.env.PESAPAL_ENV || "live").toLowerCase();
    return env === "sandbox"
        ? "https://cybqa.pesapal.com/pesapalv3"
        : "https://pay.pesapal.com/v3";
}

function pesapalConsumerKey() {
    const key = String(process.env.PESAPAL_CONSUMER_KEY || "").trim();
    if (!key) throw new Error("PESAPAL_CONSUMER_KEY is not configured.");
    return key;
}

function pesapalConsumerSecret() {
    const secret = String(process.env.PESAPAL_CONSUMER_SECRET || "").trim();
    if (!secret) throw new Error("PESAPAL_CONSUMER_SECRET is not configured.");
    return secret;
}

function getSetting(key) {
    const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key);
    return row ? String(row.value || "") : "";
}

function setSetting(key, value) {
    db.prepare(`
        INSERT INTO app_settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, String(value));
}

async function pesapalRequest(pathname, options = {}) {
    const url = `${pesapalBaseUrl()}${pathname}`;
    const response = await fetch(url, {
        ...options,
        headers: {
            "Accept": "application/json",
            "Content-Type": "application/json",
            ...(options.headers || {})
        }
    });

    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { message: text }; }

    if (!response.ok) {
        const message = data?.error?.message || data?.message || `Pesapal HTTP ${response.status}`;
        const error = new Error(message);
        error.status = response.status;
        error.data = data;
        throw error;
    }

    return data;
}

async function pesapalGetToken() {
    const data = await pesapalRequest("/api/Auth/RequestToken", {
        method: "POST",
        body: JSON.stringify({
            consumer_key: pesapalConsumerKey(),
            consumer_secret: pesapalConsumerSecret()
        })
    });

    if (!data?.token) {
        throw new Error(data?.message || "Pesapal did not return an access token.");
    }

    return data.token;
}

async function pesapalAuthenticatedRequest(pathname, options = {}) {
    const token = await pesapalGetToken();

    return pesapalRequest(pathname, {
        ...options,
        headers: {
            "Authorization": `Bearer ${token}`,
            ...(options.headers || {})
        }
    });
}

function pesapalCallbackUrl() {
    const value = String(process.env.PESAPAL_CALLBACK_URL || "").trim();
    if (!value) {
        throw new Error("PESAPAL_CALLBACK_URL is not configured.");
    }
    return value;
}

function pesapalIpnUrl() {
    const value = String(process.env.PESAPAL_IPN_URL || "").trim();
    if (!value) {
        throw new Error("PESAPAL_IPN_URL is not configured.");
    }
    return value;
}

async function registerPesapalIpn() {
    const data = await pesapalAuthenticatedRequest("/api/URLSetup/RegisterIPN", {
        method: "POST",
        body: JSON.stringify({
            url: pesapalIpnUrl(),
            ipn_notification_type: "POST"
        })
    });

    if (!data?.ipn_id) {
        throw new Error(data?.error?.message || data?.message || "Pesapal did not return an IPN ID.");
    }

    setSetting("pesapal_ipn_id", data.ipn_id);
    return data;
}

async function ensurePesapalIpnId() {
    const saved = getSetting("pesapal_ipn_id");
    if (saved) return saved;

    const envId = String(process.env.PESAPAL_IPN_ID || "").trim();
    if (envId) {
        setSetting("pesapal_ipn_id", envId);
        return envId;
    }

    throw new Error("Pesapal IPN is not registered yet. Register the IPN from the admin dashboard first.");
}

function splitName(fullName) {
    const parts = String(fullName || "Customer").trim().split(/\s+/).filter(Boolean);
    return {
        firstName: parts[0] || "Customer",
        lastName: parts.length > 1 ? parts.slice(1).join(" ") : ""
    };
}

async function submitPesapalOrder({ paymentId, plan, user }) {
    const merchantReference = `MYS-${paymentId}-${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
    const ipnId = await ensurePesapalIpnId();
    const { firstName, lastName } = splitName(user.name);

    const payload = {
        id: merchantReference,
        currency: "UGX",
        amount: Number(plan.amount),
        description: `MyStream ${plan.name} subscription`,
        callback_url: pesapalCallbackUrl(),
        redirect_mode: "TOP_WINDOW",
        cancellation_url: pesapalCallbackUrl(),
        notification_id: ipnId,
        billing_address: {
            email_address: user.email || undefined,
            phone_number: user.phone || undefined,
            country_code: "UG",
            first_name: firstName,
            last_name: lastName,
            city: "Kampala"
        }
    };

    const data = await pesapalAuthenticatedRequest("/api/Transactions/SubmitOrderRequest", {
        method: "POST",
        body: JSON.stringify(payload)
    });

    if (!data?.redirect_url || !data?.order_tracking_id) {
        throw new Error(data?.error?.message || data?.message || "Pesapal did not return a payment URL.");
    }

    return {
        merchantReference,
        orderTrackingId: data.order_tracking_id,
        redirectUrl: data.redirect_url
    };
}

async function getPesapalTransactionStatus(orderTrackingId) {
    if (!orderTrackingId) throw new Error("Pesapal OrderTrackingId is missing.");

    return pesapalAuthenticatedRequest(
        `/api/Transactions/GetTransactionStatus?orderTrackingId=${encodeURIComponent(orderTrackingId)}`,
        { method: "GET" }
    );
}

function activatePesapalPayment(payment, transaction) {
    const plan = getPlan(payment.plan);
    if (!plan) throw new Error("Payment plan is invalid.");

    const existing = getActiveSubscription(payment.user_id);
    if (existing) {
        db.prepare(`
            UPDATE payments
            SET status = 'success', gateway_transaction_id = ?
            WHERE id = ?
        `).run(String(transaction.confirmation_code || payment.gateway_transaction_id || payment.transaction_id), payment.id);
        return;
    }

    const startsAt = new Date();
    const expiresAt = new Date(startsAt.getTime() + plan.hours * 60 * 60 * 1000);
    const gatewayId = String(transaction.order_tracking_id || payment.gateway_transaction_id || payment.transaction_id || "");

    const tx = db.transaction(() => {
        db.prepare(`
            UPDATE payments
            SET status = 'success', gateway_transaction_id = ?
            WHERE id = ?
        `).run(gatewayId, payment.id);

        db.prepare(`
            INSERT INTO subscriptions
            (user_id, plan, amount, provider, transaction_id, starts_at, expires_at, status)
            VALUES (?, ?, ?, 'PESAPAL', ?, ?, ?, 'active')
        `).run(
            payment.user_id,
            payment.plan,
            payment.amount,
            gatewayId,
            startsAt.toISOString(),
            expiresAt.toISOString()
        );
    });

    tx();
}

async function processPesapalPayment(orderTrackingId, merchantReference) {
    const payment = db.prepare(`
        SELECT * FROM payments
        WHERE transaction_id = ? AND provider = 'PESAPAL'
        ORDER BY id DESC LIMIT 1
    `).get(merchantReference);

    if (!payment) {
        throw new Error("MyStream payment could not be matched to the Pesapal merchant reference.");
    }

    const transaction = await getPesapalTransactionStatus(orderTrackingId);

    const paidAmount = Number(transaction?.amount);
    const expectedAmount = Number(payment.amount);
    const currencyOk = String(transaction?.currency || "").toUpperCase() === "UGX";
    const amountOk = Number.isFinite(paidAmount) && paidAmount >= expectedAmount;
    const referenceOk = String(transaction?.merchant_reference || "") === String(payment.transaction_id || "");
    const completed = Number(transaction?.status_code) === 1 ||
        String(transaction?.payment_status_description || "").toUpperCase() === "COMPLETED";

    if (!completed || !currencyOk || !amountOk || !referenceOk) {
        if ([1, 2, 3].includes(Number(transaction?.status_code))) {
            db.prepare(`
                UPDATE payments
                SET status = ?, gateway_transaction_id = ?
                WHERE id = ?
            `).run(
                completed ? "success" : "failed",
                String(orderTrackingId),
                payment.id
            );
        }

        return { ok: false, payment, transaction };
    }

    activatePesapalPayment(payment, {
        ...transaction,
        order_tracking_id: orderTrackingId
    });

    return { ok: true, payment, transaction };
}

// ===============================
// PESAPAL IPN REGISTRATION
// ===============================

app.get("/admin/pesapal/register-ipn", requireAdmin, async (req, res) => {
    try {
        const result = await registerPesapalIpn();
        res.send(page(req, "Pesapal IPN", `
<div class="container" style="max-width:700px"><div class="card">
<h1>Pesapal IPN Registered</h1>
<div class="notice success">
<strong>IPN ID:</strong> ${escapeHtml(result.ipn_id)}
</div>
<p>MyStream can now submit Pesapal payment orders.</p>
<a class="button" href="/admin/dashboard">Back to Admin</a>
</div></div>`));
    } catch (error) {
        console.error("Pesapal IPN registration error:", error?.data || error);
        res.status(502).send(page(req, "Pesapal IPN Error", `
<div class="container" style="max-width:700px"><div class="card">
<h1>Could not register Pesapal IPN</h1>
<div class="notice error">${escapeHtml(error.message || "Unknown error")}</div>
<p>Check that PESAPAL_IPN_URL is a public HTTPS URL and that your live credentials are correct.</p>
<a class="button" href="/admin/dashboard">Back to Admin</a>
</div></div>`));
    }
});

// ===============================
// PESAPAL PAYMENT PAGE
// ===============================

app.get("/pay", requireUser, (req, res) => {
    const planId = String(req.query.plan || "");
    const plan = getPlan(planId);

    if (!plan) return res.status(400).send("Invalid subscription plan.");
    if (getActiveSubscription(req.session.userId)) return res.redirect("/account");

    const user = db.prepare("SELECT id,name,email,phone FROM users WHERE id = ?").get(req.session.userId);

    const body = `
<div class="container" style="max-width:650px">
<div class="card">
<h1>Pay with Pesapal</h1>
<div class="price">${formatMoney(plan.amount)}</div>
<p>Continue to Pesapal's secure checkout. Available payment methods are shown by Pesapal, including supported mobile-money and card options.</p>

<form method="POST" action="/api/payment/request">
<input type="hidden" name="plan" value="${escapeHtml(planId)}">

<label>Phone number</label>
<input name="phone" value="${escapeHtml(user.phone || "")}" placeholder="e.g. 077xxxxxxx">

<button type="submit">Continue to Pesapal</button>
</form>

<div class="notice" style="margin-top:20px">
<strong>Payment:</strong> ${formatMoney(plan.amount)} UGX<br>
<strong>Gateway:</strong> Pesapal<br>
<strong>Networks:</strong> MTN Mobile Money and Airtel Money are supported by Pesapal in Uganda.
</div>
</div>
</div>`;

    res.send(page(req, "Pesapal Payment", body));
});

// ===============================
// START PESAPAL PAYMENT
// ===============================

app.post("/api/payment/request", requireUser, async (req, res) => {
    const planId = String(req.body.plan || "");
    const phone = String(req.body.phone || "").trim();
    const plan = getPlan(planId);

    if (!plan) return res.status(400).send("Invalid subscription plan.");
    if (getActiveSubscription(req.session.userId)) return res.redirect("/account");

    const user = db.prepare("SELECT id,name,email,phone FROM users WHERE id = ?").get(req.session.userId);
    if (!user) return res.status(401).send("User account not found.");

    if (phone) {
        db.prepare("UPDATE users SET phone = ? WHERE id = ?").run(phone, user.id);
        user.phone = phone;
    }

    if (!user.email && !user.phone) {
        return res.status(400).send("Your account needs an email address or phone number for payment.");
    }

    const localRef = "MYS-" + crypto.randomBytes(10).toString("hex").toUpperCase();

    const result = db.prepare(`
        INSERT INTO payments (user_id, amount, provider, transaction_id, status)
        VALUES (?, ?, 'PESAPAL', ?, 'pending')
    `).run(req.session.userId, plan.amount, localRef);

    const paymentId = Number(result.lastInsertRowid);
    db.prepare("UPDATE payments SET plan = ? WHERE id = ?").run(planId, paymentId);

    try {
        const initiated = await submitPesapalOrder({ paymentId, plan, user });

        db.prepare(`
            UPDATE payments
            SET transaction_id = ?, gateway_transaction_id = ?
            WHERE id = ?
        `).run(initiated.merchantReference, initiated.orderTrackingId, paymentId);

        res.redirect(initiated.redirectUrl);
    } catch (error) {
        console.error("Pesapal payment initiation error:", error?.data || error);
        db.prepare("UPDATE payments SET status = 'failed' WHERE id = ?").run(paymentId);
        res.status(502).send(page(req, "Payment Error", `
<div class="container" style="max-width:700px"><div class="card">
<h1>Unable to start payment</h1>
<div class="notice error">${escapeHtml(error.message || "Pesapal payment could not be started.")}</div>
<p>Make sure the Pesapal IPN is registered before trying again.</p>
<a class="button" href="/subscribe">Back to subscriptions</a>
</div></div>`));
    }
});

// ===============================
// PESAPAL CALLBACK
// ===============================

app.get("/payment/callback", async (req, res) => {
    const orderTrackingId = String(req.query.OrderTrackingId || req.query.orderTrackingId || "").trim();
    const merchantReference = String(req.query.OrderMerchantReference || req.query.orderMerchantReference || "").trim();

    if (!orderTrackingId || !merchantReference) {
        return res.status(400).send(page(req, "Payment", `
<div class="container" style="max-width:650px"><div class="card">
<h1>Payment not confirmed</h1>
<p>Pesapal did not return enough information to check this payment.</p>
<a class="button" href="/account">Go to My Account</a>
</div></div>`));
    }

    try {
        const result = await processPesapalPayment(orderTrackingId, merchantReference);

        if (!result.ok) {
            return res.status(400).send(page(req, "Payment Pending or Failed", `
<div class="container" style="max-width:700px"><div class="card">
<h1>Payment not completed</h1>
<div class="notice error">Pesapal has not confirmed a completed UGX payment for this subscription.</div>
<p>Status: ${escapeHtml(result.transaction?.payment_status_description || "Pending")}</p>
<a class="button" href="/account">Go to My Account</a>
</div></div>`));
        }

        return res.redirect("/");
    } catch (error) {
        console.error("Pesapal callback verification error:", error?.data || error);
        res.status(502).send(page(req, "Payment Verification", `
<div class="container" style="max-width:700px"><div class="card">
<h1>Payment is being verified</h1>
<p>We could not complete verification right now. Do not pay again yet. Check your account shortly.</p>
<a class="button" href="/account">Go to My Account</a>
</div></div>`));
    }
});

// ===============================
// PESAPAL IPN
// ===============================

app.post("/api/pesapal/ipn", async (req, res) => {
    const orderTrackingId = String(req.body?.OrderTrackingId || req.query.OrderTrackingId || "").trim();
    const merchantReference = String(req.body?.OrderMerchantReference || req.query.OrderMerchantReference || "").trim();
    const notificationType = String(req.body?.OrderNotificationType || req.query.OrderNotificationType || "IPNCHANGE");

    if (!orderTrackingId || !merchantReference) {
        return res.status(400).json({
            orderNotificationType: notificationType,
            orderTrackingId,
            orderMerchantReference: merchantReference,
            status: 500
        });
    }

    try {
        await processPesapalPayment(orderTrackingId, merchantReference);
        return res.json({
            orderNotificationType: notificationType,
            orderTrackingId,
            orderMerchantReference: merchantReference,
            status: 200
        });
    } catch (error) {
        console.error("Pesapal IPN processing error:", error?.data || error);
        return res.status(500).json({
            orderNotificationType: notificationType,
            orderTrackingId,
            orderMerchantReference: merchantReference,
            status: 500
        });
    }
});

// Also accept GET IPN calls in case the registered endpoint is changed to GET later.
app.get("/api/pesapal/ipn", async (req, res) => {
    const orderTrackingId = String(req.query.OrderTrackingId || req.query.orderTrackingId || "").trim();
    const merchantReference = String(req.query.OrderMerchantReference || req.query.orderMerchantReference || "").trim();
    const notificationType = String(req.query.OrderNotificationType || req.query.orderNotificationType || "IPNCHANGE");

    if (!orderTrackingId || !merchantReference) {
        return res.status(400).json({
            orderNotificationType: notificationType,
            orderTrackingId,
            orderMerchantReference: merchantReference,
            status: 500
        });
    }

    try {
        await processPesapalPayment(orderTrackingId, merchantReference);
        return res.json({
            orderNotificationType: notificationType,
            orderTrackingId,
            orderMerchantReference: merchantReference,
            status: 200
        });
    } catch (error) {
        console.error("Pesapal GET IPN processing error:", error?.data || error);
        return res.status(500).json({
            orderNotificationType: notificationType,
            orderTrackingId,
            orderMerchantReference: merchantReference,
            status: 500
        });
    }
});

// ===============================
// LOCAL TEST ACTIVATION
// ===============================
// This is deliberately disabled when NODE_ENV=production.

app.post("/test-activate", requireUser, (req, res) => {
    if (process.env.NODE_ENV === "production") {
        return res.status(404).send("Not found.");
    }

    const planId = String(req.body.plan || "");
    const plan = getPlan(planId);

    if (!plan) return res.status(400).send("Invalid subscription plan.");
    if (getActiveSubscription(req.session.userId)) return res.redirect("/account");

    const startsAt = new Date();
    const expiresAt = new Date(startsAt.getTime() + plan.hours * 60 * 60 * 1000);
    const transactionId = "TEST-" + Date.now();

    db.prepare(`
        INSERT INTO payments (user_id, amount, provider, transaction_id, status)
        VALUES (?, ?, 'TEST', ?, 'success')
    `).run(req.session.userId, plan.amount, transactionId);

    db.prepare(`
        INSERT INTO subscriptions
        (user_id, plan, amount, provider, transaction_id, starts_at, expires_at, status)
        VALUES (?, ?, ?, 'TEST', ?, ?, ?, 'active')
    `).run(
        req.session.userId,
        planId,
        plan.amount,
        transactionId,
        startsAt.toISOString(),
        expiresAt.toISOString()
    );

    res.redirect("/account");
});

// ===============================
// ADMIN LOGIN
// ===============================

app.get("/admin", (req, res) => {
    if (req.session.adminId) return res.redirect("/admin/dashboard");

    const body = `
<div class="container" style="max-width:450px">
<div class="card">
<h1>Admin Login</h1>
<form method="POST" action="/api/admin-login">
<label>Username</label>
<input name="username" required>
<label>Password</label>
<input name="password" type="password" required>
<button type="submit">Login</button>
</form>
</div>
</div>`;

    res.send(page(req, "Admin Login", body));
});

app.post("/api/admin-login", (req, res) => {
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");

    const admin = db.prepare("SELECT * FROM admins WHERE username = ?").get(username);

    if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
        return res.status(401).send("Invalid admin login.");
    }

    req.session.adminId = admin.id;
    req.session.adminUsername = admin.username;
    res.redirect("/admin/dashboard");
});

app.get("/admin/logout", (req, res) => {
    delete req.session.adminId;
    delete req.session.adminUsername;
    res.redirect("/admin");
});

// ===============================
// ADMIN DASHBOARD
// ===============================

app.get("/admin/dashboard", requireAdmin, (req, res) => {
    const movies = db.prepare(`
        SELECT movies.*, categories.name AS category_name
        FROM movies
        LEFT JOIN categories ON movies.category_id = categories.id
        ORDER BY movies.id DESC
    `).all();

    const categories = db.prepare("SELECT * FROM categories ORDER BY name").all();
    const users = db.prepare("SELECT id,name,email,phone,created_at FROM users ORDER BY id DESC").all();
    const payments = db.prepare(`
        SELECT payments.*, users.name AS user_name, users.email
        FROM payments
        LEFT JOIN users ON payments.user_id = users.id
        ORDER BY payments.id DESC
        LIMIT 50
    `).all();

    const body = `
<div class="container">
<div class="row" style="justify-content:space-between">
<h1>MyStream Admin</h1>
<a class="button secondary" href="/admin/pesapal/register-ipn">Register Pesapal IPN</a>
<a class="button secondary" href="/admin/logout">Admin Logout</a>
</div>

<div class="card">
<h2>Upload Movie</h2>
<form method="POST" action="/api/admin/upload" enctype="multipart/form-data">
<label>Movie title</label>
<input name="title" required>

<label>Description</label>
<textarea name="description" rows="5"></textarea>

<label>Category</label>
<select name="category_id">
<option value="">Choose category</option>
${categories.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("")}
</select>

<label>Release year</label>
<input name="year" type="number" min="1900" max="2100">

<label>Duration</label>
<input name="duration" placeholder="e.g. 1h 45m">

<label>Movie file</label>
<input name="video" type="file" accept=".mp4,.webm,.mov,.m4v" required>

<label>Poster</label>
<input name="poster" type="file" accept="image/jpeg,image/png,image/webp">

<button type="submit">Upload Movie</button>
</form>
</div>

<div class="card" style="margin-top:20px">
<h2>Movies (${movies.length})</h2>
${movies.length ? `<table>
<tr><th>Movie</th><th>Category</th><th>Views</th><th>Action</th></tr>
${movies.map(m => `<tr>
<td>${escapeHtml(m.title)}</td>
<td>${escapeHtml(m.category_name || "Uncategorized")}</td>
<td>${m.views || 0}</td>
<td>
<form method="POST" action="/api/admin/delete-movie" onsubmit="return confirm('Delete this movie?')">
<input type="hidden" name="id" value="${m.id}">
<button class="danger" type="submit">Delete</button>
</form>
</td>
</tr>`).join("")}
</table>` : `<p class="muted">No movies uploaded.</p>`}
</div>

<div class="card" style="margin-top:20px">
<h2>Users (${users.length})</h2>
${users.length ? `<table>
<tr><th>Name</th><th>Email</th><th>Phone</th><th>Created</th></tr>
${users.map(u => `<tr><td>${escapeHtml(u.name)}</td><td>${escapeHtml(u.email)}</td><td>${escapeHtml(u.phone || "")}</td><td>${escapeHtml(u.created_at)}</td></tr>`).join("")}
</table>` : `<p class="muted">No users yet.</p>`}
</div>

<div class="card" style="margin-top:20px">
<h2>Recent Payments</h2>
${payments.length ? `<table>
<tr><th>User</th><th>Amount</th><th>Provider</th><th>Status</th><th>Reference</th></tr>
${payments.map(p => `<tr>
<td>${escapeHtml(p.user_name || p.email || "")}</td>
<td>${formatMoney(p.amount)}</td>
<td>${escapeHtml(p.provider)}</td>
<td>${escapeHtml(p.status)}</td>
<td>${escapeHtml(p.transaction_id || "")}</td>
</tr>`).join("")}
</table>` : `<p class="muted">No payments yet.</p>`}
</div>
</div>`;

    res.send(page(req, "Admin Dashboard", body));
});

// ===============================
// MULTER UPLOAD
// ===============================

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, file.fieldname === "poster" ? POSTER_DIR : VIDEO_DIR);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, Date.now() + "-" + crypto.randomBytes(6).toString("hex") + ext);
    }
});

const upload = multer({
    storage,
    limits: {
        fileSize: 2 * 1024 * 1024 * 1024
    },
    fileFilter: (req, file, cb) => {
        if (file.fieldname === "video") {
            const allowed = [".mp4", ".webm", ".mov", ".m4v"];
            if (!allowed.includes(path.extname(file.originalname).toLowerCase())) {
                return cb(new Error("Unsupported video format."));
            }
        }

        if (file.fieldname === "poster") {
            const allowed = [".jpg", ".jpeg", ".png", ".webp"];
            if (!allowed.includes(path.extname(file.originalname).toLowerCase())) {
                return cb(new Error("Unsupported poster format."));
            }
        }

        cb(null, true);
    }
}).fields([
    { name: "video", maxCount: 1 },
    { name: "poster", maxCount: 1 }
]);

// ===============================
// ADMIN UPLOAD
// ===============================

app.post("/api/admin/upload", requireAdmin, (req, res) => {
    upload(req, res, err => {
        if (err) {
            console.error(err);
            return res.status(400).send("Upload failed: " + escapeHtml(err.message));
        }

        try {
            if (!req.files || !req.files.video || !req.files.video[0]) {
                return res.status(400).send("Movie video is required.");
            }

            const title = String(req.body.title || "").trim();
            const description = String(req.body.description || "").trim();
            const categoryId = req.body.category_id ? Number(req.body.category_id) : null;
            const year = req.body.year ? Number(req.body.year) : null;
            const duration = String(req.body.duration || "").trim();

            if (!title) return res.status(400).send("Movie title is required.");

            const videoFilename = req.files.video[0].filename;
            const posterFilename = req.files.poster && req.files.poster[0]
                ? req.files.poster[0].filename
                : null;

            db.prepare(`
                INSERT INTO movies
                (title, description, filename, poster, category_id, year, duration)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(
                title,
                description,
                videoFilename,
                posterFilename,
                categoryId || null,
                year || null,
                duration
            );

            res.redirect("/admin/dashboard");
        } catch (error) {
            console.error(error);
            res.status(500).send("Movie upload failed.");
        }
    });
});

// ===============================
// ADMIN DELETE MOVIE
// ===============================

app.post("/api/admin/delete-movie", requireAdmin, (req, res) => {
    const id = Number(req.body.id);

    const movie = db.prepare("SELECT * FROM movies WHERE id = ?").get(id);

    if (!movie) return res.status(404).send("Movie not found.");

    const videoPath = path.join(VIDEO_DIR, path.basename(movie.filename));
    const posterPath = movie.poster
        ? path.join(POSTER_DIR, path.basename(movie.poster))
        : null;

    db.prepare("DELETE FROM movies WHERE id = ?").run(id);

    try {
        if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
        if (posterPath && fs.existsSync(posterPath)) fs.unlinkSync(posterPath);
    } catch (error) {
        console.error("File cleanup error:", error);
    }

    res.redirect("/admin/dashboard");
});

// ===============================
// ERROR HANDLER
// ===============================

app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).send("Server error.");
});

// ===============================
// START
// ===============================

app.listen(PORT, () => {
    console.log("");
    console.log("================================");
    console.log("       MyStream is running");
    console.log("================================");
    console.log("");
    console.log(`Website: http://localhost:${PORT}`);
    console.log(`Admin:   http://localhost:${PORT}/admin`);
    console.log("");
    console.log("Admin username: admin");
    console.log("Admin password: admin123");
    console.log("");
    console.log("Pesapal payments: " + (process.env.PESAPAL_CONSUMER_KEY && process.env.PESAPAL_CONSUMER_SECRET ? "credentials configured" : "NOT CONFIGURED"));
    console.log("Pesapal IPN: " + (getSetting("pesapal_ipn_id") || process.env.PESAPAL_IPN_ID ? "registered/configured" : "NOT REGISTERED"));
    console.log("Local test subscriptions are enabled unless NODE_ENV=production.");
    console.log("");
});
