// --- Firebase Configuration ---
const firebaseConfig = {
  // IMPORTANT: Replace with your actual Firebase config values
  apiKey: "AIzaSyA8Sn1xWu628UB1MUABfvohYLzuchWVX18", // Using the key from the original script for now
  authDomain: "fearless-tools.firebaseapp.com",
  projectId: "fearless-tools",
  storageBucket: "fearless-tools.appspot.com",
  messagingSenderId: "830913150506",
  appId: "1:830913150506:web:6d6986862e404bc8ae0d53",
  measurementId: "G-6Z91GFX42Q", // Optional
};

// --- Initialize Firebase ---
let firebaseApp;
let dbInstance;
try {
  if (!firebase.apps.length) {
    firebaseApp = firebase.initializeApp(firebaseConfig);
  } else {
    firebaseApp = firebase.app();
  }
  dbInstance = firebase.firestore();
  console.log("Firebase Initialized Successfully.");
} catch (e) {
  console.error("Firebase initialization failed:", e);
  dbInstance = null;
}

// --- Firestore Constants ---
const DRAFT_TRACKER_COLLECTION = "drafts";
const DRAFT_TRACKER_DOC_ID = "current_draft";
const DRAFT_CREATOR_COLLECTION = "draftCreatorSaves";

// --- Firestore Helper Functions (Draft Tracker - MODIFIED) ---

async function fetchDraftDataFromFirestore() {
  console.log(`Fetching draft data from ${DRAFT_TRACKER_COLLECTION}/${DRAFT_TRACKER_DOC_ID}...`);
  const defaultData = {
    draftSeries: [],
    highlightedChampions: [],
    unavailablePanelState: { Top: Array(10).fill(null), Jungle: Array(10).fill(null), Mid: Array(10).fill(null), Bot: Array(10).fill(null), Support: Array(10).fill(null) },
  };
  if (!dbInstance) {
    console.error("Firestore not initialized. Returning default data.");
    return defaultData;
  }

  try {
    const docRef = dbInstance.collection(DRAFT_TRACKER_COLLECTION).doc(DRAFT_TRACKER_DOC_ID);
    const docSnap = await docRef.get();
    if (docSnap.exists) {
      const data = docSnap.data();
      // Return fetched data, falling back to defaults for each property
      return {
        draftSeries: Array.isArray(data.draftSeries) ? data.draftSeries : defaultData.draftSeries,
        highlightedChampions: Array.isArray(data.highlightedChampions) ? data.highlightedChampions : defaultData.highlightedChampions,
        unavailablePanelState: data.unavailablePanelState || defaultData.unavailablePanelState,
      };
    } else {
      console.log("No draft data found in Firestore, using defaults.");
      return defaultData;
    }
  } catch (error) {
    console.error("Error fetching draft data:", error);
    return defaultData;
  }
}

async function saveDraftDataToFirestore(draftData) {
  if (!dbInstance) {
    console.error("Firestore not initialized. Cannot save draft data.");
    return;
  }
  console.log(`Saving draft data to ${DRAFT_TRACKER_COLLECTION}/${DRAFT_TRACKER_DOC_ID}`);
  try {
    // Sanitize data before saving
    const dataToSave = {
      highlightedChampions: Array.isArray(draftData.highlightedChampions) ? draftData.highlightedChampions : [],
      draftSeries: Array.isArray(draftData.draftSeries) ? draftData.draftSeries : [],
      unavailablePanelState: draftData.unavailablePanelState || {},
    };
    await dbInstance.collection(DRAFT_TRACKER_COLLECTION).doc(DRAFT_TRACKER_DOC_ID).set(dataToSave, { merge: true });
    console.log("Draft data saved successfully.");
  } catch (error) {
    console.error("Error saving draft data:", error);
  }
}

// --- Firestore Helper Functions (Draft Creator - Unchanged) ---
async function saveDraftToCreatorCollection(draftObject) {
  if (!dbInstance) {
    throw new Error("Firestore not initialized. Cannot save draft.");
  }
  const collectionRef = dbInstance.collection(DRAFT_CREATOR_COLLECTION);
  const dataToSave = {
    ...draftObject,
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    name: draftObject.name || "Unnamed Draft",
  };
  delete dataToSave.id;
  try {
    let docRef;
    if (draftObject.id) {
      docRef = collectionRef.doc(draftObject.id);
      await docRef.set(dataToSave, { merge: true });
    } else {
      docRef = await collectionRef.add(dataToSave);
    }
    const savedDoc = await docRef.get();
    return { id: docRef.id, ...savedDoc.data() };
  } catch (error) {
    console.error("Error saving draft to creator collection:", error);
    throw error;
  }
}
async function fetchSavedDraftsFromFirestore() {
  if (!dbInstance) {
    console.error("Firestore not initialized. Cannot fetch saved drafts.");
    return [];
  }
  const drafts = [];
  try {
    const querySnapshot = await dbInstance.collection(DRAFT_CREATOR_COLLECTION).orderBy("createdAt", "desc").get();
    querySnapshot.forEach((doc) => {
      drafts.push({ id: doc.id, ...doc.data() });
    });
    return drafts;
  } catch (error) {
    console.error("Error fetching saved drafts:", error);
    return [];
  }
}
async function loadSpecificDraftFromFirestore(draftId) {
  if (!dbInstance) {
    console.error("Firestore not initialized. Cannot load draft.");
    return null;
  }
  if (!draftId) {
    console.error("No draft ID provided to load.");
    return null;
  }
  try {
    const docRef = dbInstance.collection(DRAFT_CREATOR_COLLECTION).doc(draftId);
    const docSnap = await docRef.get();
    if (docSnap.exists) {
      return docSnap.data();
    } else {
      return null;
    }
  } catch (error) {
    console.error(`Error loading draft ${draftId}:`, error);
    return null;
  }
}
async function deleteDraftFromCreatorCollection(draftId) {
  if (!dbInstance) {
    throw new Error("Firestore not initialized. Cannot delete draft.");
  }
  if (!draftId) {
    throw new Error("No draft ID provided to delete.");
  }
  try {
    const docRef = dbInstance.collection(DRAFT_CREATOR_COLLECTION).doc(draftId);
    await docRef.delete();
  } catch (error) {
    console.error(`Error deleting draft ${draftId}:`, error);
    throw error;
  }
}

// --- Make db instance and ALL helper functions globally available ---
window.db = dbInstance;
window.fetchDraftDataFromFirestore = fetchDraftDataFromFirestore;
window.saveDraftDataToFirestore = saveDraftDataToFirestore;
window.saveDraftToCreatorCollection = saveDraftToCreatorCollection;
window.fetchSavedDraftsFromFirestore = fetchSavedDraftsFromFirestore;
window.loadSpecificDraftFromFirestore = loadSpecificDraftFromFirestore;
window.deleteDraftFromCreatorCollection = deleteDraftFromCreatorCollection;
