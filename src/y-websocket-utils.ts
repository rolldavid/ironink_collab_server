/**
 * Y-WebSocket utilities for handling Yjs document synchronization
 * Based on y-websocket server implementation
 *
 * Supports both plaintext (legacy) and E2E encrypted messages.
 * For encrypted messages, the server acts as a zero-knowledge relay.
 */

import { WebSocket } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import http from 'http';
import { scheduleSave, loadState, forceSave } from './persistence.js';

const wsReadyStateConnecting = 0;
const wsReadyStateOpen = 1;

// Message types (legacy y-protocols)
const messageSync = 0;
const messageAwareness = 1;

// Encrypted message version bytes (E2E encrypted)
const ENCRYPTED_SYNC_VERSION = 0x01;
const ENCRYPTED_AWARENESS_VERSION = 0x02;
const ENCRYPTED_SYNC_COMPRESSED_VERSION = 0x03;

/**
 * Check if a message is encrypted (by version byte)
 */
function isEncryptedMessage(message: Uint8Array): boolean {
  if (message.length === 0) return false;
  const version = message[0];
  return (
    version === ENCRYPTED_SYNC_VERSION ||
    version === ENCRYPTED_AWARENESS_VERSION ||
    version === ENCRYPTED_SYNC_COMPRESSED_VERSION
  );
}

/**
 * Check if an encrypted message is a sync message (vs awareness)
 */
function isEncryptedSyncMessage(message: Uint8Array): boolean {
  return message.length > 0 && (
    message[0] === ENCRYPTED_SYNC_VERSION ||
    message[0] === ENCRYPTED_SYNC_COMPRESSED_VERSION
  );
}

// Store for Yjs documents
export const docs = new Map<string, WSSharedDoc>();

interface WSSharedDoc extends Y.Doc {
  name: string;
  conns: Map<WebSocket, Set<number>>;
  awareness: awarenessProtocol.Awareness;
  // For E2E encrypted mode: store the latest encrypted state blob
  encryptedState: Uint8Array | null;
  // Track if this doc uses encrypted mode
  isEncrypted: boolean;
}

const updateHandler = (update: Uint8Array, origin: unknown, doc: Y.Doc) => {
  const wsDoc = doc as WSSharedDoc;
  console.log(`[Sync] Document "${wsDoc.name}" updated, broadcasting to ${wsDoc.conns.size} connections`);
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, messageSync);
  syncProtocol.writeUpdate(encoder, update);
  const message = encoding.toUint8Array(encoder);
  wsDoc.conns.forEach((_, conn) => send(wsDoc, conn, message));
};

class WSSharedDocImpl extends Y.Doc implements WSSharedDoc {
  name: string;
  conns: Map<WebSocket, Set<number>>;
  awareness: awarenessProtocol.Awareness;
  encryptedState: Uint8Array | null;
  isEncrypted: boolean;

  constructor(name: string) {
    super({ gc: true });
    this.name = name;
    this.conns = new Map();
    this.awareness = new awarenessProtocol.Awareness(this);
    this.awareness.setLocalState(null);
    this.encryptedState = null;
    this.isEncrypted = false;

    const awarenessChangeHandler = (
      { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
      conn: WebSocket | null
    ) => {
      const changedClients = added.concat(updated, removed);
      if (conn !== null) {
        const connControlledIDs = this.conns.get(conn);
        if (connControlledIDs !== undefined) {
          added.forEach((clientID) => connControlledIDs.add(clientID));
          removed.forEach((clientID) => connControlledIDs.delete(clientID));
        }
      }
      // Broadcast awareness update
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageAwareness);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients)
      );
      const buff = encoding.toUint8Array(encoder);
      this.conns.forEach((_, c) => send(this, c, buff));
    };

    this.awareness.on('update', awarenessChangeHandler);
    this.on('update', updateHandler);
  }
}

const getYDoc = (docname: string, gc: boolean = true): WSSharedDoc => {
  let doc = docs.get(docname);
  if (doc === undefined) {
    doc = new WSSharedDocImpl(docname);
    doc.gc = gc;
    docs.set(docname, doc);
  }
  return doc;
};

/**
 * Broadcast an encrypted message to all connections except sender
 */
const broadcastEncryptedMessage = (doc: WSSharedDoc, sender: WebSocket, message: Uint8Array) => {
  doc.conns.forEach((_, conn) => {
    if (conn !== sender) {
      send(doc, conn, message);
    }
  });
};

const messageListener = (conn: WebSocket, doc: WSSharedDoc, message: Uint8Array) => {
  try {
    // Check if this is an encrypted message
    if (isEncryptedMessage(message)) {
      // Mark document as encrypted
      doc.isEncrypted = true;

      // Encrypted message - relay without decryption (zero-knowledge)
      if (isEncryptedSyncMessage(message)) {
        console.log(`[Encrypted] Sync message received for doc "${doc.name}", relaying to ${doc.conns.size - 1} peers`);

        // Store the encrypted state for persistence and new connections
        doc.encryptedState = message;

        // Schedule persistence save
        scheduleSave(doc.name, () => doc.encryptedState || new Uint8Array(0));

        // Broadcast to all other connections
        broadcastEncryptedMessage(doc, conn, message);
      } else {
        // Encrypted awareness message
        console.log(`[Encrypted] Awareness message received for doc "${doc.name}", relaying`);

        // Broadcast awareness to all other connections
        broadcastEncryptedMessage(doc, conn, message);
      }
      return;
    }

    // Legacy unencrypted message handling (for backward compatibility)
    const encoder = encoding.createEncoder();
    const decoder = decoding.createDecoder(message);
    const messageType = decoding.readVarUint(decoder);

    switch (messageType) {
      case messageSync:
        const syncMessageType = decoding.peekVarUint(decoder);
        console.log(`[Message] Sync message received for doc "${doc.name}", sync type: ${syncMessageType}`);
        // Sync message types: 0 = step1, 1 = step2, 2 = update
        if (syncMessageType === 2) {
          console.log(`[Message] This is an UPDATE message - should trigger broadcast`);
        }
        encoding.writeVarUint(encoder, messageSync);
        const beforeSize = doc.getMap('notes').size;
        syncProtocol.readSyncMessage(decoder, encoder, doc, conn);
        const afterSize = doc.getMap('notes').size;
        if (beforeSize !== afterSize) {
          console.log(`[Message] Notes map changed: ${beforeSize} -> ${afterSize}`);
        }

        // Reply if encoder has content
        if (encoding.length(encoder) > 1) {
          send(doc, conn, encoding.toUint8Array(encoder));
        }
        break;
      case messageAwareness: {
        console.log(`[Message] Awareness message received for doc "${doc.name}"`);
        awarenessProtocol.applyAwarenessUpdate(
          doc.awareness,
          decoding.readVarUint8Array(decoder),
          conn
        );
        break;
      }
    }
  } catch (err) {
    console.error('[Error] Error handling message:', err);
  }
};

const closeConn = (doc: WSSharedDoc, conn: WebSocket) => {
  if (doc.conns.has(conn)) {
    const controlledIds = doc.conns.get(conn)!;
    doc.conns.delete(conn);
    awarenessProtocol.removeAwarenessStates(doc.awareness, Array.from(controlledIds), null);

    if (doc.conns.size === 0) {
      // Document has no more connections
      // Optionally persist the document here before removing
      // For now, keep it in memory for quick reconnection
      // docs.delete(doc.name);
    }
  }
  conn.close();
};

const send = (doc: WSSharedDoc, conn: WebSocket, m: Uint8Array) => {
  if (conn.readyState !== wsReadyStateConnecting && conn.readyState !== wsReadyStateOpen) {
    closeConn(doc, conn);
  }
  try {
    conn.send(m, (err) => {
      if (err) {
        closeConn(doc, conn);
      }
    });
  } catch (e) {
    closeConn(doc, conn);
  }
};

interface SetupOptions {
  docName?: string;
  gc?: boolean;
}

export const setupWSConnection = async (
  conn: WebSocket,
  req: http.IncomingMessage,
  { docName, gc = true }: SetupOptions = {}
) => {
  conn.binaryType = 'arraybuffer';

  // Get document name from options or URL
  const name = docName || req.url?.slice(1).split('?')[0] || 'default';
  const doc = getYDoc(name, gc);

  console.log(`[Setup] New connection to doc "${name}", total connections: ${doc.conns.size + 1}`);

  // If this is the first connection to the room, try to load persisted state
  if (doc.conns.size === 0 && doc.encryptedState === null) {
    try {
      const persistedState = await loadState(name);
      if (persistedState) {
        console.log(`[Setup] Loaded persisted encrypted state for doc "${name}"`);
        doc.encryptedState = persistedState;
        doc.isEncrypted = true;
      }
    } catch (err) {
      console.error(`[Setup] Failed to load persisted state for doc "${name}":`, err);
    }
  }

  // Log the current state of the Y.Doc (for legacy mode)
  if (!doc.isEncrypted) {
    const notesMap = doc.getMap('notes');
    console.log(`[Setup] Doc "${name}" has ${notesMap.size} notes in Y.Map`);
  }

  doc.conns.set(conn, new Set());

  // Listen for messages
  conn.on('message', (message: ArrayBuffer) => {
    messageListener(conn, doc, new Uint8Array(message));
  });

  // Clean up on close
  conn.on('close', () => {
    closeConn(doc, conn);
  });

  // If we have encrypted state, send it to the new connection
  if (doc.isEncrypted && doc.encryptedState) {
    console.log(`[Setup] Sending persisted encrypted state to new connection`);
    send(doc, conn, doc.encryptedState);
    return; // Skip legacy sync for encrypted docs
  }

  // Legacy mode: Send initial sync step 1
  {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageSync);
    syncProtocol.writeSyncStep1(encoder, doc);
    send(doc, conn, encoding.toUint8Array(encoder));
  }

  // Send current awareness states
  const awarenessStates = doc.awareness.getStates();
  if (awarenessStates.size > 0) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageAwareness);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(doc.awareness, Array.from(awarenessStates.keys()))
    );
    send(doc, conn, encoding.toUint8Array(encoder));
  }
};

/**
 * Get all documents for graceful shutdown persistence
 */
export const getDocsForPersistence = (): Map<string, () => Uint8Array> => {
  const result = new Map<string, () => Uint8Array>();
  docs.forEach((doc, name) => {
    if (doc.encryptedState) {
      result.set(name, () => doc.encryptedState || new Uint8Array(0));
    }
  });
  return result;
};
