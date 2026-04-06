/**
 * Firestore REST API client for document writes.
 *
 * Thin wrapper around the Firestore REST API using native fetch.
 * Uses PATCH with updateMask for partial document updates.
 *
 * @see https://firebase.google.com/docs/firestore/reference/rest/v1/projects.databases.documents/patch
 */

import type { FirebaseAuth } from './auth/firebase-auth.js';
import type { FirestoreFields } from './format/firestore-rest.js';

const FIRESTORE_PROJECT_ID = 'copilot-production-22904';
const FIRESTORE_BASE_URL = 'https://firestore.googleapis.com/v1';

export class FirestoreClient {
  constructor(private auth: FirebaseAuth) {}

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
}
