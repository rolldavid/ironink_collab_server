import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import { URL } from 'url';
import jwt from 'jsonwebtoken';
import * as Y from 'yjs';
import { setupWSConnection, docs } from './y-websocket-utils.js';
import 'dotenv/config';

const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.COLLAB_JWT_SECRET || 'dev-secret-change-in-production';

interface CollabToken {
  userId: string;
  bookId: string;
  chapterId: string;
  role: 'view_only' | 'suggesting' | 'editor';
  displayName: string;
  color: string;
  exp: number;
}

interface AuthenticatedWebSocket extends WebSocket {
  userId?: string;
  bookId?: string;
  chapterId?: string;
  role?: string;
  displayName?: string;
  color?: string;
  isAlive?: boolean;
}

// Store active connections per room
const roomConnections = new Map<string, Set<AuthenticatedWebSocket>>();

// Verify JWT token
function verifyToken(token: string): CollabToken | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as CollabToken;
    return decoded;
  } catch (err) {
    console.error('Token verification failed:', err);
    return null;
  }
}

// Create HTTP server
const server = http.createServer((req, res) => {
  // Health check endpoint
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', connections: roomConnections.size }));
    return;
  }

  res.writeHead(404);
  res.end();
});

// Create WebSocket server
const wss = new WebSocketServer({ server });

wss.on('connection', (ws: AuthenticatedWebSocket, req) => {
  // Parse URL and get token
  const url = new URL(req.url || '', `http://${req.headers.host}`);
  const token = url.searchParams.get('token');
  const roomName = url.searchParams.get('room'); // Format: {bookId}:{chapterId}

  if (!token || !roomName) {
    console.log('Connection rejected: missing token or room');
    ws.close(4001, 'Missing token or room');
    return;
  }

  // Verify token
  const tokenData = verifyToken(token);
  if (!tokenData) {
    console.log('Connection rejected: invalid token');
    ws.close(4002, 'Invalid token');
    return;
  }

  // Verify room matches token
  const expectedRoom = `${tokenData.bookId}:${tokenData.chapterId}`;
  if (roomName !== expectedRoom) {
    console.log('Connection rejected: room mismatch');
    ws.close(4003, 'Room mismatch');
    return;
  }

  // Attach user info to socket
  ws.userId = tokenData.userId;
  ws.bookId = tokenData.bookId;
  ws.chapterId = tokenData.chapterId;
  ws.role = tokenData.role;
  ws.displayName = tokenData.displayName;
  ws.color = tokenData.color;
  ws.isAlive = true;

  console.log(`User ${tokenData.displayName} connected to room ${roomName} as ${tokenData.role}`);

  // Track connection
  if (!roomConnections.has(roomName)) {
    roomConnections.set(roomName, new Set());
  }
  roomConnections.get(roomName)!.add(ws);

  // Set up y-websocket connection
  // For view_only users, we'll handle read-only mode in the awareness
  setupWSConnection(ws, req, {
    docName: roomName,
    gc: true, // Enable garbage collection
  });

  // Handle pong for keepalive
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  // Handle close
  ws.on('close', () => {
    console.log(`User ${tokenData.displayName} disconnected from room ${roomName}`);
    const connections = roomConnections.get(roomName);
    if (connections) {
      connections.delete(ws);
      if (connections.size === 0) {
        roomConnections.delete(roomName);
        // Optionally persist the document state here
        // For now, docs are kept in memory by y-websocket
      }
    }
  });
});

// Keepalive ping every 30 seconds
const pingInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    const authWs = ws as AuthenticatedWebSocket;
    if (authWs.isAlive === false) {
      return ws.terminate();
    }
    authWs.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => {
  clearInterval(pingInterval);
});

// Start server
server.listen(PORT, () => {
  console.log(`Collaboration server running on port ${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  wss.close(() => {
    server.close(() => {
      process.exit(0);
    });
  });
});
