const express = require('express');
const cors = require('cors');
const connectDB = require('./db/mongoose');
const { PORT, FRONTEND_URL, NODE_ENV } = require('./config/env');

const authRoutes = require('./routes/authRoutes');
const employeeRoutes = require('./routes/employeeRoutes');
const customerRoutes = require('./routes/customerRoutes');
const transactionRoutes = require('./routes/transactionRoutes');
const loanRoutes = require('./routes/loanRoutes');
const dashboardRoutes = require('./routes/dashboardRoutes');

const app = express();

// Connect to MongoDB
connectDB();

// Middleware
app.use(cors({
  origin: FRONTEND_URL === '*' ? '*' : FRONTEND_URL.split(',').map(u => u.trim()),
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Health check
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'Awinbire Enterprise API is running',
    version: '1.0.0',
    environment: NODE_ENV,
  });
});

app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/employees', employeeRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/loans', loanRoutes);
app.use('/api/dashboard', dashboardRoutes);

// 404
app.use((req, res) => {
  res.status(404).json({ success: false, message: `Route ${req.originalUrl} not found.` });
});

// Global error handler
app.use((err, req, res, _next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({ success: false, message: err.message || 'Internal server error.' });
});

app.listen(PORT, () => {
  console.log(`Awinbire Enterprise API running on port ${PORT} [${NODE_ENV}]`);
});

module.exports = app;
