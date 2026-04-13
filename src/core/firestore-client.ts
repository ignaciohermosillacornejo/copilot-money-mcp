/**
 * Firestore REST API client for document writes.
 *
 * Thin wrapper around the Firestore REST API using native fetch.
 * Uses PATCH with updateMask for partial document updates and
 * POST for creating new documents with client-specified IDs.
 *
 * @see https://firebase.google.com/docs/firestore/reference/rest/v1/projects.databases.documents/patch
 * @see https://firebase.google.com/docs/firestore/reference/rest/v1/projects.databases.documents/createDocument
 */

import type { FirebaseAuth } from './auth/firebase-auth.js';
import type { FirestoreFields, FirestoreRestValue } from './format/firestore-rest.js';

const FIRESTORE_PROJECT_ID = 'copilot-production-22904';
const FIRESTORE_BASE_URL = 'https://firestore.googleapis.com/v1';

export class FirestoreClient {
  constructor(private auth: FirebaseAuth) {}

  /**
   * Return the authenticated user's Firebase UID (available after first token exchange).
   */
  getUserId(): string | null {
    return this.auth.getUserId();
  }

  /**
   * Return the authenticated user's Firebase UID, triggering a token exchange if needed.
   *
   * Throws if the user ID is unavailable even after authentication.
   */
  async requireUserId(): Promise<string> {
    // Ensure at least one token exchange has occurred so userId is populated
    await this.auth.getIdToken();
    const uid = this.auth.getUserId();
    if (!uid) {
      throw new Error('Firebase user ID unavailable after authentication');
    }
    return uid;
  }

  async updateDocument(
    collectionPath: string,
    documentId: string,
    fields: FirestoreFields,
    updateMask: string[]
  ): Promise<void> {
    const idToken = await this.auth.getIdToken();
    const docPath = `projects/${FIRESTORE_PROJECT_ID}/databases/(default)/documents/${collectionPath}/${documentId}`;
    const url = new URL(`${FIRESTORE_BASE_URL}/${docPath}`);
    for (const field of updateMask) {
      url.searchParams.append('updateMask.fieldPaths', field);
    }

    const response = await fetch(url.toString(), {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${idToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ fields }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Firestore update failed (${response.status}): ${errorBody}`);
    }
  }

  /**
   * Create a new document in a Firestore collection.
   *
   * Uses the Firestore REST API createDocument endpoint with a client-supplied
   * document ID.
   *
   * @see https://firebase.google.com/docs/firestore/reference/rest/v1/projects.databases.documents/createDocument
   */
  /**
   * Read a single document from Firestore.
   *
   * @see https://firebase.google.com/docs/firestore/reference/rest/v1/projects.databases.documents/get
   */
  async getDocument(
    collectionPath: string,
    documentId: string
  ): Promise<Record<string, FirestoreRestValue>> {
    const idToken = await this.auth.getIdToken();
    const docPath = `projects/${FIRESTORE_PROJECT_ID}/databases/(default)/documents/${collectionPath}/${documentId}`;

    const response = await fetch(`${FIRESTORE_BASE_URL}/${docPath}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${idToken}`,
      },
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Firestore get failed (${response.status}): ${errorBody}`);
    }

    const doc = (await response.json()) as { fields?: Record<string, FirestoreRestValue> };
    return doc.fields ?? {};
  }

  async createDocument(
    collectionPath: string,
    documentId: string | undefined,
    fields: FirestoreFields
  ): Promise<string> {
    const idToken = await this.auth.getIdToken();
    const parentPath = `projects/${FIRESTORE_PROJECT_ID}/databases/(default)/documents`;
    const url = new URL(`${FIRESTORE_BASE_URL}/${parentPath}/${collectionPath}`);
    if (documentId) {
      url.searchParams.set('documentId', documentId);
    }

    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${idToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ fields }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Firestore create failed (${response.status}): ${errorBody}`);
    }

    const doc = (await response.json()) as { name: string };
    // Extract document ID from the full resource name
    // e.g. "projects/.../documents/users/uid/categories/abc123" → "abc123"
    return doc.name.split('/').pop()!;
  }

  /**
   * Delete a document from Firestore.
   *
   * @see https://firebase.google.com/docs/firestore/reference/rest/v1/projects.databases.documents/delete
   */
  async deleteDocument(collectionPath: string, documentId: string): Promise<void> {
    const idToken = await this.auth.getIdToken();
    const docPath = `projects/${FIRESTORE_PROJECT_ID}/databases/(default)/documents/${collectionPath}/${documentId}`;

    const response = await fetch(`${FIRESTORE_BASE_URL}/${docPath}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${idToken}`,
      },
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Firestore delete failed (${response.status}): ${errorBody}`);
    }
  }
}
