const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const nfcRoutes = require('./src/routes/nfc');
const authRoutes = require('./src/routes/auth');

const app = express();
const PORT = process.env.PORT || 3000;

// MongoDB connection
const connectDB = async () => {
  if (!process.env.MONGO_URI) {
    console.log(' MONGO_URI not set - NFC verification disabled');
    return;
  }
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log(' MongoDB Connected');
  } catch (err) {
    console.error('MongoDB connection error:', err.message);
    process.exit(1);
  }
};
connectDB();

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/nfc', nfcRoutes);
app.use('/api/auth', authRoutes);

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Tyme Boxed API',
    health: '/health',
    ping: '/api/ping',
    api: '/api/nfc/verify'
  });
});
app.get('/api', (req, res) => {
  res.json({
    status: "ok",
    message: "Tyme Boxed API root"
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Tyme Boxed API is running' });
});

// Lightweight keepalive endpoint - ideal for Render free tier (avoids 50s cold starts)
// Use UptimeRobot or Cron-job.org to hit this every 10-14 minutes
app.get('/api/ping', (req, res) => {
  res.status(204).end();
});

// Start server
app.listen(PORT, () => {
  console.log(`\n Tyme Boxed API Server running on port ${PORT}`);
  console.log(`\n\ Server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`NFC Verify: POST http://localhost:${PORT}/api/nfc/verify (no auth required)\n`);
});