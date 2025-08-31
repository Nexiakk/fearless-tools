// js/components/draftHelper.js

// Make the main Alpine component function globally available
// so x-data="draftHelper()" in index.html can find it.
window.draftHelper = function () {
  return {
    // --- State ---
    allChampions: [],
    teamPool: {},
    opTierChampions: {},
    highlightedChampions: [],
    draftSeries: [], // REPURPOSED: Now holds manually 'unavailable' champion names.
    currentFilter: "all",
    roleFilter: "all",
    searchTerm: "",
    sortOrder: "name",
    alphabetFilter: "all", // NEW: State for the letter filter
    currentView: "pool",
    isLoading: true,
    patchVersion: "14.10.1", // A sensible fallback patch version.
    championPoolView: "compact", // 'grid' or 'compact'
    roleHeaderMap: { Top: "TOP", Jungle: "JUNGLE", Mid: "MID", Bot: "ADC", Support: "SUPP" },
    _saveTimeout: null,
    _unsubscribeFirestore: null,
    _defaultPoolInfo: { isInPool: false, tier: null, players: [], tierClass: "tier-DEFAULT" },
    _tierOrderValue: { OP: 6, S: 5, A: 4, B: 3, C: 2, DEFAULT: 0 },
    _validRoles: new Set(["Top", "Jungle", "Mid", "Bot", "Support"]),
    rolesForPanel: ["Top", "Jungle", "Mid", "Bot", "Support"],
    gamesForPanel: ["G1", "G2", "G3", "G4", "G5"], // For the new grouping

    // --- Grid View Panel Visibility ---
    isLeftPanelVisible: true,
    isRightPanelVisible: true,

    // --- State for Interactive Unavailable Panel ---
    unavailablePanelState: {
      Top: Array(10).fill(null),
      Jungle: Array(10).fill(null),
      Mid: Array(10).fill(null),
      Bot: Array(10).fill(null),
      Support: Array(10).fill(null),
    },
    selectedForPlacement: null, // Holds the name of the champion selected from the holding area
    selectedChampionFromPanel: null, // Holds { championName, role, index } for moving placed champions

    // --- Headless UI Modal State ---
    isSettingsOpen: false,
    settingsTab: "pool", // 'pool' or 'drafting'
    settings: {
      pool: {
        showPlayerTier: false,
        showRoleBadges: true, // Separate setting for role/player badges
        groupByGames: false, // New setting
        frozenChampions: true, // NEW: Setting for frozen champions
      },
      drafting: {
        // Future drafting-specific settings can go here
      },
    },
    confirmationModal: {
      isOpen: false,
      message: "",
      confirmAction: null,
      isDanger: false,
    },

    // --- Draft Creator State ---
    draftCreatorRoleFilter: "all",
    draftCreatorSearchTerm: "",
    currentDraft: {
      id: null,
      name: "New Draft",
      bluePicks: Array(5)
        .fill(null)
        .map(() => ({ champion: null, notes: "" })),
      blueBans: Array(5)
        .fill(null)
        .map(() => ({ champion: null, notes: "" })),
      redPicks: Array(5)
        .fill(null)
        .map(() => ({ champion: null, notes: "" })),
      redBans: Array(5)
        .fill(null)
        .map(() => ({ champion: null, notes: "" })),
      generalNotes: "",
      createdAt: null,
    },
    savedDrafts: [],
    isLoadingSavedDrafts: false,
    selectedChampionForPlacement: null,
    selectedChampionSource: null,
    selectedTargetSlot: null,
    notesModal: { isOpen: false, side: null, type: null, index: null, currentNote: "", title: "" },

    // --- Computed Properties ---

    get sortedHighlightedChampions() {
      return [...this.highlightedChampions].sort();
    },

    get unavailableChampions() {
      return new Set(this.draftSeries);
    },

    get sortedUnavailableChampions() {
      return Array.from(this.unavailableChampions).sort();
    },

    // Champions that are marked 'unavailable' but not yet placed in the panel grid.
    get unplacedChampions() {
      const placedChamps = new Set(
        Object.values(this.unavailablePanelState)
          .flat()
          .filter((c) => c !== null)
      );
      return this.draftSeries.filter((champ) => !placedChamps.has(champ));
    },

    get unavailableChampionsByRole() {
      const grouped = { Top: [], Jungle: [], Mid: [], Bot: [], Support: [], Unknown: [] };
      const validRoles = this._validRoles;
      this.unavailableChampions.forEach((championName) => {
        let assignedRole = "Unknown";
        const teamRoles = Object.keys(this.teamPool).filter((role) => this.teamPool[role]?.[championName]);
        const teamRoleCount = teamRoles.length;
        const champData = this.allChampions.find((c) => c.name === championName);
        const mainRole = champData?.mainRole;

        if (teamRoleCount === 1) {
          assignedRole = teamRoles[0];
        } else if (teamRoleCount > 1) {
          if (mainRole && validRoles.has(mainRole)) {
            assignedRole = mainRole;
          } else {
            assignedRole = teamRoles[0] || "Unknown";
          }
        } else {
          if (mainRole && validRoles.has(mainRole)) {
            assignedRole = mainRole;
          } else {
            assignedRole = champData?.roles?.find((r) => validRoles.has(r)) || "Unknown";
          }
        }
        if (!grouped[assignedRole]) {
          assignedRole = "Unknown";
        }
        grouped[assignedRole].push(championName);
      });
      Object.values(grouped).forEach((arr) => arr.sort());
      return grouped;
    },

    get filteredChampions() {
      if (!this.allChampions || this.allChampions.length === 0) return [];
      const normalizeString = (str) => str.toLowerCase().replace(/[^a-z0-9]/gi, "");
      let processedChampions = this.allChampions.map((champ) => ({
        ...champ,
        poolInfo: this.getChampionPoolInfo(champ.name, this.currentFilter, this.roleFilter),
        isChampUnavailable: this.isUnavailable(champ.name),
      }));
      if (this.currentFilter === "pool") {
        processedChampions = processedChampions.filter((c) => c.poolInfo.isInPool);
      } else if (this.currentFilter !== "all") {
        processedChampions = processedChampions.filter((c) => c.poolInfo.players.includes(this.currentFilter));
      }
      if (this.roleFilter !== "all") {
        processedChampions = processedChampions.filter((c) => Array.isArray(c.roles) && c.roles.includes(this.roleFilter));
      }
      if (this.searchTerm.trim() !== "") {
        const normalizedSearch = normalizeString(this.searchTerm.trim());
        processedChampions = processedChampions.filter((c) => normalizeString(c.name).includes(normalizedSearch));
      }
      processedChampions.sort((a, b) => {
        if (this.sortOrder === "tier") {
          const tierA = a.poolInfo?.tier || "DEFAULT";
          const tierB = b.poolInfo?.tier || "DEFAULT";
          const valueA = this._tierOrderValue[tierA] ?? 0;
          const valueB = this._tierOrderValue[tierB] ?? 0;
          if (valueA !== valueB) return valueB - valueA;
          return a.name.localeCompare(b.name);
        } else {
          return a.name.localeCompare(b.name);
        }
      });
      return processedChampions;
    },

    get championsByRoleForCompactView() {
      if (this.settings.pool.frozenChampions) {
        const grouped = {
          Top: { sticky: [], scrollable: [] },
          Jungle: { sticky: [], scrollable: [] },
          Mid: { sticky: [], scrollable: [] },
          Bot: { sticky: [], scrollable: [] },
          Support: { sticky: [], scrollable: [] },
        };

        this.allChampions.forEach((champ) => {
          if (Array.isArray(champ.roles)) {
            champ.roles.forEach((role) => {
              if (grouped.hasOwnProperty(role)) {
                const isUnavailable = this.isUnavailable(champ.name);
                const isOp = this.isOpForRole(champ.name, role);
                const isHighlighted = this.isHighlighted(champ.name);

                if (isUnavailable || isOp || isHighlighted) {
                  grouped[role].sticky.push(champ);
                } else {
                  grouped[role].scrollable.push(champ);
                }
              }
            });
          }
        });

        for (const role in grouped) {
          grouped[role].sticky.sort((a, b) => {
            const getPriority = (champ) => {
              if (this.isUnavailable(champ.name)) return 3;
              if (this.isOpForRole(champ.name, role)) return 2;
              if (this.isHighlighted(champ.name)) return 1;
              return 0;
            };
            const priorityA = getPriority(a);
            const priorityB = getPriority(b);
            if (priorityA !== priorityB) return priorityB - priorityA;
            return a.name.localeCompare(b.name);
          });
          grouped[role].scrollable.sort((a, b) => a.name.localeCompare(b.name));
        }
        return grouped;
      } else {
        const grouped = { Top: [], Jungle: [], Mid: [], Bot: [], Support: [] };

        this.allChampions.forEach((champ) => {
          if (Array.isArray(champ.roles)) {
            champ.roles.forEach((role) => {
              if (grouped.hasOwnProperty(role)) {
                grouped[role].push(champ);
              }
            });
          }
        });

        for (const role in grouped) {
          grouped[role].sort((a, b) => {
            const getPriority = (champ) => {
              if (this.isUnavailable(champ.name)) return 3;
              if (this.isOpForRole(champ.name, role)) return 2;
              if (this.isHighlighted(champ.name)) return 1;
              return 0;
            };
            const priorityA = getPriority(a);
            const priorityB = getPriority(b);
            if (priorityA !== priorityB) return priorityB - priorityA;
            return a.name.localeCompare(b.name);
          });
        }
        return grouped;
      }
    },

    get draftCreatorFilteredChampions() {
      if (!this.allChampions || this.allChampions.length === 0) return [];
      const normalizeString = (str) => str.toLowerCase().replace(/[^a-z0-9]/gi, "");
      let champs = [...this.allChampions];
      if (this.draftCreatorRoleFilter !== "all") {
        champs = champs.filter((c) => Array.isArray(c.roles) && c.roles.includes(this.draftCreatorRoleFilter));
      }
      if (this.draftCreatorSearchTerm.trim() !== "") {
        const normalizedSearch = normalizeString(this.draftCreatorSearchTerm.trim());
        champs = champs.filter((c) => normalizeString(c.name).includes(normalizedSearch));
      }
      return champs.sort((a, b) => a.name.localeCompare(b.name));
    },

    // --- Initialization ---
    async init() {
      console.log("Alpine component initializing...");
      this.isLoading = true;

      // Fetch the latest patch version first.
      try {
        const response = await fetch("https://ddragon.leagueoflegends.com/api/versions.json");
        if (!response.ok) throw new Error("Network response was not ok");
        const versions = await response.json();
        if (versions && versions.length > 0) {
          this.patchVersion = versions[0];
          console.log(`Successfully fetched latest patch version: ${this.patchVersion}`);
        }
      } catch (error) {
        console.error("Failed to fetch latest patch version, using fallback:", error);
        // Fallback version is already set in the state.
      }

      // Load settings from localStorage
      const savedSettings = localStorage.getItem("fearlessSettings");
      if (savedSettings) {
        // Merge saved settings with defaults to avoid errors if new settings are added
        const parsedSettings = JSON.parse(savedSettings);
        this.settings.pool = { ...this.settings.pool, ...(parsedSettings.pool || {}) };
        this.settings.drafting = { ...this.settings.drafting, ...(parsedSettings.drafting || {}) };
      }

      this.allChampions = window.allLolChampions || [];
      this.teamPool = window.teamTierList || {};
      this.opTierChampions = window.opTierChampions || {};

      const fbFetch = window.fetchDraftDataFromFirestore;
      const fbSave = window.saveDraftDataToFirestore;
      const db = window.db;
      const fbFetchSavedDrafts = window.fetchSavedDraftsFromFirestore;

      if (typeof fbFetch === "function") {
        try {
          const loadedData = await fbFetch();
          this.highlightedChampions = loadedData.highlightedChampions || [];
          this.draftSeries = loadedData.draftSeries || [];
          // Load panel state, ensuring it has the correct structure
          const defaultPanelState = { Top: Array(10).fill(null), Jungle: Array(10).fill(null), Mid: Array(10).fill(null), Bot: Array(10).fill(null), Support: Array(10).fill(null) };
          this.unavailablePanelState = loadedData.unavailablePanelState || defaultPanelState;
          for (const role of this.rolesForPanel) {
            if (!this.unavailablePanelState[role] || this.unavailablePanelState[role].length !== 10) {
              this.unavailablePanelState[role] = Array(10).fill(null);
            }
          }
        } catch (error) {
          console.error("Error during initial Firestore fetch:", error);
          this.highlightedChampions = [];
          this.draftSeries = [];
          this.unavailablePanelState = { Top: Array(10).fill(null), Jungle: Array(10).fill(null), Mid: Array(10).fill(null), Bot: Array(10).fill(null), Support: Array(10).fill(null) };
        }
      } else {
        console.error("fetchDraftDataFromFirestore function not found globally.");
      }

      if (typeof fbFetchSavedDrafts === "function") {
        this.isLoadingSavedDrafts = true;
        try {
          this.savedDrafts = await fbFetchSavedDrafts();
        } catch (error) {
          console.error("Error fetching saved drafts:", error);
        } finally {
          this.isLoadingSavedDrafts = false;
        }
      }

      this.isLoading = false;
      console.log("Draft Helper Initialized");

      const debouncedSave = () => {
        clearTimeout(this._saveTimeout);
        this._saveTimeout = setTimeout(() => {
          if (typeof fbSave === "function") {
            const dataToSave = {
              highlightedChampions: JSON.parse(JSON.stringify(this.highlightedChampions)),
              draftSeries: JSON.parse(JSON.stringify(this.draftSeries)),
              unavailablePanelState: JSON.parse(JSON.stringify(this.unavailablePanelState)), // Save panel state
            };
            fbSave(dataToSave);
          }
        }, 1500);
      };

      this.$watch("highlightedChampions", debouncedSave);
      this.$watch("draftSeries", debouncedSave);
      this.$watch("unavailablePanelState", debouncedSave, { deep: true }); // Watch panel state
      this.$watch(
        "settings",
        () => {
          localStorage.setItem("fearlessSettings", JSON.stringify(this.settings));
        },
        { deep: true }
      );

      if (db) {
        const DRAFT_COLLECTION = "drafts";
        const DRAFT_DOC_ID = "current_draft";
        const docRef = db.collection(DRAFT_COLLECTION).doc(DRAFT_DOC_ID);

        this._unsubscribeFirestore = docRef.onSnapshot(
          (doc) => {
            if (doc.exists) {
              const data = doc.data();
              const newDraftSeries = Array.isArray(data.draftSeries) ? data.draftSeries : [];
              const newhighlightedChampions = Array.isArray(data.highlightedChampions) ? data.highlightedChampions : [];
              const newPanelState = data.unavailablePanelState || { Top: Array(10).fill(null), Jungle: Array(10).fill(null), Mid: Array(10).fill(null), Bot: Array(10).fill(null), Support: Array(10).fill(null) };

              if (JSON.stringify(this.draftSeries) !== JSON.stringify(newDraftSeries)) {
                this.draftSeries = newDraftSeries;
              }
              if (JSON.stringify(this.highlightedChampions) !== JSON.stringify(newhighlightedChampions)) {
                this.highlightedChampions = newhighlightedChampions;
              }
              if (JSON.stringify(this.unavailablePanelState) !== JSON.stringify(newPanelState)) {
                this.unavailablePanelState = newPanelState;
              }
            } else {
              this.draftSeries = [];
              this.highlightedChampions = [];
              this.unavailablePanelState = { Top: Array(10).fill(null), Jungle: Array(10).fill(null), Mid: Array(10).fill(null), Bot: Array(10).fill(null), Support: Array(10).fill(null) };
            }
          },
          (error) => {
            console.error("Error listening to draft updates:", error);
          }
        );
      }
    },

    destroy() {
      if (this._unsubscribeFirestore) {
        this._unsubscribeFirestore();
      }
      clearTimeout(this._saveTimeout);
    },

    // --- Champion Pool View Methods ---
    isOpForRole(championName, role) {
      return this.opTierChampions[championName]?.includes(role);
    },

    // NEW: Method for the alphabet filter
    setAlphabetFilter(letter) {
      if (this.alphabetFilter === letter) {
        this.alphabetFilter = "all"; // Toggle off if same letter is clicked
      } else {
        this.alphabetFilter = letter;
      }
    },

    setSortOrder(order) {
      this.sortOrder = order;
    },
    setFilter(value, type) {
      if (type === "player") {
        this.currentFilter = this.currentFilter === value ? "all" : value;
        this.roleFilter = "all";
      } else if (type === "role") {
        this.roleFilter = this.roleFilter === value ? "all" : value;
        this.currentFilter = "all";
      }
    },
    isUnavailable(championName) {
      return championName ? this.unavailableChampions.has(championName) : false;
    },
    isHighlighted(championName) {
      return championName ? this.highlightedChampions.includes(championName) : false;
    },
    togglePick(championName) {
      if (!championName) return;

      const champion = this.allChampions.find((c) => c.name === championName);
      if (!champion) return;

      if (this.isHighlighted(championName)) {
        this.highlightedChampions = this.highlightedChampions.filter((name) => name !== championName);
      }

      const index = this.draftSeries.indexOf(championName);
      if (index === -1) {
        this.draftSeries = [...this.draftSeries, championName];
        this.placeChampionInPanel(champion);
      } else {
        this.draftSeries = this.draftSeries.filter((name) => name !== championName);
        this.removeChampionFromPanel(championName);
      }
    },
    placeChampionInPanel(champion) {
      // Ensure we only consider valid roles associated with the champion
      const championRoles = [champion.mainRole, ...champion.roles.filter((r) => r !== champion.mainRole)];
      const validChampionRoles = championRoles.filter((role) => this._validRoles.has(role));
      const placementOrder = [0, 5, 1, 6, 2, 7, 3, 8, 4, 9]; // New placement order

      for (const role of validChampionRoles) {
        if (this.unavailablePanelState[role]) {
          for (const i of placementOrder) {
            // Iterate using the new order
            if (this.unavailablePanelState[role][i] === null) {
              this.unavailablePanelState[role][i] = champion.name;
              return; // Champion placed, exit function
            }
          }
        }
      }
      // If the function reaches this point, no slot was found.
      // The champion will remain in draftSeries but not in unavailablePanelState,
      // so it will appear in the unplacedChampions (holding area).
    },
    removeChampionFromPanel(championName) {
      for (const role in this.unavailablePanelState) {
        const index = this.unavailablePanelState[role].indexOf(championName);
        if (index !== -1) {
          this.unavailablePanelState[role][index] = null;
          return;
        }
      }
    },
    toggleHighlight(championName) {
      if (!championName || this.isUnavailable(championName)) return;
      const index = this.highlightedChampions.indexOf(championName);
      if (index === -1) {
        this.highlightedChampions = [...this.highlightedChampions, championName];
      } else {
        this.highlightedChampions = this.highlightedChampions.filter((name) => name !== championName);
      }
    },
    resetDraftSeriesAction() {
      this.draftSeries = [];
      this.unavailablePanelState = { Top: Array(10).fill(null), Jungle: Array(10).fill(null), Mid: Array(10).fill(null), Bot: Array(10).fill(null), Support: Array(10).fill(null) };
      this.searchTerm = "";
      const fbSave = window.saveDraftDataToFirestore;
      if (typeof fbSave === "function") {
        fbSave({ highlightedChampions: this.highlightedChampions, draftSeries: [], unavailablePanelState: this.unavailablePanelState });
      }
    },
    resetMarkedPicksAction() {
      if (this.highlightedChampions.length > 0) {
        this.highlightedChampions = [];
        const fbSave = window.saveDraftDataToFirestore;
        if (typeof fbSave === "function") {
          fbSave({ highlightedChampions: [], draftSeries: this.draftSeries, unavailablePanelState: this.unavailablePanelState });
        }
      }
    },

    // --- Methods for Interactive Panel ---
    selectForPlacement(championName) {
      this.selectedChampionFromPanel = null; // Clear panel selection when selecting from holding area
      if (this.selectedForPlacement === championName) {
        this.selectedForPlacement = null; // Deselect if clicking the same one
      } else {
        this.selectedForPlacement = championName;
      }
    },

    revertUnavailableChampion(championName) {
      if (!championName) return;

      // Remove the champion from the unavailable list
      this.draftSeries = this.draftSeries.filter((name) => name !== championName);

      // If the reverted champion was the one selected for placement, clear the selection
      if (this.selectedForPlacement === championName) {
        this.selectedForPlacement = null;
      }
    },

    handlePanelSlotClick(role, index) {
      const championInClickedSlot = this.unavailablePanelState[role][index];
      const aChampionIsSelectedForPlacement = this.selectedForPlacement !== null;
      const aChampionIsSelectedFromPanel = this.selectedChampionFromPanel !== null;

      if (aChampionIsSelectedForPlacement) {
        // A champion from the holding area is selected
        if (!championInClickedSlot) {
          // and the clicked slot is empty
          let newPanelState = JSON.parse(JSON.stringify(this.unavailablePanelState));
          newPanelState[role][index] = this.selectedForPlacement;
          this.unavailablePanelState = newPanelState;
          this.selectedForPlacement = null; // Deselect after placing
        }
        // If the target slot is not empty, do nothing to prevent overwriting.
        return;
      }

      if (aChampionIsSelectedFromPanel) {
        // A champion is selected from the panel for moving/swapping
        const sourceRole = this.selectedChampionFromPanel.role;
        const sourceIndex = this.selectedChampionFromPanel.index;
        const sourceChampion = this.selectedChampionFromPanel.championName;

        if (sourceRole === role && sourceIndex === index) {
          // Clicked the same slot again to deselect
          this.selectedChampionFromPanel = null;
          return;
        }

        // Perform the move/swap
        let newPanelState = JSON.parse(JSON.stringify(this.unavailablePanelState));
        newPanelState[sourceRole][sourceIndex] = championInClickedSlot; // championInClickedSlot can be null (move) or a champion name (swap)
        newPanelState[role][index] = sourceChampion;
        this.unavailablePanelState = newPanelState;
        this.selectedChampionFromPanel = null; // Deselect after action
        return;
      }

      // If nothing is selected yet
      if (!aChampionIsSelectedForPlacement && !aChampionIsSelectedFromPanel) {
        if (championInClickedSlot) {
          // And a slot with a champion is clicked, select it
          this.selectedChampionFromPanel = { championName: championInClickedSlot, role: role, index: index };
        }
      }
    },
    // Allows removing a champion from a slot by right-clicking it
    clearUnavailableSlot(role, slotIndex) {
      if (this.unavailablePanelState[role][slotIndex] !== null) {
        let newPanelState = JSON.parse(JSON.stringify(this.unavailablePanelState));
        newPanelState[role][slotIndex] = null;
        this.unavailablePanelState = newPanelState;
      }
    },

    // --- Headless UI Modal Methods ---
    openConfirmationModal({ message, confirmAction, isDanger = false }) {
      this.confirmationModal.message = message;
      this.confirmationModal.confirmAction = confirmAction;
      this.confirmationModal.isDanger = isDanger;
      this.confirmationModal.isOpen = true;
    },
    closeConfirmationModal() {
      this.confirmationModal.isOpen = false;
      // Reset after a short delay to allow for transitions
      setTimeout(() => {
        this.confirmationModal.message = "";
        this.confirmationModal.confirmAction = null;
        this.confirmationModal.isDanger = false;
      }, 200);
    },
    confirmAction() {
      if (typeof this.confirmationModal.confirmAction === "function") {
        this.confirmationModal.confirmAction();
      }
      this.closeConfirmationModal();
    },

    // --- Draft Creator Methods ---
    setDraftCreatorRoleFilter(role) {
      this.draftCreatorRoleFilter = this.draftCreatorRoleFilter === role ? "all" : role;
    },
    isChampionPlacedInCurrentDraft(championName) {
      if (!championName) return false;
      const draft = this.currentDraft;
      const checkSlot = (slot) => slot && slot.champion === championName;
      return draft.bluePicks.some(checkSlot) || draft.blueBans.some(checkSlot) || draft.redPicks.some(checkSlot) || draft.redBans.some(checkSlot);
    },
    _placeChampionInSlot(championName, targetSide, targetType, targetIndex) {
      const targetSlotRef = this.currentDraft[`${targetSide}${targetType.charAt(0).toUpperCase() + targetType.slice(1)}`][targetIndex];
      ["blue", "red"].forEach((s) => {
        ["picks", "bans"].forEach((t) => {
          this.currentDraft[`${s}${t.charAt(0).toUpperCase() + t.slice(1)}`].forEach((slot, i) => {
            if (slot.champion === championName) {
              if (!(s === targetSide && t === targetType && i === targetIndex)) {
                slot.champion = null;
                slot.notes = "";
              }
            }
          });
        });
      });
      targetSlotRef.champion = championName;
      targetSlotRef.notes = "";
    },
    selectChampionForPlacement(championName) {
      if (!championName) return;
      if (this.selectedTargetSlot) {
        const { side, type, index } = this.selectedTargetSlot;
        const targetSlotRef = this.currentDraft[`${side}${type.charAt(0).toUpperCase() + type.slice(1)}`][index];
        if (targetSlotRef.champion === championName) return;
        this._placeChampionInSlot(championName, side, type, index);
        this.selectedTargetSlot = null;
        this.selectedChampionForPlacement = null;
        this.selectedChampionSource = null;
        return;
      }
      if (this.selectedChampionForPlacement === championName) {
        this.selectedChampionForPlacement = null;
        return;
      }
      if (this.selectedChampionSource) this.selectedChampionSource = null;

      if (this.isChampionPlacedInCurrentDraft(championName)) {
        let foundSource = null;
        ["blue", "red"].forEach((side) => {
          ["picks", "bans"].forEach((type) => {
            this.currentDraft[`${side}${type.charAt(0).toUpperCase() + type.slice(1)}`].forEach((slot, index) => {
              if (slot.champion === championName) {
                foundSource = { side, type, index };
              }
            });
          });
        });
        if (foundSource) {
          this.selectedChampionSource = foundSource;
          this.selectedChampionForPlacement = null;
          this.selectedTargetSlot = null;
        } else {
          this.selectedChampionForPlacement = null;
          this.selectedChampionSource = null;
          this.selectedTargetSlot = null;
        }
      } else {
        this.selectedChampionForPlacement = championName;
        this.selectedChampionSource = null;
        this.selectedTargetSlot = null;
      }
    },
    handleSlotClick(targetSide, targetType, targetIndex) {
      const targetSlotRef = this.currentDraft[`${targetSide}${targetType.charAt(0).toUpperCase() + targetType.slice(1)}`][targetIndex];
      const currentTargetChampion = targetSlotRef.champion;
      if (this.selectedChampionForPlacement) {
        const champToPlace = this.selectedChampionForPlacement;
        if (currentTargetChampion === champToPlace) {
          this.selectedChampionForPlacement = null;
          return;
        }
        this._placeChampionInSlot(champToPlace, targetSide, targetType, targetIndex);
        this.selectedChampionForPlacement = null;
        this.selectedTargetSlot = null;
      } else if (this.selectedChampionSource) {
        const sourceSlotRef = this.currentDraft[`${this.selectedChampionSource.side}${this.selectedChampionSource.type.charAt(0).toUpperCase() + this.selectedChampionSource.type.slice(1)}`][this.selectedChampionSource.index];
        const champToMove = sourceSlotRef.champion;
        const notesToMove = sourceSlotRef.notes;
        if (this.selectedChampionSource.side === targetSide && this.selectedChampionSource.type === targetType && this.selectedChampionSource.index === targetIndex) {
          this.selectedChampionSource = null;
          return;
        }
        if (currentTargetChampion && currentTargetChampion !== champToMove) {
          // Swap
          const targetNotes = targetSlotRef.notes;
          sourceSlotRef.champion = currentTargetChampion;
          sourceSlotRef.notes = targetNotes;
          targetSlotRef.champion = champToMove;
          targetSlotRef.notes = notesToMove;
        } else {
          // Move to empty slot
          targetSlotRef.champion = champToMove;
          targetSlotRef.notes = notesToMove;
          sourceSlotRef.champion = null;
          sourceSlotRef.notes = "";
        }
        this.selectedChampionSource = null;
        this.selectedTargetSlot = null;
      } else {
        if (currentTargetChampion) {
          // Select filled slot for moving
          this.selectedChampionSource = { side: targetSide, type: targetType, index: targetIndex };
          this.selectedTargetSlot = null;
        } else {
          // Select empty slot for targeting
          if (this.selectedTargetSlot && this.selectedTargetSlot.side === targetSide && this.selectedTargetSlot.type === targetType && this.selectedTargetSlot.index === targetIndex) {
            this.selectedTargetSlot = null;
          } else {
            this.selectedTargetSlot = { side: targetSide, type: targetType, index: targetIndex };
            this.selectedChampionSource = null;
          }
        }
      }
    },
    clearCreatorSlot(side, type, index) {
      const slotRef = this.currentDraft[`${side}${type.charAt(0).toUpperCase() + type.slice(1)}`]?.[index];
      if (!slotRef) {
        console.error("Invalid target for clearCreatorSlot:", side, type, index);
        return;
      }
      if (slotRef.champion) {
        slotRef.champion = null;
        slotRef.notes = "";
      }
      if (this.selectedChampionForPlacement) this.selectedChampionForPlacement = null;
      if (this.selectedChampionSource) this.selectedChampionSource = null;
      if (this.selectedTargetSlot) this.selectedTargetSlot = null;
    },
    resetCurrentDraft() {
      this.currentDraft = {
        id: null,
        name: "New Draft",
        bluePicks: Array(5)
          .fill(null)
          .map(() => ({ champion: null, notes: "" })),
        blueBans: Array(5)
          .fill(null)
          .map(() => ({ champion: null, notes: "" })),
        redPicks: Array(5)
          .fill(null)
          .map(() => ({ champion: null, notes: "" })),
        redBans: Array(5)
          .fill(null)
          .map(() => ({ champion: null, notes: "" })),
        generalNotes: "",
        createdAt: null,
      };
      this.selectedChampionForPlacement = null;
      this.selectedChampionSource = null;
      this.selectedTargetSlot = null;
      this.draftCreatorSearchTerm = "";
      this.draftCreatorRoleFilter = "all";
    },
    async saveCurrentDraft() {
      const fbSaveDraft = window.saveDraftToCreatorCollection;
      if (typeof fbSaveDraft !== "function") {
        alert("Error: Save function not available.");
        return;
      }
      if (!this.currentDraft.id || this.currentDraft.name === "New Draft" || this.currentDraft.name === "Unnamed Draft") {
        const draftName = prompt("Enter a name for this draft:", this.currentDraft.name !== "New Draft" ? this.currentDraft.name : "");
        if (draftName === null) return;
        this.currentDraft.name = draftName.trim() || "Unnamed Draft";
      }
      try {
        const draftToSave = JSON.parse(JSON.stringify(this.currentDraft));
        if (!(draftToSave.createdAt && typeof draftToSave.createdAt === "object")) {
          delete draftToSave.createdAt;
        }
        const savedDraft = await fbSaveDraft(draftToSave);
        this.currentDraft.id = savedDraft.id;
        this.currentDraft.createdAt = savedDraft.createdAt;
        await this.refreshSavedDrafts();
        alert(`Draft "${this.currentDraft.name}" saved successfully!`);
      } catch (error) {
        console.error("Error saving draft:", error);
        alert("Failed to save draft. See console for details.");
      }
    },
    async refreshSavedDrafts() {
      const fbFetchSavedDrafts = window.fetchSavedDraftsFromFirestore;
      if (typeof fbFetchSavedDrafts === "function") {
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
    async loadSavedDraft(draftId) {
      const fbLoadDraft = window.loadSpecificDraftFromFirestore;
      if (typeof fbLoadDraft !== "function") {
        alert("Error: Load function not available.");
        return;
      }
      if (!draftId) return;
      try {
        const loadedData = await fbLoadDraft(draftId);
        if (loadedData) {
          this.currentDraft = {
            id: draftId,
            name: loadedData.name || "Unnamed Draft",
            bluePicks: this.sanitizeDraftArray(loadedData.bluePicks, 5),
            blueBans: this.sanitizeDraftArray(loadedData.blueBans, 5),
            redPicks: this.sanitizeDraftArray(loadedData.redPicks, 5),
            redBans: this.sanitizeDraftArray(loadedData.redBans, 5),
            generalNotes: loadedData.generalNotes || "",
            createdAt: loadedData.createdAt || null,
          };
          this.selectedChampionForPlacement = null;
          this.selectedChampionSource = null;
          this.selectedTargetSlot = null;
          this.draftCreatorSearchTerm = "";
          this.draftCreatorRoleFilter = "all";
        } else {
          alert("Could not find or load the selected draft.");
          this.savedDrafts = this.savedDrafts.filter((d) => d.id !== draftId);
        }
      } catch (error) {
        console.error(`Error loading draft ${draftId}:`, error);
        alert("Failed to load draft. See console for details.");
      }
    },
    sanitizeDraftArray(arr, expectedLength) {
      const defaultSlot = () => ({ champion: null, notes: "" });
      if (!Array.isArray(arr)) {
        return Array(expectedLength).fill(null).map(defaultSlot);
      }
      const sanitized = arr.map((item) => ({ champion: item?.champion || null, notes: item?.notes || "" }));
      while (sanitized.length < expectedLength) {
        sanitized.push(defaultSlot());
      }
      return sanitized.slice(0, expectedLength);
    },
    async deleteSavedDraft(draftId) {
      const fbDeleteDraft = window.deleteDraftFromCreatorCollection;
      if (typeof fbDeleteDraft !== "function") {
        alert("Error: Delete function not available.");
        return;
      }
      if (!draftId) return;

      try {
        const draftToDelete = this.savedDrafts.find((d) => d.id === draftId);
        const draftName = draftToDelete ? draftToDelete.name : "this draft";
        await fbDeleteDraft(draftId);
        this.savedDrafts = this.savedDrafts.filter((d) => d.id !== draftId);
        if (this.currentDraft.id === draftId) {
          this.resetCurrentDraft();
        }
        alert(`Draft "${draftName}" deleted successfully.`);
      } catch (error) {
        console.error(`Error deleting draft ${draftId}:`, error);
        alert("Failed to delete draft. See console for details.");
      }
    },
    toggleNotesVisibility(side, type, index) {
      this.notesModal.isOpen = true;
      this.notesModal.side = side;
      this.notesModal.type = type;
      this.notesModal.index = index;
      let noteSource = "";
      let title = "Edit Notes";
      try {
        if (side === "general") {
          noteSource = this.currentDraft.generalNotes;
          title = "Edit General Draft Notes";
        } else {
          const slotRef = this.currentDraft[`${side}${type.charAt(0).toUpperCase() + type.slice(1)}`]?.[index];
          if (slotRef) {
            noteSource = slotRef.notes;
            const champName = slotRef.champion ? ` for ${slotRef.champion}` : "";
            const slotLabel = `${side.charAt(0).toUpperCase()}${type.charAt(0).toUpperCase()}${index + 1}`;
            title = `Edit Notes${champName} (${slotLabel})`;
          } else {
            throw new Error("Invalid slot reference");
          }
        }
      } catch (error) {
        this.notesModal.isOpen = false;
        alert("Could not open notes for this slot.");
        return;
      }
      this.notesModal.currentNote = noteSource;
      this.notesModal.title = title;
      this.$nextTick(() => {
        this.$refs.notesTextarea?.focus();
      });
    },
    closeNotesModal() {
      this.notesModal.isOpen = false;
      this.notesModal.side = null;
      this.notesModal.type = null;
      this.notesModal.index = null;
      this.notesModal.currentNote = "";
      this.notesModal.title = "";
    },
    saveNotesAndCloseModal() {
      const { side, type, index, currentNote } = this.notesModal;
      try {
        if (side === "general") {
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
      } catch (error) {
        alert("Failed to save notes.");
      } finally {
        this.closeNotesModal();
      }
    },
    getChampionPoolInfo(championName, currentFilter = "all", roleFilter = "all") {
      const defaultInfo = { ...this._defaultPoolInfo };
      if (!championName || !this.teamPool || typeof this.teamPool !== "object") {
        return defaultInfo;
      }

      if (this.opTierChampions[championName]) {
        return { isInPool: true, tier: "OP", players: [], tierClass: "tier-OP" };
      }

      let players = [];
      let isInPool = false;
      let highestTier = null;
      let specificTier = null;
      const tierOrder = this._tierOrderValue;
      let lookupKey = null;
      if (currentFilter !== "all" && currentFilter !== "pool") {
        lookupKey = currentFilter;
      } else if (roleFilter !== "all") {
        lookupKey = roleFilter;
      }
      for (const playerRole in this.teamPool) {
        if (this.teamPool[playerRole]?.[championName]) {
          isInPool = true;
          players.push(playerRole);
          const currentTier = this.teamPool[playerRole][championName]?.toUpperCase();
          if (currentTier && (!highestTier || (tierOrder[currentTier] ?? 0) > (tierOrder[highestTier] ?? 0))) {
            highestTier = currentTier;
          }
          if (playerRole === lookupKey) {
            specificTier = currentTier;
          }
        }
      }
      let displayTier = null;
      let tierClass = "tier-DEFAULT";
      if (isInPool) {
        displayTier = lookupKey && specificTier ? specificTier : highestTier;
        if (displayTier) {
          tierClass = `tier-${displayTier}`;
        }
      }
      return { isInPool, tier: displayTier, players, tierClass };
    },
    getRoleIconUrl(roleOrPlayerName) {
      if (!roleOrPlayerName) return "https://placehold.co/16x16/cccccc/777777?text=?";
      const nameLower = roleOrPlayerName.toLowerCase();
      const urls = {
        top: "https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-clash/global/default/assets/images/position-selector/positions/icon-position-top-blue-hover.png",
        jungle: "https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-clash/global/default/assets/images/position-selector/positions/icon-position-jungle-blue-hover.png",
        mid: "https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-clash/global/default/assets/images/position-selector/positions/icon-position-middle-blue-hover.png",
        bot: "https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-clash/global/default/assets/images/position-selector/positions/icon-position-bottom-blue-hover.png",
        support: "https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-clash/global/default/assets/images/position-selector/positions/icon-position-utility-blue-hover.png",
        unknown: "https://placehold.co/16x16/cccccc/777777?text=?",
      };
      if (urls[nameLower]) return urls[nameLower];
      if (nameLower.includes("top")) return urls.top;
      if (nameLower.includes("jg") || nameLower.includes("jng") || nameLower.includes("jungle")) return urls.jungle;
      if (nameLower.includes("mid")) return urls.mid;
      if (nameLower.includes("bot") || nameLower.includes("adc")) return urls.bot;
      if (nameLower.includes("sup") || nameLower.includes("support")) return urls.support;
      return urls.unknown;
    },
    getChampionIconUrl(championName, context = "grid") {
      const placeholderUrls = {
        grid: "https://placehold.co/64x64/374151/9ca3af?text=?",
        pick: "https://placehold.co/60x60/374151/9ca3af?text=?",
        ban: "https://placehold.co/38x38/374151/9ca3af?text=?",
        list: "https://placehold.co/22x22/374151/9ca3af?text=?",
        "creator-pool": "https://placehold.co/56x56/374151/9ca3af?text=?",
        "holding-area": "https://placehold.co/40x40/374151/9ca3af?text=?",
      };
      const placeholderUrl = placeholderUrls[context] || placeholderUrls.grid;
      if (!championName || !Array.isArray(this.allChampions) || this.allChampions.length === 0) return placeholderUrl;
      const champData = this.allChampions.find((champ) => champ?.name?.toLowerCase() === championName.toLowerCase());
      if (champData?.imageName) {
        return `https://ddragon.leagueoflegends.com/cdn/${this.patchVersion}/img/champion/${champData.imageName}.png`;
      } else {
        console.warn(`Could not find image name for champion: ${championName}`);
        return placeholderUrl;
      }
    },
  };
};
