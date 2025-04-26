// --- Firebase Configuration ---
const firebaseConfig = {
    // IMPORTANT: Replace with your actual Firebase config values
    apiKey: "AIzaSyA8Sn1xWu628UB1MUABfvohYLzuchWVX18", // Using the key from the original script for now
    authDomain: "fearless-tools.firebaseapp.com",
    projectId: "fearless-tools",
    storageBucket: "fearless-tools.appspot.com",
    messagingSenderId: "830913150506",
    appId: "1:830913150506:web:6d6986862e404bc8ae0d53",
    measurementId: "G-6Z91GFX42Q" // Optional
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
  const DRAFT_TRACKER_COLLECTION = "drafts"; // Existing collection for Draft Tracker
  const DRAFT_TRACKER_DOC_ID = 'current_draft'; // Existing doc ID for Draft Tracker
  const DRAFT_CREATOR_COLLECTION = "draftCreatorSaves"; // NEW collection for saved drafts

  // --- Firestore Helper Functions (Draft Tracker - Existing) ---

  // Fetches draft data for the Draft Tracker view
  async function fetchDraftDataFromFirestore() {
      console.log(`Fetching draft tracker data from ${DRAFT_TRACKER_COLLECTION}/${DRAFT_TRACKER_DOC_ID}...`);
      const defaultData = {
          draftSeries: [{ blueBans: Array(5).fill(null), bluePicks: Array(5).fill(null), redBans: Array(5).fill(null), redPicks: Array(5).fill(null) }],
          pickedChampions: []
      };
      if (!dbInstance) { console.error("Firestore not initialized. Returning default draft tracker data."); return defaultData; }

      try {
          const docRef = dbInstance.collection(DRAFT_TRACKER_COLLECTION).doc(DRAFT_TRACKER_DOC_ID);
          const docSnap = await docRef.get();
          if (docSnap.exists) {
              console.log("Draft tracker data found.");
              const data = docSnap.data();
              // Sanitize loaded data
              const draftSeries = (Array.isArray(data.draftSeries) && data.draftSeries.length > 0)
                  ? data.draftSeries.map(game => ({
                        blueBans: Array.isArray(game?.blueBans) && game.blueBans.length === 5 ? game.blueBans : Array(5).fill(null),
                        bluePicks: Array.isArray(game?.bluePicks) && game.bluePicks.length === 5 ? game.bluePicks : Array(5).fill(null),
                        redBans: Array.isArray(game?.redBans) && game.redBans.length === 5 ? game.redBans : Array(5).fill(null),
                        redPicks: Array.isArray(game?.redPicks) && game.redPicks.length === 5 ? game.redPicks : Array(5).fill(null),
                    }))
                  : defaultData.draftSeries;
              const pickedChampions = Array.isArray(data.pickedChampions) ? data.pickedChampions : defaultData.pickedChampions;
              return { draftSeries, pickedChampions };
          } else {
              console.log("No draft tracker data found in Firestore, using defaults.");
              return defaultData;
          }
      } catch (error) {
          console.error("Error fetching draft tracker data:", error);
           return defaultData;
      }
  }

  // Saves draft data for the Draft Tracker view
  async function saveDraftDataToFirestore(draftData) {
       if (!dbInstance) { console.error("Firestore not initialized. Cannot save draft tracker data."); return; }
       console.log(`Saving draft tracker data to ${DRAFT_TRACKER_COLLECTION}/${DRAFT_TRACKER_DOC_ID}:`, draftData);
       try {
           const dataToSave = {
               pickedChampions: Array.isArray(draftData.pickedChampions) ? draftData.pickedChampions : [],
               draftSeries: (Array.isArray(draftData.draftSeries) && draftData.draftSeries.length > 0)
                  ? draftData.draftSeries.map(game => ({ // Ensure structure
                        blueBans: Array.isArray(game?.blueBans) && game.blueBans.length === 5 ? game.blueBans : Array(5).fill(null),
                        bluePicks: Array.isArray(game?.bluePicks) && game.bluePicks.length === 5 ? game.bluePicks : Array(5).fill(null),
                        redBans: Array.isArray(game?.redBans) && game.redBans.length === 5 ? game.redBans : Array(5).fill(null),
                        redPicks: Array.isArray(game?.redPicks) && game.redPicks.length === 5 ? game.redPicks : Array(5).fill(null),
                    }))
                  : [{ blueBans: Array(5).fill(null), bluePicks: Array(5).fill(null), redBans: Array(5).fill(null), redPicks: Array(5).fill(null) }]
           };
           await dbInstance.collection(DRAFT_TRACKER_COLLECTION).doc(DRAFT_TRACKER_DOC_ID).set(dataToSave, { merge: true });
           console.log("Draft tracker data saved successfully.");
       } catch (error) {
           console.error("Error saving draft tracker data:", error);
       }
  }

  // --- NEW: Firestore Helper Functions (Draft Creator) ---

  /**
   * Saves a draft (new or existing) to the Draft Creator collection.
   * Handles adding a server timestamp for createdAt.
   * @param {object} draftObject - The draft object from the Alpine state. Should include name, picks, bans, notes. May or may not have an ID.
   * @returns {Promise<object>} - The saved draft object with its Firestore ID and server timestamp.
   */
  async function saveDraftToCreatorCollection(draftObject) {
      if (!dbInstance) { throw new Error("Firestore not initialized. Cannot save draft."); }

      const collectionRef = dbInstance.collection(DRAFT_CREATOR_COLLECTION);
      const dataToSave = {
          ...draftObject, // Spread the incoming data
          createdAt: firebase.firestore.FieldValue.serverTimestamp(), // Use server timestamp
          // Ensure name exists
          name: draftObject.name || "Unnamed Draft",
          // Optionally sanitize picks/bans arrays here if needed, though Alpine component should handle it
      };
      delete dataToSave.id; // Don't save the local ID field back to Firestore

      try {
          let docRef;
          if (draftObject.id) {
              // Update existing document
              docRef = collectionRef.doc(draftObject.id);
              await docRef.set(dataToSave, { merge: true }); // Use set with merge to update
              console.log("Draft updated successfully:", draftObject.id);
          } else {
              // Add new document
              docRef = await collectionRef.add(dataToSave);
              console.log("Draft added successfully with ID:", docRef.id);
          }
          // Fetch the potentially updated doc to get the server timestamp correctly
          const savedDoc = await docRef.get();
          return { id: docRef.id, ...savedDoc.data() }; // Return data with ID

      } catch (error) {
          console.error("Error saving draft to creator collection:", error);
          throw error; // Re-throw error to be caught by the caller
      }
  }

  /**
   * Fetches all saved drafts from the Draft Creator collection, ordered by creation date.
   * @returns {Promise<Array<object>>} - An array of saved draft objects, each including its Firestore ID.
   */
  async function fetchSavedDraftsFromFirestore() {
      if (!dbInstance) { console.error("Firestore not initialized. Cannot fetch saved drafts."); return []; }
      console.log(`Fetching saved drafts from ${DRAFT_CREATOR_COLLECTION}...`);
      const drafts = [];
      try {
          const querySnapshot = await dbInstance.collection(DRAFT_CREATOR_COLLECTION)
                                             .orderBy("createdAt", "desc") // Order by most recent
                                             .get();
          querySnapshot.forEach((doc) => {
              drafts.push({ id: doc.id, ...doc.data() });
          });
          console.log(`Fetched ${drafts.length} saved drafts.`);
          return drafts;
      } catch (error) {
          console.error("Error fetching saved drafts:", error);
          return []; // Return empty array on error
      }
  }

  /**
   * Loads a specific draft document by its ID from the Draft Creator collection.
   * @param {string} draftId - The Firestore document ID of the draft to load.
   * @returns {Promise<object|null>} - The draft data object (without ID) or null if not found or on error.
   */
  async function loadSpecificDraftFromFirestore(draftId) {
       if (!dbInstance) { console.error("Firestore not initialized. Cannot load draft."); return null; }
       if (!draftId) { console.error("No draft ID provided to load."); return null; }
       console.log(`Loading draft ${draftId} from ${DRAFT_CREATOR_COLLECTION}...`);
       try {
           const docRef = dbInstance.collection(DRAFT_CREATOR_COLLECTION).doc(draftId);
           const docSnap = await docRef.get();
           if (docSnap.exists) {
               console.log("Draft loaded successfully.");
               return docSnap.data(); // Return only the data part
           } else {
               console.warn("Draft document not found:", draftId);
               return null;
           }
       } catch (error) {
           console.error(`Error loading draft ${draftId}:`, error);
           return null; // Return null on error
       }
  }

  /**
   * Deletes a specific draft document by its ID from the Draft Creator collection.
   * @param {string} draftId - The Firestore document ID of the draft to delete.
   * @returns {Promise<void>}
   */
  async function deleteDraftFromCreatorCollection(draftId) {
      if (!dbInstance) { throw new Error("Firestore not initialized. Cannot delete draft."); }
      if (!draftId) { throw new Error("No draft ID provided to delete."); }
      console.log(`Deleting draft ${draftId} from ${DRAFT_CREATOR_COLLECTION}...`);
      try {
          const docRef = dbInstance.collection(DRAFT_CREATOR_COLLECTION).doc(draftId);
          await docRef.delete();
          console.log("Draft deleted successfully:", draftId);
      } catch (error) {
          console.error(`Error deleting draft ${draftId}:`, error);
          throw error; // Re-throw error
      }
  }


  // --- Make db instance and ALL helper functions globally available ---
  window.db = dbInstance;
  // Draft Tracker functions
  window.fetchDraftDataFromFirestore = fetchDraftDataFromFirestore;
  window.saveDraftDataToFirestore = saveDraftDataToFirestore;
  // Draft Creator functions
  window.saveDraftToCreatorCollection = saveDraftToCreatorCollection;
  window.fetchSavedDraftsFromFirestore = fetchSavedDraftsFromFirestore;
  window.loadSpecificDraftFromFirestore = loadSpecificDraftFromFirestore;
  window.deleteDraftFromCreatorCollection = deleteDraftFromCreatorCollection;
