const { Server } = require('socket.io');

let io = null;

function init(httpServer, corsOrigins) {
  io = new Server(httpServer, {
    cors: {
      origin: corsOrigins,
      methods: ['GET', 'POST'],
      credentials: true,
    },
    // Long polling fallback for environments that block WebSocket
    transports: ['websocket', 'polling'],
  });

  io.on('connection', (socket) => {
    console.log('[socket] Client connected:', socket.id);
    socket.on('disconnect', (reason) => {
      console.log('[socket] Client disconnected:', socket.id, reason);
    });
  });

  return io;
}

// Broadcast a data sync event to ALL connected clients
function sync(resource, action, data) {
  if (!io) return;
  io.emit('sync:' + resource, { action, data });
}

// Broadcast a notification to all admin clients
function notify(notification) {
  if (!io) return;
  io.emit('notification:new', notification);
}

module.exports = { init, sync, notify };
