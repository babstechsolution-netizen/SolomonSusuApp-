const http = require('http');
const express = require('express');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const connectDB = require('./db/mongoose');
const { PORT, FRONTEND_URL, NODE_ENV } = require('./config/env');

const authRoutes = require('./routes/authRoutes');
const employeeRoutes = require('./routes/employeeRoutes');
const customerRoutes = require('./routes/customerRoutes');
const transactionRoutes = require('./routes/transactionRoutes');
const loanRoutes = require('./routes/loanRoutes');
const dashboardRoutes = require('./routes/dashboardRoutes');
const adminRoutes = require('./routes/adminRoutes');
const activityRoutes = require('./routes/activityRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const cashHandoverRoutes = require('./routes/cashHandoverRoutes');
const { startBackupScheduler } = require('./scheduler');
const socketModule = require('./socket');

const app = express();
const server = http.createServer(app);

const corsOrigins = FRONTEND_URL === '*' ? '*' : FRONTEND_URL.split(',').map(u => u.trim());

// Init socket.io — must happen before routes load so they can require('./socket')
socketModule.init(server, corsOrigins);

// Connect to MongoDB then start scheduler
connectDB().then(() => startBackupScheduler().catch(() => {}));

// Middleware
app.use(cors({
  origin: corsOrigins,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve frontend — the redesigned mobile app is the default; classic web app at /web
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '../public/app.html')));
app.get(['/web', '/classic'], (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));
// Digital Asset Links — verifies the Android app (TWA) so it opens full-screen without a URL bar
app.get('/.well-known/assetlinks.json', (req, res) => {
  res.type('application/json');
  res.sendFile(path.join(__dirname, '../public/.well-known/assetlinks.json'));
});
app.use(express.static(path.join(__dirname, '../public'), { index: false }));

// Health check
app.get('/health', (req, res) => {
  const dbState = ['disconnected', 'connected', 'connecting', 'disconnecting'];
  res.json({ status: 'ok', uptime: process.uptime(), db: dbState[mongoose.connection.readyState] || 'unknown' });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/employees', employeeRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/loans', loanRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/activity', activityRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/cash-handovers', cashHandoverRoutes);

// API 404
app.use('/api', (req, res) => {
  res.status(404).json({ success: false, message: `Route ${req.originalUrl} not found.` });
});

// SPA fallback → redesigned mobile app (the new default)
app.use((req, res) => {
  res.sendFile(path.join(__dirname, '../public/app.html'));
});

// Global error handler — catches anything thrown/rejected in route handlers above
app.use((err, req, res, _next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({ success: false, message: err.message || 'Internal server error.' });
});

server.listen(PORT, () => {
  console.log(`Awinbire Enterprise API running on port ${PORT} [${NODE_ENV}]`);
});

module.exports = app;
