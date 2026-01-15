/**
 * R2 Persistence for Yjs Documents
 *
 * This module handles persisting encrypted Yjs document state to Cloudflare R2.
 * The server stores encrypted blobs without being able to decrypt them.
 *
 * Key Features:
 * - Debounced saves (2 second delay)
 * - Encrypted state stored as-is (zero-knowledge)
 * - Load on room creation
 * - Automatic cleanup of old state
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import * as Y from 'yjs';

// R2 Configuration
const getS3Client = (): S3Client | null => {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

  if (!accountId || !accessKeyId || !secretAccessKey) {
    console.warn('[Persistence] R2 not configured - state will not be persisted');
    return null;
  }

  return new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });
};

const BUCKET_NAME = process.env.R2_BUCKET_NAME || 'write';

// Debounce timers for saves
const saveTimers = new Map<string, NodeJS.Timeout>();
const SAVE_DEBOUNCE_MS = 2000;

/**
 * Get the R2 key for a room's state
 */
function getStateKey(roomId: string): string {
  // roomId format: bookId:chapterId
  const [bookId, chapterId] = roomId.split(':');
  return `collab/${bookId}/${chapterId}/state.yjs`;
}

/**
 * Store Yjs document state to R2
 * This stores the ENCRYPTED state as received from clients
 *
 * @param roomId - The room ID (format: bookId:chapterId)
 * @param state - The encoded Yjs state (encrypted)
 */
export async function persistState(roomId: string, state: Uint8Array): Promise<void> {
  const s3 = getS3Client();
  if (!s3) return;

  const key = getStateKey(roomId);

  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key,
        Body: state,
        ContentType: 'application/octet-stream',
      })
    );
    console.log(`[Persistence] Saved state for room ${roomId} (${state.length} bytes)`);
  } catch (error) {
    console.error(`[Persistence] Failed to save state for room ${roomId}:`, error);
  }
}

/**
 * Load Yjs document state from R2
 *
 * @param roomId - The room ID (format: bookId:chapterId)
 * @returns The stored state, or null if not found
 */
export async function loadState(roomId: string): Promise<Uint8Array | null> {
  const s3 = getS3Client();
  if (!s3) return null;

  const key = getStateKey(roomId);

  try {
    const response = await s3.send(
      new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key,
      })
    );

    if (response.Body) {
      const bytes = await response.Body.transformToByteArray();
      console.log(`[Persistence] Loaded state for room ${roomId} (${bytes.length} bytes)`);
      return new Uint8Array(bytes);
    }
  } catch (error: unknown) {
    // NoSuchKey is expected for new rooms
    if ((error as { name?: string }).name === 'NoSuchKey') {
      console.log(`[Persistence] No existing state for room ${roomId}`);
    } else {
      console.error(`[Persistence] Failed to load state for room ${roomId}:`, error);
    }
  }

  return null;
}

/**
 * Delete stored state for a room
 *
 * @param roomId - The room ID (format: bookId:chapterId)
 */
export async function deleteState(roomId: string): Promise<void> {
  const s3 = getS3Client();
  if (!s3) return;

  const key = getStateKey(roomId);

  try {
    await s3.send(
      new DeleteObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key,
      })
    );
    console.log(`[Persistence] Deleted state for room ${roomId}`);
  } catch (error) {
    console.error(`[Persistence] Failed to delete state for room ${roomId}:`, error);
  }
}

/**
 * Schedule a debounced save for a room
 * Cancels any pending save and schedules a new one
 *
 * @param roomId - The room ID
 * @param getState - Function that returns the current state to save
 */
export function scheduleSave(roomId: string, getState: () => Uint8Array): void {
  // Cancel existing timer
  const existingTimer = saveTimers.get(roomId);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  // Schedule new save
  const timer = setTimeout(async () => {
    saveTimers.delete(roomId);
    const state = getState();
    if (state.length > 0) {
      await persistState(roomId, state);
    }
  }, SAVE_DEBOUNCE_MS);

  saveTimers.set(roomId, timer);
}

/**
 * Cancel any pending save for a room
 *
 * @param roomId - The room ID
 */
export function cancelPendingSave(roomId: string): void {
  const timer = saveTimers.get(roomId);
  if (timer) {
    clearTimeout(timer);
    saveTimers.delete(roomId);
  }
}

/**
 * Force immediate save for a room (e.g., on shutdown)
 *
 * @param roomId - The room ID
 * @param getState - Function that returns the current state to save
 */
export async function forceSave(roomId: string, getState: () => Uint8Array): Promise<void> {
  cancelPendingSave(roomId);
  const state = getState();
  if (state.length > 0) {
    await persistState(roomId, state);
  }
}

/**
 * Save all pending documents (for graceful shutdown)
 *
 * @param docs - Map of room ID to state getter functions
 */
export async function saveAllPending(
  docs: Map<string, () => Uint8Array>
): Promise<void> {
  const promises: Promise<void>[] = [];

  for (const [roomId, getState] of docs) {
    cancelPendingSave(roomId);
    promises.push(persistState(roomId, getState()));
  }

  await Promise.all(promises);
  console.log(`[Persistence] Saved ${promises.length} documents on shutdown`);
}

/**
 * Check if R2 persistence is available
 */
export function isPersistenceAvailable(): boolean {
  return getS3Client() !== null;
}
