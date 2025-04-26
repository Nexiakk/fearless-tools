// Make the main Alpine component function globally available
// so x-data="draftHelper()" in index.html can find it.
window.draftHelper = function() {
    return {
        // --- State ---
        allChampions: [], // Holds data from champions.js (e.g., name, roles, imageName)
        teamPool: {}, // Holds data from champions.js (teamTierList)
        pickedChampions: [], // Manually highlighted champions (synced with Firestore)
        currentFilter: 'all', // 'all', 'pool', or player role (e.g., 'Top') (Champion Pool View)
        roleFilter: 'all', // 'all' or specific role (e.g., 'Jungle') (Champion Pool View)
        searchTerm: '', // Input for champion search (Champion Pool View)
        sortOrder: 'name', // 'name' or 'tier' (Champion Pool View)
        currentView: 'pool', // Start on Draft Creator view
        draftSeries: [ // Array of draft games (synced with Firestore) (Draft Tracker View)
            { blueBans: Array(5).fill(null), bluePicks: Array(5).fill(null), redBans: Array(5).fill(null), redPicks: Array(5).fill(null) }
        ],
        isLoading: true, // Flag for initial data loading
        _saveTimeout: null, // Timeout ID for debounced Firestore save (Draft Tracker)
        _unsubscribeFirestore: null, // Function to detach Firestore listener (Draft Tracker)
        _defaultPoolInfo: { isInPool: false, tier: null, players: [], tierClass: 'tier-DEFAULT' }, // Default structure for pool info
        _tierOrderValue: { 'S': 5, 'A': 4, 'B': 3, 'C': 2, 'DEFAULT': 0 }, // Numerical value for tier sorting
        _validRoles: new Set(['Top', 'Jungle', 'Mid', 'Bot', 'Support']), // Set of valid player/filter roles

        // Modal State (Mainly for Draft Tracker, Confirmation used globally)
        modalType: 'closed', // 'closed', 'championSelect', 'confirm'
        modalTarget: { gameIndex: null, draftType: null, slotIndex: null }, // Tracks which draft slot the modal is for (Draft Tracker)
        modalSearchTerm: '', // Search term within the champion select modal (Draft Tracker)
        modalSuggestions: [], // Filtered champion suggestions for the modal (Draft Tracker)
        modalSuggestionIndex: -1, // Index of the currently highlighted suggestion (Draft Tracker)
        modalCurrentValue: null, // The champion currently in the targeted slot (if any) (Draft Tracker)
        confirmationMessage: '', // Message displayed in the confirmation modal
        confirmationCallback: null, // Function to execute when confirmation is confirmed
        confirmationAction: '', // Identifier for styling the confirm button (e.g., 'resetDraftSeries', 'removeGame')

        // --- Draft Creator State ---
        draftCreatorRoleFilter: 'all', // Role filter specifically for the draft creator pool
        draftCreatorSearchTerm: '', // Search term for the draft creator pool
        currentDraft: { // Holds the state of the draft being created
            id: null, // Firestore ID if loaded/saved
            name: "New Draft",
            bluePicks: Array(5).fill(null).map(() => ({ champion: null, notes: '' })),
            blueBans: Array(5).fill(null).map(() => ({ champion: null, notes: '' })),
            redPicks: Array(5).fill(null).map(() => ({ champion: null, notes: '' })),
            redBans: Array(5).fill(null).map(() => ({ champion: null, notes: '' })),
            generalNotes: '', // Overall notes for the draft
            createdAt: null // Firestore timestamp
        },
        savedDrafts: [], // Array of saved draft objects {id, name, createdAt}
        isLoadingSavedDrafts: false,
        selectedChampionForPlacement: null, // Champion name selected from the pool, ready to be placed
        selectedChampionSource: null, // { side: 'blue'/'red'/null, type: 'picks'/'bans'/null, index: number } - For moving placed champs
        selectedTargetSlot: null, // { side: 'blue'/'red', type: 'picks'/'bans', index: number } - For placing into an empty slot
        notesModal: { // State for the notes editing modal
            isOpen: false,
            side: null, // 'blue', 'red', 'general'
            type: null, // 'picks', 'bans', 'general'
            index: null, // Slot index or null for general
            currentNote: '',
            title: ''
        },
        // --- End Draft Creator State ---


        // --- Computed Properties ---

        // Calculates the set of champions unavailable due ONLY to picks in the draft series (Draft Tracker).
        get unavailableChampions() {
            const unavailable = new Set();
            this.draftSeries.forEach(game => {
                // Add picks from both sides
                (game?.bluePicks ?? []).forEach(pick => pick && unavailable.add(pick));
                (game?.redPicks ?? []).forEach(pick => pick && unavailable.add(pick));
            });
            return unavailable;
        },

        // Provides a sorted array of unavailable champion names (based on picks only) (Draft Tracker).
        get sortedUnavailableChampions() {
            return Array.from(this.unavailableChampions).sort();
        },

        // Groups unavailable champions (picks only) by their most likely role (Draft Tracker).
        get unavailableChampionsByRole() {
            const grouped = { Top: [], Jungle: [], Mid: [], Bot: [], Support: [], Unknown: [] };
            const validRoles = this._validRoles;
            this.unavailableChampions.forEach(championName => { // Now iterates only over picks
                let assignedRole = 'Unknown';
                const teamRoles = Object.keys(this.teamPool).filter(role => this.teamPool[role]?.[championName]);
                const teamRoleCount = teamRoles.length;
                const champData = this.allChampions.find(c => c.name === championName);
                const mainRole = champData?.mainRole;

                if (teamRoleCount === 1) {
                    assignedRole = teamRoles[0];
                } else if (teamRoleCount > 1) {
                    if (mainRole && validRoles.has(mainRole)) {
                        assignedRole = mainRole;
                    } else {
                        assignedRole = teamRoles[0] || 'Unknown';
                    }
                } else {
                    if (mainRole && validRoles.has(mainRole)) {
                        assignedRole = mainRole;
                    } else {
                        assignedRole = (champData?.roles?.find(r => validRoles.has(r))) || 'Unknown';
                    }
                }
                if (!grouped[assignedRole]) {
                    assignedRole = 'Unknown';
                }
                grouped[assignedRole].push(championName);
            });
            Object.values(grouped).forEach(arr => arr.sort());
            return grouped;
        },

        // Filters and sorts the main champion list based on current filters, search term, and sort order (Champion Pool View).
        get filteredChampions() {
            // Ensure champion data is loaded
            if (!this.allChampions || this.allChampions.length === 0) return [];

            // 1. Map all champions, adding pool info and unavailability status
            let processedChampions = this.allChampions.map(champ => ({
                ...champ,
                poolInfo: this.getChampionPoolInfo(champ.name, this.currentFilter, this.roleFilter),
                // Note: isUnavailable check here still uses the computed property which now excludes bans
                isChampUnavailable: this.isUnavailable(champ.name)
            }));

            // 2. Filter by Player/Team Pool ('currentFilter')
            if (this.currentFilter === 'pool') {
                processedChampions = processedChampions.filter(c => c.poolInfo.isInPool);
            } else if (this.currentFilter !== 'all') {
                // Since filters are mutually exclusive, only one can be active besides 'all' or 'pool'
                processedChampions = processedChampions.filter(c => c.poolInfo.players.includes(this.currentFilter));
            }

            // 3. Filter by Role ('roleFilter')
            if (this.roleFilter !== 'all') {
                // Since filters are mutually exclusive, only one can be active besides 'all'
                processedChampions = processedChampions.filter(c => Array.isArray(c.roles) && c.roles.includes(this.roleFilter));
            }

            // 4. Filter by Search Term
            if (this.searchTerm.trim() !== '') {
                const searchLower = this.searchTerm.trim().toLowerCase();
                processedChampions = processedChampions.filter(c => c.name.toLowerCase().includes(searchLower));
            }

            // 5. Sort the results
            processedChampions.sort((a, b) => {
                if (this.sortOrder === 'tier') {
                    const tierA = a.poolInfo?.tier || 'DEFAULT';
                    const tierB = b.poolInfo?.tier || 'DEFAULT';
                    const valueA = this._tierOrderValue[tierA] ?? 0;
                    const valueB = this._tierOrderValue[tierB] ?? 0;
                    if (valueA !== valueB) return valueB - valueA; // Higher tier value first
                    // If tiers are equal, sort by name
                    return a.name.localeCompare(b.name);
                } else {
                    // Default sort by name
                    return a.name.localeCompare(b.name);
                }
            });

            return processedChampions;
         },

         // Generates the title for the modal based on its type and target (Draft Tracker Modal).
         get modalTitle() {
             if (this.modalType === 'championSelect') {
                 if (!this.modalTarget.draftType) return 'Select Champion';
                 const side = this.modalTarget.draftType.includes('blue') ? 'Blue' : 'Red';
                 // Determine if it's a ban or pick slot for the title
                 const type = this.modalTarget.draftType.includes('Bans') ? 'Ban' : 'Pick';
                 const slot = this.modalTarget.slotIndex + 1;
                 return `Select Champion for ${side} ${type} ${slot}`;
             } else if (this.modalType === 'confirm') {
                 return 'Confirm Action';
             }
             return 'Modal'; // Default title
         },

        // --- Draft Creator Computed Properties ---

        // Filters the champion pool specifically for the Draft Creator view.
        get draftCreatorFilteredChampions() {
            if (!this.allChampions || this.allChampions.length === 0) return [];

            let champs = [...this.allChampions]; // Start with a copy

            // Filter by role if a role filter is active
            if (this.draftCreatorRoleFilter !== 'all') {
                champs = champs.filter(c => Array.isArray(c.roles) && c.roles.includes(this.draftCreatorRoleFilter));
            }

            // Filter by search term
            if (this.draftCreatorSearchTerm.trim() !== '') {
                const searchLower = this.draftCreatorSearchTerm.trim().toLowerCase();
                champs = champs.filter(c => c.name.toLowerCase().includes(searchLower));
            }

            // Sort alphabetically
            return champs.sort((a, b) => a.name.localeCompare(b.name));
        },

        // --- Initialization ---
        async init() {
            console.log('Alpine component initializing...');
            this.isLoading = true;

            // Access global data provided by champions.js
            this.allChampions = window.allLolChampions || [];
            this.teamPool = window.teamTierList || {};
            if (this.allChampions.length === 0) { console.error("Champion list (allLolChampions) failed to load or is empty!"); }
            if (Object.keys(this.teamPool).length === 0) { console.warn("Team tier list (teamTierList) might be empty or failed to load."); }

            // Access global Firestore functions provided by firebase-init.js
            const fbFetch = window.fetchDraftDataFromFirestore;
            const fbSave = window.saveDraftDataToFirestore; // Keep reference for watchers
            const db = window.db; // Keep reference for listener
            const fbFetchSavedDrafts = window.fetchSavedDraftsFromFirestore; // Draft Creator

            // Fetch initial draft state from Firestore (Draft Tracker)
            if (typeof fbFetch === 'function') {
                try {
                    const loadedData = await fbFetch();
                     // Sanitize and assign picked champions
                     this.pickedChampions = loadedData.pickedChampions || [];
                     // Sanitize and assign draft series data, ensuring correct structure
                     this.draftSeries = (Array.isArray(loadedData.draftSeries) && loadedData.draftSeries.length > 0 ? loadedData.draftSeries : [{ blueBans: Array(5).fill(null), bluePicks: Array(5).fill(null), redBans: Array(5).fill(null), redPicks: Array(5).fill(null) }])
                         .map(game => ({ // Ensure each game object has the correct arrays
                             blueBans: Array.isArray(game?.blueBans) && game.blueBans.length === 5 ? game.blueBans : Array(5).fill(null),
                             bluePicks: Array.isArray(game?.bluePicks) && game.bluePicks.length === 5 ? game.bluePicks : Array(5).fill(null),
                             redBans: Array.isArray(game?.redBans) && game.redBans.length === 5 ? game.redBans : Array(5).fill(null),
                             redPicks: Array.isArray(game?.redPicks) && game.redPicks.length === 5 ? game.redPicks : Array(5).fill(null),
                         }));
                } catch (error) {
                    // Fallback to defaults on error
                    console.error("Error during initial Firestore fetch:", error);
                     this.pickedChampions = [];
                     this.draftSeries = [{ blueBans: Array(5).fill(null), bluePicks: Array(5).fill(null), redBans: Array(5).fill(null), redPicks: Array(5).fill(null) }];
                }
            } else {
                console.error("fetchDraftDataFromFirestore function not found globally.");
                // Initialize with defaults if fetch function isn't available
                this.pickedChampions = [];
                this.draftSeries = [{ blueBans: Array(5).fill(null), bluePicks: Array(5).fill(null), redBans: Array(5).fill(null), redPicks: Array(5).fill(null) }];
            }

            // Fetch saved drafts (Draft Creator)
            if (typeof fbFetchSavedDrafts === 'function') {
                this.isLoadingSavedDrafts = true;
                try {
                    this.savedDrafts = await fbFetchSavedDrafts();
                } catch (error) {
                    console.error("Error fetching saved drafts:", error);
                    this.savedDrafts = [];
                } finally {
                    this.isLoadingSavedDrafts = false;
                }
            } else {
                 console.error("fetchSavedDraftsFromFirestore function not found globally.");
                 this.savedDrafts = [];
            }


            this.isLoading = false;
            console.log(`Loaded ${this.allChampions.length} champions.`);
            console.log('Draft Helper Initialized');

            // Debounced function to save data to Firestore (Draft Tracker)
            const debouncedSave = () => {
                clearTimeout(this._saveTimeout);
                this._saveTimeout = setTimeout(() => {
                     // Check if save function is available
                     if (typeof fbSave === 'function') {
                        // Create deep copies to avoid reactivity issues when saving
                         const dataToSave = {
                            pickedChampions: JSON.parse(JSON.stringify(this.pickedChampions)),
                            draftSeries: JSON.parse(JSON.stringify(this.draftSeries))
                         };
                         fbSave(dataToSave);
                     } else {
                        console.error("saveDraftDataToFirestore function not found globally. Cannot save.");
                     }
                }, 1500); // Wait 1.5 seconds after the last change
            };

            // Watch for changes in pickedChampions and draftSeries to trigger debounced save (Draft Tracker)
            this.$watch('pickedChampions', debouncedSave);
            this.$watch('draftSeries', debouncedSave, { deep: true }); // Deep watch for changes within the array/objects

            // Set up Firestore real-time listener if db instance is available (Draft Tracker)
            if (db) {
                const DRAFT_COLLECTION = "drafts"; // Define constants locally if needed
                const DRAFT_DOC_ID = 'current_draft';
                const docRef = db.collection(DRAFT_COLLECTION).doc(DRAFT_DOC_ID);

                this._unsubscribeFirestore = docRef.onSnapshot((doc) => {
                    console.log("Real-time update received from Firestore.");
                    if (doc.exists) {
                        const data = doc.data();
                        // Sanitize and prepare incoming data
                        const newDraftSeries = (Array.isArray(data.draftSeries) && data.draftSeries.length > 0 ? data.draftSeries : [{ blueBans: Array(5).fill(null), bluePicks: Array(5).fill(null), redBans: Array(5).fill(null), redPicks: Array(5).fill(null) }])
                            .map(game => ({
                                blueBans: Array.isArray(game?.blueBans) && game.blueBans.length === 5 ? game.blueBans : Array(5).fill(null),
                                bluePicks: Array.isArray(game?.bluePicks) && game.bluePicks.length === 5 ? game.bluePicks : Array(5).fill(null),
                                redBans: Array.isArray(game?.redBans) && game.redBans.length === 5 ? game.redBans : Array(5).fill(null),
                                redPicks: Array.isArray(game?.redPicks) && game.redPicks.length === 5 ? game.redPicks : Array(5).fill(null),
                            }));
                        const newPickedChampions = Array.isArray(data.pickedChampions) ? data.pickedChampions : [];

                        // Update local state only if it differs from Firestore to prevent unnecessary re-renders
                        // Use simple JSON stringify for comparison
                        if (JSON.stringify(this.draftSeries) !== JSON.stringify(newDraftSeries)) {
                            console.log("Updating local draftSeries from Firestore.");
                            this.draftSeries = newDraftSeries;
                        }
                         if (JSON.stringify(this.pickedChampions) !== JSON.stringify(newPickedChampions)) {
                             console.log("Updating local pickedChampions from Firestore.");
                             this.pickedChampions = newPickedChampions;
                         }
                    } else {
                        // Handle case where the document is deleted in Firestore
                        console.log("Draft document deleted in Firestore. Resetting local state.");
                        this.draftSeries = [{ blueBans: Array(5).fill(null), bluePicks: Array(5).fill(null), redBans: Array(5).fill(null), redPicks: Array(5).fill(null) }];
                        this.pickedChampions = [];
                    }
                }, (error) => {
                    console.error("Error listening to draft updates:", error);
                });
            } else {
                console.error("Firestore db instance not available, cannot set up real-time listener.");
            }
         },

         // Cleanup function called when the component is destroyed.
         destroy() {
            // Detach the Firestore listener to prevent memory leaks
            if (this._unsubscribeFirestore) {
                console.log("Unsubscribing from Firestore listener.");
                this._unsubscribeFirestore();
            }
            // Clear any pending save timeout
             clearTimeout(this._saveTimeout);
         },

        // --- Champion Pool View Methods ---

        // Sets the sort order for the champion pool.
        setSortOrder(order) {
            this.sortOrder = order;
            console.log(`Sort order set to: ${order}`);
        },

        /**
         * Sets the player/team filter OR role filter, ensuring they are mutually exclusive.
         * Allows toggling the active filter off.
         * @param {string} value - The value of the filter being set (e.g., 'Top', 'pool', 'all').
         * @param {string} type - The type of filter being set ('player' or 'role').
         */
        setFilter(value, type) {
            if (type === 'player') {
                // If clicking the same active player filter, reset both filters to 'all'.
                if (this.currentFilter === value) {
                    this.currentFilter = 'all';
                    this.roleFilter = 'all'; // Ensure role filter is also reset
                } else {
                    // Activate the new player filter and deactivate the role filter.
                    this.currentFilter = value;
                    this.roleFilter = 'all';
                }
            } else if (type === 'role') {
                // If clicking the same active role filter, reset both filters to 'all'.
                if (this.roleFilter === value) {
                    this.roleFilter = 'all';
                    this.currentFilter = 'all'; // Ensure player filter is also reset
                } else {
                    // Activate the new role filter and deactivate the player filter.
                    this.roleFilter = value;
                    this.currentFilter = 'all';
                }
            }
            console.log(`Filters set - Player/Team: ${this.currentFilter}, Role: ${this.roleFilter}`);
        },


        // Checks if a champion is unavailable (picked in draft - bans excluded).
        isUnavailable(championName) {
            // Uses the updated computed property `unavailableChampions` which only includes picks.
            return championName ? this.unavailableChampions.has(championName) : false;
        },

        // Checks if a champion is manually highlighted (picked).
        isPicked(championName) {
            return championName ? this.pickedChampions.includes(championName) : false;
        },

        // Toggles the manual highlight (picked) status of a champion (Left Click).
        togglePick(championName) {
            // Cannot toggle unavailable (picked in draft) champs via this method
            if (!championName || this.isUnavailable(championName)) return;
            const index = this.pickedChampions.indexOf(championName);
            if (index === -1) {
                // Add to picked list
                this.pickedChampions = [...this.pickedChampions, championName];
            } else {
                // Remove from picked list
                this.pickedChampions = this.pickedChampions.filter(name => name !== championName);
            }
            // Note: Firestore save is handled by the $watch('pickedChampions', ...) in init()
         },

         // *** NEW: Un-highlights a champion if it's currently highlighted (Right Click) ***
         unpickChampion(championName) {
            // Cannot unpick unavailable champs
            if (!championName || this.isUnavailable(championName)) return;

            // Only remove if it's currently in the pickedChampions array
            if (this.pickedChampions.includes(championName)) {
                this.pickedChampions = this.pickedChampions.filter(name => name !== championName);
                console.log(`Unpicked ${championName} via right-click.`);
                // Firestore save is handled by the watcher
            }
         },

         // Resets the entire draft series to a single empty game (Draft Tracker).
         resetDraftSeriesAction() {
             const defaultDraft = [{ blueBans: Array(5).fill(null), bluePicks: Array(5).fill(null), redBans: Array(5).fill(null), redPicks: Array(5).fill(null) }];
             // Use deep copy to avoid reactivity issues
             this.draftSeries = JSON.parse(JSON.stringify(defaultDraft));
             this.searchTerm = ''; // Also clear search term
             console.log('Draft Series Reset');
             // Manually trigger save immediately for resets
             const fbSave = window.saveDraftDataToFirestore;
             if(typeof fbSave === 'function') {
                 fbSave({ pickedChampions: this.pickedChampions, draftSeries: defaultDraft });
             } else {
                 console.error("saveDraftDataToFirestore function not found globally. Cannot save reset.");
             }
         },

         // Clears the list of manually highlighted (picked) champions (Champion Pool).
         resetMarkedPicksAction() {
            if (this.pickedChampions.length > 0) {
                this.pickedChampions = [];
                console.log('Highlighted Picks Reset');
                // Manually trigger save immediately for resets
                const fbSave = window.saveDraftDataToFirestore;
                 if(typeof fbSave === 'function') {
                    fbSave({ pickedChampions: [], draftSeries: this.draftSeries });
                 } else {
                    console.error("saveDraftDataToFirestore function not found globally. Cannot save reset.");
                 }
            }
         },

         // Action to remove a specific game from the draft series (Draft Tracker).
         removeGameAction(gameIndex) {
            // Create a new array excluding the game at the specified index
            const newDraftSeries = JSON.parse(JSON.stringify(this.draftSeries)).filter((_, index) => index !== gameIndex);
            this.draftSeries = newDraftSeries;
            console.log(`Removed Game at index ${gameIndex}`);
            // Note: Firestore save is handled by the $watch('draftSeries', ...) in init()
         },

        // --- Draft Tracker Slot Interaction Methods ---

        /**
         * Clears a specific pick/ban slot when right-clicked (Draft Tracker).
         * @param {number} gameIndex - Index of the game in the draftSeries array.
         * @param {string} draftType - Type of draft slot ('blueBans', 'bluePicks', 'redBans', 'redPicks').
         * @param {number} slotIndex - Index of the slot within the draftType array.
         */
        clearSlot(gameIndex, draftType, slotIndex) {
            // Validate indices and draft type
            if (gameIndex < 0 || gameIndex >= this.draftSeries.length ||
                !this.draftSeries[gameIndex]?.[draftType] ||
                slotIndex < 0 || slotIndex >= this.draftSeries[gameIndex][draftType].length) {
                console.error("Invalid target for clearSlot:", gameIndex, draftType, slotIndex);
                return;
            }

            // Check if the slot actually needs clearing
            if (this.draftSeries[gameIndex][draftType][slotIndex] !== null) {
                // Create a deep copy to modify safely
                const newDraftSeries = JSON.parse(JSON.stringify(this.draftSeries));
                // Set the specific slot to null
                newDraftSeries[gameIndex][draftType][slotIndex] = null;
                // Update the reactive property, triggering UI update and debounced save
                this.draftSeries = newDraftSeries;
                console.log(`Cleared slot ${slotIndex + 1} for ${draftType} in Game ${gameIndex + 1} via right-click.`);
            }
            // No need to manually save, the watcher on draftSeries handles it.
        },

         // --- Modal Methods (Draft Tracker) ---

         // Opens the champion select modal targeting a specific draft slot.
         openChampionSelectModal(gameIndex, draftType, slotIndex) {
            // Validate target parameters
            if (gameIndex < 0 || gameIndex >= this.draftSeries.length || !this.draftSeries[gameIndex]?.[draftType]) {
                console.error("Invalid target for modal:", gameIndex, draftType, slotIndex);
                return;
            }
            // Set modal state *before* showing it
            this.modalType = 'championSelect';
            this.modalTarget = { gameIndex, draftType, slotIndex };
            this.modalCurrentValue = this.draftSeries[gameIndex][draftType][slotIndex]; // Store current value
            this.modalSearchTerm = this.modalCurrentValue || ''; // Pre-fill search if slot has value
            this.modalSuggestions = []; // Clear previous suggestions
            this.modalSuggestionIndex = -1; // Reset suggestion selection
            // Clear confirmation state
            this.confirmationMessage = '';
            this.confirmationCallback = null;
            this.confirmationAction = '';

            // Use $nextTick to ensure the modal element is rendered before focusing the input
            this.$nextTick(() => {
                this.$refs.modalInput?.focus();
                this.updateSuggestions(); // Initial suggestion update
            });
         },

         // Opens the confirmation modal with a message and callback.
         openConfirmationModal(message, callback, actionIdentifier = 'confirm') {
             // Set modal state *before* showing it
             this.modalType = 'confirm';
             this.confirmationMessage = message;
             this.confirmationCallback = callback; // Store the function to call on confirm
             this.confirmationAction = actionIdentifier; // Used for styling the confirm button
             // Clear potentially conflicting state from champion select modal
             this.modalTarget = { gameIndex: null, draftType: null, slotIndex: null };
             this.modalSearchTerm = '';
             this.modalSuggestions = [];
             this.modalSuggestionIndex = -1;
             this.modalCurrentValue = null;
         },

         // Closes the modal by setting its type to 'closed'.
         // The actual state reset happens via resetModalState triggered by the leave transition.
         closeModal() {
            this.modalType = 'closed';
         },

         // Resets all modal-related state variables. Called after the modal's leave transition ends.
         resetModalState() {
            console.log("Resetting modal state after transition.");
            this.modalTarget = { gameIndex: null, draftType: null, slotIndex: null };
            this.modalSearchTerm = '';
            this.modalSuggestions = [];
            this.modalSuggestionIndex = -1;
            this.modalCurrentValue = null;
            this.confirmationMessage = '';
            this.confirmationCallback = null;
            this.confirmationAction = '';
         },

         // Updates the suggestions list in the champion select modal based on the search term.
         updateSuggestions() {
            if (this.modalType !== 'championSelect') return; // Only run for the correct modal type
            const term = this.modalSearchTerm.trim().toLowerCase();
            if (term === '') {
                // Clear suggestions if search term is empty
                this.modalSuggestions = [];
                this.modalSuggestionIndex = -1;
                return;
            }

            // Determine champions unavailable for *this specific slot*
            // This includes picks AND bans from the series, EXCEPT the champion currently in this slot
            const unavailableForThisSlot = new Set();
            this.draftSeries.forEach((game, gIdx) => {
                ['bluePicks', 'redPicks', 'blueBans', 'redBans'].forEach(type => {
                    (game?.[type] ?? []).forEach((champ, sIdx) => {
                        // Check if this is the exact slot we are editing
                        const isCurrentSlot = gIdx === this.modalTarget.gameIndex &&
                                             type === this.modalTarget.draftType &&
                                             sIdx === this.modalTarget.slotIndex;
                        // Add to unavailable set if it's not the current slot and has a champion
                        if (champ && !isCurrentSlot) {
                            unavailableForThisSlot.add(champ);
                        }
                    });
                });
            });


            // Filter all champions:
            // - Must NOT be unavailable for this specific slot
            const availableChamps = this.allChampions.filter(champ =>
                !unavailableForThisSlot.has(champ.name)
            );

            // Filter by search term, sort alphabetically, and limit to 7 suggestions
            this.modalSuggestions = availableChamps
                .filter(champ => champ.name.toLowerCase().includes(term))
                .sort((a, b) => a.name.localeCompare(b.name)) // Sort suggestions alphabetically
                .slice(0, 7); // Limit number of suggestions shown
            this.modalSuggestionIndex = -1; // Reset selection index whenever suggestions update
         },

         // Selects a suggestion, updating the search term and closing the suggestion list.
         selectSuggestion(championName) {
            this.modalSearchTerm = championName; // Set input value to the selected suggestion
            this.modalSuggestions = []; // Hide suggestions
            this.modalSuggestionIndex = -1; // Reset index
            this.$refs.modalInput?.focus(); // Keep focus on the input
         },

         // Navigates down through the suggestions list using arrow keys.
         selectNextSuggestion() {
            if (this.modalSuggestions.length === 0) return;
            this.modalSuggestionIndex = (this.modalSuggestionIndex + 1) % this.modalSuggestions.length;
         },

         // Navigates up through the suggestions list using arrow keys.
         selectPreviousSuggestion() {
            if (this.modalSuggestions.length === 0) return;
            this.modalSuggestionIndex = (this.modalSuggestionIndex - 1 + this.modalSuggestions.length) % this.modalSuggestions.length;
         },

         // Handles the confirm action for both modal types (Champion Select / Confirmation).
         confirmModalAction() {
            if (this.modalType === 'championSelect') {
                let selectedChampionName = this.modalSearchTerm.trim();
                // If a suggestion is highlighted, use its name instead of the raw input
                if (this.modalSuggestionIndex !== -1 && this.modalSuggestions[this.modalSuggestionIndex]) {
                    selectedChampionName = this.modalSuggestions[this.modalSuggestionIndex].name;
                }
                // If the final name is empty, treat it as clearing the slot
                if (selectedChampionName === "") {
                    this.clearModalSelection(); // clearModalSelection also closes the modal
                    return;
                }
                // Find the canonical champion data (case-insensitive)
                const canonicalChamp = this.allChampions?.find(champ => champ.name.toLowerCase() === selectedChampionName.toLowerCase());
                if (!canonicalChamp) {
                    // Champion not found in the master list
                    alert(`Champion "${selectedChampionName}" not found.`); // Use alert for simplicity here
                    this.modalSearchTerm = ''; // Clear invalid input
                    this.updateSuggestions(); // Update suggestions (likely empty now)
                    this.$refs.modalInput?.focus();
                    return; // Keep modal open for correction
                }
                const canonicalName = canonicalChamp.name; // Use the official name

                // Re-check unavailability specifically for the target slot
                const unavailableForThisSlot = new Set();
                this.draftSeries.forEach((game, gIdx) => {
                    ['bluePicks', 'redPicks', 'blueBans', 'redBans'].forEach(type => {
                        (game?.[type] ?? []).forEach((champ, sIdx) => {
                            const isCurrentSlot = gIdx === this.modalTarget.gameIndex &&
                                                 type === this.modalTarget.draftType &&
                                                 sIdx === this.modalTarget.slotIndex;
                            if (champ && !isCurrentSlot) {
                                unavailableForThisSlot.add(champ);
                            }
                        });
                    });
                });

                // Check if the selected champion is already picked/banned elsewhere
                if (unavailableForThisSlot.has(canonicalName)) {
                     alert(`${canonicalName} is already picked or banned in this series.`); // Use alert
                     return; // Keep modal open
                }

                // Update the draft series state
                const { gameIndex, draftType, slotIndex } = this.modalTarget;
                if (gameIndex !== null && draftType && slotIndex !== null) {
                    // Create a deep copy to modify
                    const newDraftSeries = JSON.parse(JSON.stringify(this.draftSeries));
                    newDraftSeries[gameIndex][draftType][slotIndex] = canonicalName; // Set the canonical name
                    this.draftSeries = newDraftSeries; // Update the reactive property
                    console.log(`Set ${canonicalName} for Game ${gameIndex + 1} ${draftType} slot ${slotIndex + 1}`);
                    // Note: Firestore save is handled by the $watch('draftSeries', ...) in init()
                }
                this.closeModal(); // Close the modal

            } else if (this.modalType === 'confirm') {
                // Execute the stored callback function if it exists
                if (typeof this.confirmationCallback === 'function') {
                    this.confirmationCallback();
                }
                this.closeModal(); // Close the modal
            }
         },

         // Clears the selected champion from the targeted draft slot (called from modal button).
         clearModalSelection() {
            if (this.modalType !== 'championSelect') return;
            const { gameIndex, draftType, slotIndex } = this.modalTarget;
            // Check if the slot actually needs clearing
            if (gameIndex !== null && draftType && slotIndex !== null && this.draftSeries[gameIndex][draftType][slotIndex] !== null) {
                // Create a deep copy to modify
                const newDraftSeries = JSON.parse(JSON.stringify(this.draftSeries));
                newDraftSeries[gameIndex][draftType][slotIndex] = null; // Set slot to null
                this.draftSeries = newDraftSeries; // Update reactive property
                console.log(`Cleared slot ${slotIndex + 1} for ${draftType} in Game ${gameIndex + 1} from modal.`);
                // Note: Firestore save is handled by the $watch('draftSeries', ...) in init()
            }
            this.closeModal(); // Close the modal
         },

         // Adds a new empty game to the draft series (Draft Tracker).
         addNewGame() {
             // Create a deep copy and append a new game object
             const newDraftSeries = JSON.parse(JSON.stringify(this.draftSeries));
             newDraftSeries.push({ blueBans: Array(5).fill(null), bluePicks: Array(5).fill(null), redBans: Array(5).fill(null), redPicks: Array(5).fill(null) });
             this.draftSeries = newDraftSeries; // Update reactive property
             // Note: Firestore save is handled by the $watch('draftSeries', ...) in init()
         },

         // Initiates the process to remove a game via the confirmation modal (Draft Tracker).
         removeGame(gameIndex) {
             // Prevent removing the last game
             if (this.draftSeries.length <= 1) {
                 alert("Cannot remove the only game in the series."); // Use alert
                 return;
             }
             // Open the confirmation modal
             this.openConfirmationModal(
                 `Are you sure you want to remove Game ${gameIndex + 1}? This cannot be undone.`,
                 () => this.removeGameAction(gameIndex), // Pass the action to execute on confirm
                 'removeGame' // Identifier for styling
             );
         },

        // --- Draft Creator Methods ---

        /**
         * Sets the role filter specifically for the Draft Creator champion pool.
         * Allows toggling back to 'all'.
         * @param {string} role - The role to filter by (e.g., 'Top', 'Jungle') or 'all'.
         */
        setDraftCreatorRoleFilter(role) {
            this.draftCreatorRoleFilter = this.draftCreatorRoleFilter === role ? 'all' : role;
        },

        /**
         * Checks if a champion is currently placed anywhere in the currentDraft object.
         * @param {string} championName - The name of the champion to check.
         * @returns {boolean} - True if the champion is placed, false otherwise.
         */
        isChampionPlacedInCurrentDraft(championName) {
            if (!championName) return false;
            const draft = this.currentDraft;
            const checkSlot = slot => slot && slot.champion === championName;
            return draft.bluePicks.some(checkSlot) ||
                   draft.blueBans.some(checkSlot) ||
                   draft.redPicks.some(checkSlot) ||
                   draft.redBans.some(checkSlot);
        },

        /**
         * Helper function to place a champion into a specified slot, handling removal from previous slots.
         * @param {string} championName - The champion to place.
         * @param {string} targetSide - 'blue' or 'red'.
         * @param {string} targetType - 'picks' or 'bans'.
         * @param {number} targetIndex - Index of the target slot.
         */
        _placeChampionInSlot(championName, targetSide, targetType, targetIndex) {
            const targetSlotRef = this.currentDraft[`${targetSide}${targetType.charAt(0).toUpperCase() + targetType.slice(1)}`][targetIndex];

            // 1. Remove the champion from any other slot it might be in
            ['blue', 'red'].forEach(s => {
                ['picks', 'bans'].forEach(t => {
                    this.currentDraft[`${s}${t.charAt(0).toUpperCase() + t.slice(1)}`].forEach((slot, i) => {
                        if (slot.champion === championName) {
                            // Check if it's not the target slot we are about to place into
                            if (!(s === targetSide && t === targetType && i === targetIndex)) {
                                slot.champion = null;
                                slot.notes = ''; // Clear notes from old slot
                                console.log(`Removed ${championName} from previous slot: ${s} ${t} ${i + 1}`);
                            }
                        }
                    });
                });
            });

            // 2. Place the champion in the target slot
            targetSlotRef.champion = championName;
            targetSlotRef.notes = ''; // Clear notes on new placement
            console.log(`Placed ${championName} into ${targetSide} ${targetType} ${targetIndex + 1}.`);
        },

        /**
         * Selects a champion from the pool OR places it directly if a target slot is selected.
         * Also handles selecting a placed champion for moving.
         * @param {string} championName - The name of the champion clicked in the pool.
         */
        selectChampionForPlacement(championName) {
            if (!championName) return;

            // --- Case 1: A target slot is already selected ---
            if (this.selectedTargetSlot) {
                const { side, type, index } = this.selectedTargetSlot;

                // If the clicked champion is already in the target slot, do nothing (or maybe deselect target?)
                // For now, let's just ignore the click if the champ is already there.
                const targetSlotRef = this.currentDraft[`${side}${type.charAt(0).toUpperCase() + type.slice(1)}`][index];
                if (targetSlotRef.champion === championName) {
                    console.log(`Champion ${championName} is already in the targeted slot.`);
                    return;
                }

                // Place the clicked champion directly into the selected target slot
                this._placeChampionInSlot(championName, side, type, index);

                // Clear the target slot selection
                this.selectedTargetSlot = null;
                // Ensure other selections are also cleared
                this.selectedChampionForPlacement = null;
                this.selectedChampionSource = null;
                console.log(`Placed ${championName} directly into pre-selected target slot.`);
                return; // Action complete
            }

            // --- Case 2: No target slot selected, proceed with original logic ---

            // If this champion is already selected for placement, deselect it.
            if (this.selectedChampionForPlacement === championName) {
                this.selectedChampionForPlacement = null;
                console.log(`Deselected ${championName} for placement.`);
                return;
            }

            // If another champion is currently selected for moving, clear that selection first.
            if (this.selectedChampionSource) {
                this.selectedChampionSource = null;
            }

            // If the clicked champion is already placed somewhere in the draft
            if (this.isChampionPlacedInCurrentDraft(championName)) {
                 // Find the source of the placed champion
                 let foundSource = null;
                 ['blue', 'red'].forEach(side => {
                     ['picks', 'bans'].forEach(type => {
                         this.currentDraft[`${side}${type.charAt(0).toUpperCase() + type.slice(1)}`].forEach((slot, index) => {
                             if (slot.champion === championName) {
                                 foundSource = { side, type, index };
                             }
                         });
                     });
                 });

                 if (foundSource) {
                     this.selectedChampionSource = foundSource; // Select the *source slot* for moving
                     this.selectedChampionForPlacement = null; // Ensure placement mode is off
                     this.selectedTargetSlot = null; // Ensure target mode is off
                     console.log(`Selected placed champion ${championName} from ${foundSource.side} ${foundSource.type} ${foundSource.index + 1} for moving.`);
                 } else {
                     console.warn(`Champion ${championName} is marked as placed but couldn't find its source.`);
                     this.selectedChampionForPlacement = null; // Clear selection if source not found
                     this.selectedChampionSource = null;
                     this.selectedTargetSlot = null;
                 }
            } else {
                // Champion is not placed, select it for placement.
                this.selectedChampionForPlacement = championName;
                this.selectedChampionSource = null; // Ensure move mode is off
                this.selectedTargetSlot = null; // Ensure target mode is off
                console.log(`Selected ${championName} for placement.`);
            }
        },

        /**
         * Handles clicks on draft slots (picks/bans) in the Draft Creator.
         * Logic depends on whether a champion is selected from the pool, from another slot, or if no champion is selected.
         * @param {string} targetSide - 'blue' or 'red'.
         * @param {string} targetType - 'picks' or 'bans'.
         * @param {number} targetIndex - Index of the clicked slot.
         */
        handleSlotClick(targetSide, targetType, targetIndex) {
            const targetSlotRef = this.currentDraft[`${targetSide}${targetType.charAt(0).toUpperCase() + targetType.slice(1)}`][targetIndex];
            const currentTargetChampion = targetSlotRef.champion;

            // --- Case 1: A champion is selected from the POOL for PLACEMENT ---
            if (this.selectedChampionForPlacement) {
                const champToPlace = this.selectedChampionForPlacement;

                // If the target slot already has the *same* champion, deselect (do nothing to slot).
                if (currentTargetChampion === champToPlace) {
                    this.selectedChampionForPlacement = null;
                    console.log(`Clicked target slot with the same champion (${champToPlace}). Deselected.`);
                    return;
                }

                // Place the champion (handles removal from old slot)
                this._placeChampionInSlot(champToPlace, targetSide, targetType, targetIndex);

                // Clear the selection state
                this.selectedChampionForPlacement = null;
                this.selectedTargetSlot = null; // Clear target slot if any
            }
            // --- Case 2: A champion is selected from a SOURCE SLOT for MOVING ---
            else if (this.selectedChampionSource) {
                const sourceSlotRef = this.currentDraft[`${this.selectedChampionSource.side}${this.selectedChampionSource.type.charAt(0).toUpperCase() + this.selectedChampionSource.type.slice(1)}`][this.selectedChampionSource.index];
                const champToMove = sourceSlotRef.champion;
                const notesToMove = sourceSlotRef.notes;

                // If clicking the SAME slot, deselect it for moving.
                if (this.selectedChampionSource.side === targetSide &&
                    this.selectedChampionSource.type === targetType &&
                    this.selectedChampionSource.index === targetIndex) {
                    this.selectedChampionSource = null;
                    console.log(`Clicked the source slot (${champToMove}). Deselected for moving.`);
                    return;
                }

                // If the target slot contains a DIFFERENT champion, swap them.
                if (currentTargetChampion && currentTargetChampion !== champToMove) {
                    const targetNotes = targetSlotRef.notes;
                    console.log(`Swapping ${champToMove} (from ${this.selectedChampionSource.side} ${this.selectedChampionSource.type} ${this.selectedChampionSource.index + 1}) with ${currentTargetChampion} (in ${targetSide} ${targetType} ${targetIndex + 1}).`);

                    // Place target's champ/notes into source slot
                    sourceSlotRef.champion = currentTargetChampion;
                    sourceSlotRef.notes = targetNotes;

                    // Place source's champ/notes into target slot
                    targetSlotRef.champion = champToMove;
                    targetSlotRef.notes = notesToMove;

                }
                // If the target slot is EMPTY, move the champion.
                else {
                     console.log(`Moving ${champToMove} from ${this.selectedChampionSource.side} ${this.selectedChampionSource.type} ${this.selectedChampionSource.index + 1} to ${targetSide} ${targetType} ${targetIndex + 1}.`);
                    // Place source's champ/notes into target slot
                    targetSlotRef.champion = champToMove;
                    targetSlotRef.notes = notesToMove;

                    // Clear the source slot
                    sourceSlotRef.champion = null;
                    sourceSlotRef.notes = '';
                }

                // Clear the selection state
                this.selectedChampionSource = null;
                this.selectedTargetSlot = null; // Clear target slot if any
            }
            // --- Case 3: NO champion is selected (neither from pool nor from slot) ---
            else {
                 // If the clicked slot has a champion, select IT for moving.
                 if (currentTargetChampion) {
                     this.selectedChampionSource = { side: targetSide, type: targetType, index: targetIndex };
                     this.selectedTargetSlot = null; // Clear target selection
                     console.log(`Selected ${currentTargetChampion} from ${targetSide} ${targetType} ${targetIndex + 1} for moving.`);
                 }
                 // If the clicked slot is EMPTY, select IT for targeting.
                 else {
                     // If this slot is already selected for targeting, deselect it
                     if (this.selectedTargetSlot &&
                         this.selectedTargetSlot.side === targetSide &&
                         this.selectedTargetSlot.type === targetType &&
                         this.selectedTargetSlot.index === targetIndex) {
                          this.selectedTargetSlot = null;
                          console.log(`Deselected empty slot ${targetSide} ${targetType} ${targetIndex + 1} for targeting.`);
                     } else {
                          this.selectedTargetSlot = { side: targetSide, type: targetType, index: targetIndex };
                          this.selectedChampionSource = null; // Clear move selection
                          console.log(`Selected empty slot ${targetSide} ${targetType} ${targetIndex + 1} for targeting.`);
                     }
                 }
            }
        },

        /**
         * Clears a specific pick/ban slot in the Draft Creator when right-clicked.
         * Also clears any active selections (placement, source, target).
         * @param {string} side - 'blue' or 'red'.
         * @param {string} type - 'picks' or 'bans'.
         * @param {number} index - Index of the slot.
         */
        clearCreatorSlot(side, type, index) {
            const slotRef = this.currentDraft[`${side}${type.charAt(0).toUpperCase() + type.slice(1)}`]?.[index];

            if (!slotRef) {
                console.error("Invalid target for clearCreatorSlot:", side, type, index);
                return;
            }

            // Clear champion and notes if present
            if (slotRef.champion) {
                const clearedChampion = slotRef.champion;
                slotRef.champion = null;
                slotRef.notes = '';
                console.log(`Cleared champion ${clearedChampion} from ${side} ${type} slot ${index + 1} via right-click.`);
            }

            // Always clear all selection states on right-click
            if (this.selectedChampionForPlacement) {
                this.selectedChampionForPlacement = null;
                console.log("Right-click cleared champion for placement selection.");
            }
            if (this.selectedChampionSource) {
                this.selectedChampionSource = null;
                console.log("Right-click cleared source champion for moving selection.");
            }
            if (this.selectedTargetSlot) {
                this.selectedTargetSlot = null;
                console.log("Right-click cleared target slot selection.");
            }
        },

        // --- Draft Creator Saving/Loading/Resetting ---

        // Resets the current draft to its default empty state.
        resetCurrentDraft() {
             this.currentDraft = {
                 id: null, name: "New Draft",
                 bluePicks: Array(5).fill(null).map(() => ({ champion: null, notes: '' })),
                 blueBans: Array(5).fill(null).map(() => ({ champion: null, notes: '' })),
                 redPicks: Array(5).fill(null).map(() => ({ champion: null, notes: '' })),
                 redBans: Array(5).fill(null).map(() => ({ champion: null, notes: '' })),
                 generalNotes: '', createdAt: null
             };
             // Clear all selection states
             this.selectedChampionForPlacement = null;
             this.selectedChampionSource = null;
             this.selectedTargetSlot = null;
             this.draftCreatorSearchTerm = ''; // Reset search term as well
             this.draftCreatorRoleFilter = 'all'; // Reset role filter
             console.log("Current draft reset.");
             // Optionally prompt for confirmation first
        },

        // Saves the current draft to Firestore.
        async saveCurrentDraft() {
            const fbSaveDraft = window.saveDraftToCreatorCollection;
            if (typeof fbSaveDraft !== 'function') {
                alert("Error: Save function not available.");
                return;
            }

            // Prompt for a name if it's a new draft or the default name
            if (!this.currentDraft.id || this.currentDraft.name === "New Draft" || this.currentDraft.name === "Unnamed Draft") {
                const draftName = prompt("Enter a name for this draft:", this.currentDraft.name !== "New Draft" ? this.currentDraft.name : "");
                if (draftName === null) return; // User cancelled
                this.currentDraft.name = draftName.trim() || "Unnamed Draft";
            }

            try {
                // Create a clean copy for saving (important for Firestore timestamps)
                 const draftToSave = JSON.parse(JSON.stringify(this.currentDraft));
                 // Remove local-only fields if necessary (like createdAt if it's already a Firestore timestamp object)
                 if (draftToSave.createdAt && typeof draftToSave.createdAt === 'object') {
                     // If it's already a Firestore Timestamp, keep it, otherwise Firestore handles it
                 } else {
                      delete draftToSave.createdAt; // Let Firestore set it on first save
                 }


                const savedDraft = await fbSaveDraft(draftToSave); // Pass the copy

                // Update the current draft with the ID and potentially new timestamp from Firestore
                this.currentDraft.id = savedDraft.id;
                this.currentDraft.createdAt = savedDraft.createdAt; // Update with server timestamp

                // Refresh the saved drafts list
                await this.refreshSavedDrafts();
                alert(`Draft "${this.currentDraft.name}" saved successfully!`);

            } catch (error) {
                console.error("Error saving draft:", error);
                alert("Failed to save draft. See console for details.");
            }
        },

        // Fetches the list of saved drafts from Firestore.
        async refreshSavedDrafts() {
            const fbFetchSavedDrafts = window.fetchSavedDraftsFromFirestore;
            if (typeof fbFetchSavedDrafts === 'function') {
                this.isLoadingSavedDrafts = true;
                try {
                    this.savedDrafts = await fbFetchSavedDrafts();
                } catch (error) {
                    console.error("Error refreshing saved drafts:", error);
                } finally {
                    this.isLoadingSavedDrafts = false;
                }
            }
        },

        // Loads a specific draft from Firestore into the currentDraft state.
        async loadSavedDraft(draftId) {
            const fbLoadDraft = window.loadSpecificDraftFromFirestore;
            if (typeof fbLoadDraft !== 'function') {
                alert("Error: Load function not available.");
                return;
            }
            if (!draftId) return;

            // Optional: Confirm overwrite if current draft has unsaved changes
            // (Add check later if needed)

            try {
                const loadedData = await fbLoadDraft(draftId);
                if (loadedData) {
                    // Ensure the loaded data has the correct structure
                    this.currentDraft = {
                        id: draftId,
                        name: loadedData.name || "Unnamed Draft",
                        bluePicks: this.sanitizeDraftArray(loadedData.bluePicks, 5),
                        blueBans: this.sanitizeDraftArray(loadedData.blueBans, 5),
                        redPicks: this.sanitizeDraftArray(loadedData.redPicks, 5),
                        redBans: this.sanitizeDraftArray(loadedData.redBans, 5),
                        generalNotes: loadedData.generalNotes || '',
                        createdAt: loadedData.createdAt || null // Keep Firestore timestamp if exists
                    };
                    // Clear selections on load
                    this.selectedChampionForPlacement = null;
                    this.selectedChampionSource = null;
                    this.selectedTargetSlot = null;
                    this.draftCreatorSearchTerm = ''; // Reset search/filter
                    this.draftCreatorRoleFilter = 'all';
                    console.log(`Loaded draft "${this.currentDraft.name}" (${draftId})`);
                } else {
                    alert("Could not find or load the selected draft.");
                    // Optionally remove the draft from the local list if it failed to load
                    this.savedDrafts = this.savedDrafts.filter(d => d.id !== draftId);
                }
            } catch (error) {
                console.error(`Error loading draft ${draftId}:`, error);
                alert("Failed to load draft. See console for details.");
            }
        },

        // Helper to ensure loaded draft arrays have the correct structure and length.
        sanitizeDraftArray(arr, expectedLength) {
            const defaultSlot = () => ({ champion: null, notes: '' });
            if (!Array.isArray(arr)) {
                return Array(expectedLength).fill(null).map(defaultSlot);
            }
            // Ensure each item has champion and notes, pad/truncate to expected length
            const sanitized = arr.map(item => ({
                champion: item?.champion || null,
                notes: item?.notes || ''
            }));
            while (sanitized.length < expectedLength) {
                sanitized.push(defaultSlot());
            }
            return sanitized.slice(0, expectedLength);
        },


        // Deletes a saved draft from Firestore and the local list.
        async deleteSavedDraft(draftId) {
             const fbDeleteDraft = window.deleteDraftFromCreatorCollection;
             if (typeof fbDeleteDraft !== 'function') {
                 alert("Error: Delete function not available.");
                 return;
             }
             if (!draftId) return;

             const draftToDelete = this.savedDrafts.find(d => d.id === draftId);
             const draftName = draftToDelete ? draftToDelete.name : 'this draft';

             // Use confirmation modal
             this.openConfirmationModal(
                 `Are you sure you want to permanently delete "${draftName}"? This cannot be undone.`,
                 async () => { // Callback function for confirmation
                     try {
                         await fbDeleteDraft(draftId);
                         // Remove from local list
                         this.savedDrafts = this.savedDrafts.filter(d => d.id !== draftId);
                         // If the deleted draft was the currently loaded one, reset the editor
                         if (this.currentDraft.id === draftId) {
                             this.resetCurrentDraft();
                         }
                         console.log(`Deleted draft ${draftId}`);
                         alert(`Draft "${draftName}" deleted successfully.`);
                     } catch (error) {
                         console.error(`Error deleting draft ${draftId}:`, error);
                         alert("Failed to delete draft. See console for details.");
                     }
                 },
                 'deleteSavedDraft' // Action identifier for styling
             );
         },

        // --- Notes Modal Methods ---

        /**
         * Opens the modal to edit notes for a specific slot or the general draft.
         * @param {string} side - 'blue', 'red', or 'general'.
         * @param {string} type - 'picks', 'bans', or 'general'.
         * @param {number|null} index - The slot index, or null for general notes.
         */
        toggleNotesVisibility(side, type, index) {
            this.notesModal.isOpen = true;
            this.notesModal.side = side;
            this.notesModal.type = type;
            this.notesModal.index = index;

            let noteSource = '';
            let title = 'Edit Notes';

            try {
                if (side === 'general') {
                    noteSource = this.currentDraft.generalNotes;
                    title = 'Edit General Draft Notes';
                } else {
                    const slotRef = this.currentDraft[`${side}${type.charAt(0).toUpperCase() + type.slice(1)}`]?.[index];
                    if (slotRef) {
                        noteSource = slotRef.notes;
                        const champName = slotRef.champion ? ` for ${slotRef.champion}` : '';
                        // Adjusted label for clarity
                        const slotLabel = `${side.charAt(0).toUpperCase()}${type.charAt(0).toUpperCase()}${index + 1}`;
                        title = `Edit Notes${champName} (${slotLabel})`;
                    } else {
                         throw new Error("Invalid slot reference");
                    }
                }
            } catch (error) {
                 console.error("Error accessing notes source:", error);
                 this.notesModal.isOpen = false; // Close modal if error occurs
                 alert("Could not open notes for this slot.");
                 return;
            }

            this.notesModal.currentNote = noteSource;
            this.notesModal.title = title;

            // Focus the textarea after the modal is rendered
            this.$nextTick(() => {
                this.$refs.notesTextarea?.focus();
            });
        },

        // Closes the notes modal without saving.
        closeNotesModal() {
            this.notesModal.isOpen = false;
            // Reset state just in case
            this.notesModal.side = null;
            this.notesModal.type = null;
            this.notesModal.index = null;
            this.notesModal.currentNote = '';
            this.notesModal.title = '';
        },

        // Saves the notes from the modal back to the currentDraft state and closes the modal.
        saveNotesAndCloseModal() {
            const { side, type, index, currentNote } = this.notesModal;
            try {
                if (side === 'general') {
                    this.currentDraft.generalNotes = currentNote;
                } else if (side && type && index !== null) {
                    const slotRef = this.currentDraft[`${side}${type.charAt(0).toUpperCase() + type.slice(1)}`]?.[index];
                     if (slotRef) {
                         slotRef.notes = currentNote;
                     } else {
                         throw new Error("Invalid slot reference on save");
                     }
                } else {
                    throw new Error("Invalid state for saving notes");
                }
                console.log(`Notes saved for ${side} ${type} ${index !== null ? index + 1 : ''}`);
            } catch (error) {
                 console.error("Error saving notes:", error);
                 alert("Failed to save notes.");
                 // Don't close modal on error? Or close anyway? Let's close.
            } finally {
                 this.closeNotesModal();
            }
        },


        // --- Helper Methods ---

         /**
          * Gets tier list information for a champion based on current filters (Champion Pool View).
          * Prioritizes the specific player/role filter if active.
          * @param {string} championName - The name of the champion.
          * @param {string} currentFilter - The active player/team filter ('all', 'pool', 'Top', 'Jungle', etc.).
          * @param {string} roleFilter - The active role filter ('all', 'Top', 'Jungle', etc.).
          * @returns {object} - { isInPool, tier, players, tierClass }
          */
         getChampionPoolInfo(championName, currentFilter = 'all', roleFilter = 'all') {
            const defaultInfo = { ...this._defaultPoolInfo }; // Start with default values
            if (!championName || !this.teamPool || typeof this.teamPool !== 'object') {
                return defaultInfo; // Return default if data is missing
            }

            let players = []; // List of players (roles) who have this champ in their pool
            let isInPool = false; // Is the champion in *any* player's pool?
            let highestTier = null; // Highest tier found across all relevant players
            let specificTier = null; // Tier for the specifically filtered player/role
            const tierOrder = this._tierOrderValue; // Numerical tier values for comparison
            let lookupKey = null; // The key (player/role) to prioritize for tier display

            // Determine the lookupKey based on filters (now mutually exclusive):
            if (currentFilter !== 'all' && currentFilter !== 'pool') {
                lookupKey = currentFilter;
            } else if (roleFilter !== 'all') {
                lookupKey = roleFilter;
            }

            // Iterate through each player (role) in the team pool
            for (const playerRole in this.teamPool) {
                // Check if the current player has this champion in their pool
                if (this.teamPool[playerRole]?.[championName]) {
                    isInPool = true; // Mark as in pool
                    players.push(playerRole); // Add player to the list
                    const currentTier = this.teamPool[playerRole][championName]?.toUpperCase(); // Get tier (uppercase)

                    // Update highest tier if this player's tier is higher
                    if (currentTier && (!highestTier || (tierOrder[currentTier] ?? 0) > (tierOrder[highestTier] ?? 0))) {
                        highestTier = currentTier;
                    }

                    // If this player is the one we're specifically looking for (lookupKey), store their tier
                    if (playerRole === lookupKey) {
                        specificTier = currentTier;
                    }
                }
            }

            // Determine the final tier to display and its CSS class
            let displayTier = null;
            let tierClass = 'tier-DEFAULT'; // Default CSS class
            if (isInPool) {
                // If a specific player/role was filtered (lookupKey exists) and we found their tier, use it.
                if (lookupKey && specificTier) {
                    displayTier = specificTier;
                } else {
                    // Otherwise (no specific filter or tier not found for the specific filter),
                    // display the highest tier found among all players who have the champ.
                    displayTier = highestTier;
                }
                // Set the CSS class based on the determined display tier
                if (displayTier) {
                    tierClass = `tier-${displayTier}`;
                }
            }

            // Return the collected information
            return { isInPool, tier: displayTier, players, tierClass };
         },

         // Gets the URL for a role icon based on role or player name.
         getRoleIconUrl(roleOrPlayerName) {
             if (!roleOrPlayerName) return "https://placehold.co/16x16/cccccc/777777?text=?"; // Placeholder
             const nameLower = roleOrPlayerName.toLowerCase();
             // Standard role icon URLs
             const urls = {
                 top: "https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-clash/global/default/assets/images/position-selector/positions/icon-position-top-blue-hover.png",
                 jungle: "https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-clash/global/default/assets/images/position-selector/positions/icon-position-jungle-blue-hover.png",
                 mid: "https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-clash/global/default/assets/images/position-selector/positions/icon-position-middle-blue-hover.png",
                 bot: "https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-clash/global/default/assets/images/position-selector/positions/icon-position-bottom-blue-hover.png",
                 support: "https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-clash/global/default/assets/images/position-selector/positions/icon-position-utility-blue-hover.png",
                 unknown: "https://placehold.co/16x16/cccccc/777777?text=?" // Placeholder for unknown
             };
             // Direct match for role names
             if (urls[nameLower]) return urls[nameLower];
             // Fallback checks for player names containing role keywords
             if (nameLower.includes('top')) return urls.top;
             if (nameLower.includes('jg') || nameLower.includes('jng') || nameLower.includes('jungle')) return urls.jungle;
             if (nameLower.includes('mid')) return urls.mid;
             if (nameLower.includes('bot') || nameLower.includes('adc')) return urls.bot;
             if (nameLower.includes('sup') || nameLower.includes('support')) return urls.support;
             // Default to unknown if no match
             return urls.unknown;
         },

         // Gets the Data Dragon URL for a champion icon.
         getChampionIconUrl(championName, context = 'grid') {
            // Placeholder URLs for different contexts (sizes)
             const placeholderUrls = {
                 grid: "https://placehold.co/64x64/374151/9ca3af?text=?",        // Champion Pool Grid
                 pick: "https://placehold.co/60x60/374151/9ca3af?text=?",        // Draft Tracker/Creator Pick Slot
                 ban: "https://placehold.co/38x38/374151/9ca3af?text=?",         // Draft Tracker/Creator Ban Slot
                 list: "https://placehold.co/22x22/374151/9ca3af?text=?",        // Footer Lists / Modal Suggestions
                 'creator-pool': "https://placehold.co/56x56/374151/9ca3af?text=?" // Draft Creator Pool Card
             };
            const placeholderUrl = placeholderUrls[context] || placeholderUrls.grid; // Use grid placeholder as default
            // Return placeholder if champion name or data is missing
            if (!championName || !Array.isArray(this.allChampions) || this.allChampions.length === 0) return placeholderUrl;
            // Find champion data (case-insensitive)
            const champData = this.allChampions.find(champ => champ?.name?.toLowerCase() === championName.toLowerCase());
            // Construct Data Dragon URL if image name exists
            if (champData?.imageName) {
                const patchVersion = "15.8.1"; // TODO: Consider making patch version dynamic or configurable
                return `https://ddragon.leagueoflegends.com/cdn/${patchVersion}/img/champion/${champData.imageName}.png`;
            } else {
                // Log warning and return placeholder if image name is missing
                console.warn(`Could not find image name for champion: ${championName}`);
                return placeholderUrl;
            }
         }
    }
}
